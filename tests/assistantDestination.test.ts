import { describe, test, expect, beforeEach, vi } from 'vitest';

const { ds, sms } = vi.hoisted(() => ({
  ds: {
    findPlaces: vi.fn(),
    placeById: vi.fn(),
    routeWalking: vi.fn(),
  },
  sms: { sendSms: vi.fn(async () => 'sent'), placeCall: vi.fn(), SOS_SMS_PERMISSION_WAIT_MS: 5000 },
}));

vi.mock('../src/core/maps/destinationSearch', async (orig) => {
  const actual = await orig<typeof import('../src/core/maps/destinationSearch')>();
  return { ...actual, ...ds };
});
vi.mock('../src/core/phone', () => sms);
vi.mock('../src/core/ai/voiceOut', () => ({ announce: vi.fn(), resolveLang: () => 'en', speakReply: vi.fn() }));
vi.mock('../src/core/feedback/haptics', () => ({ haptics: { play: vi.fn() } }));
vi.mock('../src/core/feedback/earcons', () => ({ earcon: vi.fn(), loopEarcon: vi.fn(() => () => {}) }));
vi.mock('../src/core/navigation/stickHaptics', () => ({ stickNavCue: vi.fn() }));

const store = new Map<string, string>();
(globalThis as any).localStorage ??= { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };

import { executeAction } from '../src/core/ai/executor';
import { TOOL_BY_NAME } from '../shared/tools';
import { useDevice, initialDevice } from '../src/core/store/device';
import { useSession } from '../src/core/store/session';
import { useLocation } from '../src/core/location/locationService';
import { useNavView } from '../src/core/navigation/navView';
import { stopRealNavigation } from '../src/core/navigation/realNavigator';
import { clearOffer } from '../src/core/ai/navIntent';
import { locationLine, withLocation, wantsLocation, ageText } from '../src/core/location/shareLocation';
import { smsMessage } from '../src/core/safety/sos';

const act = (name: string, type: string, args: Record<string, unknown> = {}) => ({ id: 'c1', name, type, arguments: args });
const hospital = { placeId: 'pl_hosp', name: 'City Hospital', lat: 20.0, lng: 73.78, address: 'MG Road', distanceM: null, openNow: null, primaryType: 'hospital' };
const route = { distanceM: 800, durationS: 600, path: [[20.01, 73.79], [20.0, 73.78]] as [number, number][], steps: [{ instruction: 'Head west', maneuver: null, distanceM: 800, durationS: 600, start: { lat: 20.01, lng: 73.79 }, end: { lat: 20, lng: 73.78 } }] };
const freshFix = () => ({ lat: 20.01, lng: 73.79, accuracyM: 12, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() });

beforeEach(() => {
  vi.clearAllMocks();
  stopRealNavigation('user');
  clearOffer();
  useDevice.setState({ ...initialDevice(), link: 'disconnected', internet: true });
  useLocation.setState({ fix: null, permission: 'granted', status: 'acquiring' });
  useNavView.setState({ active: false });
  ds.findPlaces.mockResolvedValue({ places: [hospital], source: 'server', biased: false });
  ds.routeWalking.mockResolvedValue(route);
});

