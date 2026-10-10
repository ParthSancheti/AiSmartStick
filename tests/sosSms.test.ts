import { describe, test, expect, beforeEach, vi } from 'vitest';

const { sms, sync } = vi.hoisted(() => ({
  sms: { sendSms: vi.fn(async (..._a: unknown[]) => 'sent'), placeCall: vi.fn(), SOS_SMS_PERMISSION_WAIT_MS: 5000 },
  sync: { createSosEvent: vi.fn(async () => 'queued'), updateSosEvent: vi.fn(async () => undefined), stopSosWatch: vi.fn() },
}));
vi.mock('../src/core/phone', () => sms);
vi.mock('../src/core/sync/userSync', () => sync);
vi.mock('../src/core/ai/voiceOut', () => ({ announce: vi.fn(), cancelInvalidAnnouncements: vi.fn() }));
vi.mock('../src/core/feedback/haptics', () => ({ haptics: { play: vi.fn() } }));
vi.mock('../src/core/feedback/earcons', () => ({ earcon: vi.fn() }));
vi.mock('../src/core/feedback/speech', () => ({ stopSpeaking: vi.fn() }));
vi.mock('../src/core/voice/recognition', () => ({ abortRecognition: vi.fn() }));
vi.mock('@capacitor/geolocation', () => ({
  Geolocation: {
    getCurrentPosition: vi.fn(async () => {
      throw new Error('no fix');
    }),
    checkPermissions: vi.fn(async () => ({ location: 'prompt' })),
    watchPosition: vi.fn(async () => 'w'),
    clearWatch: vi.fn(async () => undefined),
  },
}));

import { startSos } from '../src/core/safety/sos';
import { useSafety, initialSafety } from '../src/core/store/safety';
import { useSession } from '../src/core/store/session';
import { useLocation } from '../src/core/location/locationService';
import { useRuntime } from '../src/core/runtime/mode';

const body = () => (sms.sendSms.mock.calls[0] as unknown[])[2] as string;

async function runSos() {
  vi.useFakeTimers();
  startSos('button');
  await vi.advanceTimersByTimeAsync(useSession.getState().settings.sosCancelSec * 1000 + 9000);
  vi.useRealTimers();
  await vi.waitFor(() => expect(sms.sendSms).toHaveBeenCalled());
}

describe('SOS SMS carries the location in the text itself', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRuntime.setState({ mode: 'real' });
    useSafety.setState({ ...initialSafety });
    useSession.setState({ linked: false, contacts: [{ id: 'emergency', name: 'Dad', relation: 'emergency', phone: '+919876543210', aliases: [] }] });
    useSession.getState().updateSettings({ sosMessage: 'Emergency! I need help. My live location is shared in the AI SmartStick app.' });
  });

  test('live fix → Google Maps link with accuracy and age, sent directly', async () => {
    useLocation.setState({ fix: { lat: 19.99751, lng: 73.78986, accuracyM: 9, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() }, status: 'ok' });
    await runSos();
    expect(body()).toMatch(/^Emergency! I need help\. Location: https:\/\/maps\.google\.com\/\?q=19\.997510,73\.789860 \(accuracy 9 m, (just now|\d+ sec ago)\)$/);
    expect((sms.sendSms.mock.calls[0] as unknown[])[3]).toEqual({ direct: true, permissionWaitMs: 5000 });
  });

  test('only an old position → says live location is unavailable and gives the last known one with its age', async () => {
    useLocation.setState({ fix: { lat: 19.9, lng: 73.7, accuracyM: 30, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() - 40 * 60_000 }, status: 'stale' });
    await runSos();
    expect(body()).toMatch(/Live location unavailable\. Last known location: https:\/\/maps\.google\.com\/\?q=19\.900000,73\.700000 \(accuracy 30 m, 4\d min ago\)$/);
  });

  test('the text is GSM-7 and fits ONE SMS (a "±" would force UCS-2 and split the link across parts)', async () => {
    const GSM7 = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà]*$/;
    useLocation.setState({ fix: { lat: 19.9, lng: 73.7, accuracyM: 1800, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() - 40 * 60_000 }, status: 'stale' });
    await runSos();
    expect(body()).toMatch(GSM7);
    expect(body().length).toBeLessThanOrEqual(160);
  });

  test('no position at all → "Location unavailable", the SMS still goes', async () => {
    useLocation.setState({ fix: null, status: 'acquiring' });
    await runSos();
    expect(body()).toBe('Emergency! I need help. Location unavailable (no GPS position on the phone).');
  });
});