describe('the assistant can always set a destination', () => {
  test('search and destination tools do not require a GPS fix', () => {
    for (const n of ['search_place', 'find_nearest_place', 'set_destination', 'start_navigation', 'get_current_location']) expect(TOOL_BY_NAME.get(n)!.requires).not.toContain('location');
  });

  test('"Set destination to City Hospital" with no GPS: destination set, directions wait for GPS', async () => {
    const r = await executeAction(act('set_destination', 'navigation.setDestination', { query: 'City Hospital' }));
    expect(r.ok).toBe(true);
    expect(ds.findPlaces).toHaveBeenCalledWith(expect.objectContaining({ query: 'City Hospital', bias: null }));
    expect(r.data).toMatchObject({ directions: 'waiting_for_gps', destination: { name: 'City Hospital' } });
    expect(String((r.data as any).instruction)).toMatch(/start automatically/);
    expect(useNavView.getState()).toMatchObject({ active: true, destination: { name: 'City Hospital' } });
    expect(ds.routeWalking).not.toHaveBeenCalled();
  });

  test('search without GPS still offers a place; yes → start_navigation waits for GPS (no "unavailable")', async () => {
    const s = await executeAction(act('find_nearest_place', 'navigation.findNearestPlace', { category: 'hospital' }));
    expect(s.ok).toBe(true);
    expect((s.data as any).offered.placeId).toBe('pl_hosp');
    expect((s.data as any).gps).toMatch(/no position/);
    expect(String((s.data as any).instruction)).toMatch(/Never say the location is unavailable/);
    const go = await executeAction(act('start_navigation', 'navigation.startNavigation', {}));
    expect(go.ok).toBe(true);
    expect((go.data as any).directions).toBe('waiting_for_gps');
  });

  test('with a live fix, set_destination starts walking directions at once', async () => {
    useLocation.setState({ fix: freshFix(), status: 'ok' });
    const r = await executeAction(act('set_destination', 'navigation.setDestination', { query: 'City Hospital' }));
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ directions: 'started', destination: 'City Hospital', firstInstruction: 'Head west' });
    expect(ds.routeWalking).toHaveBeenCalledTimes(1);
  });

  test('a place id the model kept from earlier is looked up instead of refused', async () => {
    ds.placeById.mockResolvedValue({ ...hospital, placeId: 'pl_old', name: 'Old Clinic' });
    const r = await executeAction(act('set_destination', 'navigation.setDestination', { placeId: 'pl_old' }));
    expect(r.ok).toBe(true);
    expect(ds.placeById).toHaveBeenCalledWith('pl_old');
    expect(useNavView.getState().destination?.name).toBe('Old Clinic');
  });

  test('a second start for the same place does not start twice', async () => {
    await executeAction(act('set_destination', 'navigation.setDestination', { query: 'City Hospital' }));
    const again = await executeAction(act('start_navigation', 'navigation.startNavigation', { placeId: 'pl_hosp' }));
    expect(again.ok).toBe(true);
    expect((again.data as any).alreadyNavigating).toBe(true);
  });

  test('nothing found: an honest failure that asks again', async () => {
    ds.findPlaces.mockResolvedValue({ places: [], source: 'server', biased: false });
    const r = await executeAction(act('set_destination', 'navigation.setDestination', { query: 'Xyzzy' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No place called "Xyzzy"/);
  });
});

describe('texts carry the location', () => {
  beforeEach(() => {
    useSession.setState({ contacts: [{ id: 'emergency', name: 'Dad', relation: 'emergency', phone: '+919876543210', aliases: [] }] });
  });

  test('a help text from the assistant gets the Maps link', async () => {
    useLocation.setState({ fix: freshFix(), status: 'ok' });
    const r = await executeAction(act('send_sms_to_guardian', 'communication.sendSmsToGuardian', { text: 'Please help me, I am lost' }));
    expect(r.ok).toBe(true);
    const body = (sms.sendSms.mock.calls[0] as unknown[])[2] as string;
    expect(body).toMatch(/^Please help me, I am lost\. Location: https:\/\/maps\.google\.com\/\?q=20\.010000,73\.790000 \(accuracy 12 m, just now\)$/);
    expect((r.data as any).locationIncluded).toBe(true);
  });

  test('an ordinary text is sent as typed', async () => {
    await executeAction(act('send_sms_to_guardian', 'communication.sendSmsToGuardian', { text: 'Running late, see you at 6' }));
    expect((sms.sendSms.mock.calls[0] as unknown[])[2]).toBe('Running late, see you at 6');
  });

  test('message formats', () => {
    const now = Date.now();
    const f = { ...freshFix(), ts: now - 25 * 60_000 };
    expect(locationLine(null, false)).toBe('Location unavailable (no GPS position on the phone).');
    expect(locationLine(f, false, now)).toBe('Live location unavailable. Last known location: https://maps.google.com/?q=20.010000,73.790000 (accuracy 12 m, 25 min ago)');
    expect(withLocation('Emergency! I need help.', { ...f, ts: now }, true, now)).toBe('Emergency! I need help. Location: https://maps.google.com/?q=20.010000,73.790000 (accuracy 12 m, just now)');
    expect(ageText(now - 90_000, now)).toBe('2 min ago');
    expect(wantsLocation('send my location to dad')).toBe(true);
    expect(wantsLocation('मदद चाहिए')).toBe(true);
    expect(wantsLocation('buy milk')).toBe(false);
  });

  test('the SOS SMS never claims the location is "in the app"', () => {
    expect(smsMessage('Emergency! I need help. My live location is shared in the AI SmartStick app.')).toBe('Emergency! I need help.');
    expect(smsMessage('Help! Call me.')).toBe('Help! Call me.');
  });
});
