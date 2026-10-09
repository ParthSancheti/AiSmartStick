import type { Action, ToolResult } from '../../../shared/assistantContract';
import { TOOL_BY_NAME, type Requirement } from '../../../shared/tools';
import { validateArgs } from '../../../shared/validate';
import { useDevice, isLinked } from '../store/device';
import { useSession, getSettings } from '../store/session';
import { useSafety } from '../store/safety';
import { logEvent } from '../store/activity';
import { useLocation, freshnessLabel, acquireFix, LOCATION_STALE_MS } from '../location/locationService';
import { reverseLookup, type PlaceResult } from '../maps/mapsService';
import { findPlaces, placeById, searchBias } from '../maps/destinationSearch';
import { messageWithLocation, wantsLocation } from '../location/shareLocation';
import { stopRealNavigation, reroute as realReroute } from '../navigation/realNavigator';
import { useNavView } from '../navigation/navView';
import { useSafetyEval } from '../safety/safetyRuntime';
import { startSos, cancelSos, safetyContact } from '../safety/sos';
import { placeCall, sendSms } from '../phone';
import { say, stopAll, useAudio } from '../audio/audioManager';
import { usePhoneInfo, phoneLabel } from '../native/deviceInfo';
import { captureFrame } from '../vision/relay';
import { call } from '../backend/api';
import type { VisionRequest, VisionResult, VisionTask } from '../../../shared/assistantContract';
import { loadMessages } from './history';
import { useAssistant } from '../store/assistant';
import { resolveLang } from './voiceOut';
import { fuseScene, measuredSuffix, sensorContext } from '../vision/fusion';
import { offerDestination, startNavigationTo, navigatingTo, pendingOffer } from './navIntent';
import { liveAudioActive } from '../audio/audioManager';

/**
 * REAL MODE tool executor. Gemini proposes actions; this decides and does them.
 * Every action: known tool? → valid arguments? → requirements met? → execute → typed result.
 * Unknown tools and malformed arguments are rejected and reported back to the model.
 */
let lastPlaces: PlaceResult[] = [];
let chosen: PlaceResult | null = null;

const fail = (a: Action, error: string): ToolResult => ({ id: a.id, name: a.name, ok: false, error });
const ok = (a: Action, data: Record<string, unknown>): ToolResult => ({ id: a.id, name: a.name, ok: true, data });

function unmet(req: Requirement[]): string | null {
  const d = useDevice.getState();
  for (const r of req) {
    if (r === 'device' && !isLinked(d.link)) return 'The stick is not connected to the phone.';
    if (r === 'internet' && d.internet !== true) return 'The phone has no internet connection.';
    if (r === 'location') {
      const l = useLocation.getState();
      if (!l.fix) return l.permission === 'denied' ? 'Location permission is denied.' : 'No GPS position yet.';
    }
    if (r === 'guardian' && !useSession.getState().linked) return 'No guardian is linked yet.';
  }
  return null;
}

async function blobToB64(b: Blob) {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Why a camera tool failed, in words the assistant can say to the user (short, simple English).
 * Covers the stick camera (offline / busy / no answer), the server (unreachable, App Check refused,
 * not deployed) and the AI picture service (key problem on the server).
 */
export function visionFailureReason(e: unknown): string {
  // Only string codes are server codes (a DOMException has a number code, e.g. 23 for a timeout).
  const raw = (e as { code?: unknown })?.code;
  const code = typeof raw === 'string' ? raw.replace(/^functions\//, '') : '';
  const msg = String((e as Error)?.message ?? e ?? '');
  if (msg === 'stick-offline') return 'The stick camera is offline: the stick is not connected to the phone. Ask the user to switch the stick on and connect it.';
  if (/camera: busy|\b409\b/i.test(msg)) return 'The stick camera is busy right now (the live video is using it). Try again in a few seconds.';
  // Errors without a server code come from the stick side (capture request, live stream).
  if (!code && /^\s*camera:|\bcamera\b|HTTP \d{3}|\/api\/v1\/capture|no path to the stick|not bound|stick network|stick did not answer|stream|timed out|timeout|aborted|failed to fetch|network/i.test(msg)) return 'The stick camera did not answer. The stick may be too far or switched off. Try again.';
  const keyWords = /api.?key|API_KEY|key (is )?(not valid|invalid|expired)|gemini|not configured|PERMISSION_DENIED|billing/i;
  switch (code) {
    case 'unauthenticated':
      return /sign in/i.test(msg)
        ? 'The user is not signed in. Ask them to sign in again, then try the camera again.'
        : 'The server refused this app (App Check). Picture description will work after App Check is set up. The obstacle sensor still works.';
    case 'deadline-exceeded':
      return 'The server did not answer in time (slow internet, or the server is starting). Try again.';
    case 'unavailable':
      return 'The phone could not reach the server. Check the internet connection.';
    case 'failed-precondition':
      return keyWords.test(msg) ? 'The AI picture service is not set up on the server (Gemini key missing). Tell the user it does not work yet.' : 'The server refused the picture request. Try again later.';
    case 'internal':
      return keyWords.test(msg) ? 'The AI picture service has a key problem on the server (Gemini key). Tell the user it does not work right now.' : 'The AI picture service had a server error. Try again.';
    case 'resource-exhausted':
      return 'Too many picture requests. Wait a minute and try again.';
    case 'not-found':
      return 'The picture service is not installed on the server yet.';
    case 'permission-denied':
      return 'The server refused the picture request for this account.';
    case 'invalid-argument':
      return 'The camera picture was not usable. Try again.';
    case 'unknown':
      if (/not configured/i.test(msg)) return 'This app is not connected to its server (Firebase is not set up in this build).';
  }
  return msg ? `The camera did not work: ${msg.slice(0, 120)}` : 'The camera did not work. Try again.';
}

/** Capture from the stick and interpret with Gemini vision (backend). The image is not stored anywhere. */
export async function runVision(task: VisionTask, hint?: string): Promise<VisionResult> {
  const prev = useAssistant.getState().phase;
  useAssistant.setState({ phase: 'vision' });
  try {
    return await runVisionInner(task, hint);
  } finally {
    if (useAssistant.getState().phase === 'vision') useAssistant.setState({ phase: prev === 'vision' ? 'thinking' : prev });
  }
}

async function runVisionInner(task: VisionTask, hint?: string): Promise<VisionResult> {
  const frame = await captureFrame('assistant');
  const lang = resolveLang();
  // Sensor fusion input: what the stick MEASURED at capture time (ultrasonic = how far, IMU = pose).
  const sensors = sensorContext();
  const res = await call<VisionRequest, VisionResult>('assistantVision', { task, lang, imageBase64: await blobToB64(frame.blob), hint, sensors }, 40000);
  res.fused = fuseScene(res, sensors);
  res.spoken = `${res.spoken}${measuredSuffix(res.fused)}`;
  logEvent({ kind: 'vision', severity: 'info', title: task === 'read_text' || task === 'read_sign' ? 'Assistant read text from the camera' : 'Assistant described the camera view', detail: res.uncertain ? 'Reported as uncertain' : undefined });
  return res;
}

function placeOut(p: PlaceResult) {
  return { placeId: p.placeId, name: p.name, address: p.address, distanceM: p.distanceM == null ? null : Math.round(p.distanceM), openNow: p.openNow };
}

/** What the model may say about GPS: a missing fix never blocks choosing a destination. */
function gpsNote() {
  const f = useLocation.getState().fix;
  if (f && Date.now() - f.ts <= LOCATION_STALE_MS) return 'live';
  return f ? 'last known position (distances approximate)' : 'no position yet (distances unknown)';
}

const WAIT_GPS_INSTRUCTION = 'Tell the user the destination is set and walking directions will start automatically as soon as GPS finds their position. Do not say the location or maps are unavailable.';
const WAIT_PRECISE_INSTRUCTION = 'Tell the user the destination is set, but walking directions need Precise location: ask them to turn on Precise location for this app (the map shows a "Use precise" button). Directions start by themselves once it is on. Do not say maps are unavailable.';
/** What the model should say while the destination waits for a usable position (honest about an Approximate-only grant). */
const waitInstruction = () => (useLocation.getState().precise === false ? WAIT_PRECISE_INSTRUCTION : WAIT_GPS_INSTRUCTION);

/** Starts directions to `p` now, or sets it and waits for the first GPS fix. Never starts twice. */
async function goTo(a: Action, p: PlaceResult): Promise<ToolResult> {
  chosen = p;
  if (navigatingTo(p.placeId)) {
    // The user's "yes" already started it (deterministic confirmation path). Never start twice.
    const n = useNavView.getState();
    const waiting = !n.path.length && n.remainingM == null;
    return ok(a, { destination: p.name, alreadyNavigating: true, directions: waiting ? 'waiting_for_gps' : 'started', remainingM: n.remainingM == null ? null : Math.round(n.remainingM), next: n.next?.text ?? null, ...(waiting ? { instruction: waitInstruction() } : {}) });
  }
  // The model speaks the result itself (waitInstruction): no second, overlapping announcement.
  const r = await startNavigationTo(p, { announce: false });
  if ('waitingForGps' in r && r.waitingForGps) return ok(a, { destination: placeOut(p), directions: 'waiting_for_gps', instruction: waitInstruction() });
  const route = r.started ? r.route : null;
  const n = useNavView.getState();
  return ok(a, { destination: p.name, directions: 'started', distanceM: route ? Math.round(route.distanceM) : n.totalM, durationMin: route ? Math.max(1, Math.round(route.durationS / 60)) : null, firstInstruction: route?.steps[0]?.instruction ?? n.next?.text ?? null });
}

/**
 * Audit: every executed tool call is recorded with the conversation by the backend
 * (toolCalls/toolResults on the model message). Actions with side effects are also written to
 * the activity log so the user and guardian can see what the assistant actually did.
 */
export async function executeAction(a: Action): Promise<ToolResult> {
  const r = await executeActionInner(a);
  const spec = TOOL_BY_NAME.get(a.name);
  if (spec?.sideEffect && !['audio.speak', 'audio.stopSpeaking', 'safety.triggerSOS', 'safety.cancelSOS'].includes(spec.type)) {
    logEvent({ kind: spec.category === 'navigation' ? 'navigation' : spec.category === 'communication' ? 'message' : 'device', severity: r.ok ? 'info' : 'warning', title: `Assistant ${r.ok ? 'did' : 'could not do'}: ${spec.description.split('.')[0].toLowerCase()}`, detail: r.ok ? undefined : r.error });
  }
  return r;
}

async function executeActionInner(a: Action): Promise<ToolResult> {
  const spec = TOOL_BY_NAME.get(a.name);
  if (!spec || spec.type !== a.type) return fail(a, `Unknown tool ${a.name}`);
  const v = validateArgs(spec.params, a.arguments);
  if (!v.ok) return fail(a, `Invalid arguments: ${v.error}`);
  const args = v.value as Record<string, string | number | boolean | undefined>;
  const blocked = unmet(spec.requires);
  if (blocked) return fail(a, blocked);

  const d = useDevice.getState();
  const s = useSession.getState();
  try {
    switch (spec.type) {
      // ── DEVICE ──
      case 'device.getDeviceStatus':
      case 'device.getSensorState':
      case 'device.getBattery':
      case 'device.getChargingState':
      case 'device.getConnectionState':
        return ok(a, {
          stick: d.link,
          phoneInternet: d.internet,
          battery: { status: d.battery.status, estimatePercent: d.battery.percent, charging: d.battery.charging, chargingSource: d.battery.chargingSource, measured: freshnessLabel(d.battery.measuredAt), note: 'estimate from voltage and current' },
          obstacleSensor: { status: d.ultrasonic.status, distanceCm: d.ultrasonic.distanceCm, note: d.ultrasonic.status === 'no_echo' ? 'no echo: nothing detected in range or surface not reflecting; not a guarantee of a clear path' : undefined },
          motionSensor: d.imu.status,
          camera: d.camera.status,
        });
      case 'device.getFirmware':
        return ok(a, { firmware: d.identity?.firmware ?? null, protocolVersion: d.identity?.protocolVersion ?? null, deviceId: d.identity?.deviceId ?? null });
      case 'device.getPhoneInfo': {
        const p = usePhoneInfo.getState();
        return ok(a, { phone: phoneLabel(p), os: p.osVersion ?? 'Unavailable', phoneBatteryPercent: p.batteryPct, appVersion: p.appVersion });
      }
      // ── VISION ──
      case 'vision.captureScene': {
        try {
          const f = await captureFrame('assistant');
          return ok(a, { captured: true, width: 0, height: 0, at: f.ts, note: 'Use describe_scene/read_text to interpret a photo.' });
        } catch (e) {
          return fail(a, visionFailureReason(e));
        }
      }
      case 'vision.describeScene':
      case 'vision.readText':
      case 'vision.identifyObject':
      case 'vision.readSign':
      case 'vision.describeEnvironment': {
        const task = spec.name as VisionTask;
        try {
          const r = await runVision(task, args.hint as string | undefined);
          return ok(a, { ...r });
        } catch (e) {
          console.warn(`[VISION] ${task} failed: ${String((e as { code?: string })?.code ?? '')} ${(e as Error)?.message ?? e}`);
          return fail(a, visionFailureReason(e));
        }
      }
      // ── NAVIGATION ──
      case 'navigation.getCurrentLocation': {
        // Actively asks for a fresh position (up to 6 s) instead of failing on an empty store.
        const { fix: f, fresh } = await acquireFix({ maxAgeMs: 60_000, timeoutMs: 6000 });
        if (!f) return fail(a, useLocation.getState().permission === 'denied' ? 'Location permission is denied.' : 'No GPS position yet. Ask the user to move near a window or outdoors.');
        if (!fresh) return ok(a, { live: false, accuracyM: Math.round(f.accuracyM), freshness: freshnessLabel(f.ts), address: null, note: 'Only an old position is known; say how old it is.' });
        let rev: Awaited<ReturnType<typeof reverseLookup>> | null = null;
        if (d.internet) rev = await reverseLookup(f.lat, f.lng).catch(() => null);
        return ok(a, { accuracyM: Math.round(f.accuracyM), freshness: freshnessLabel(f.ts), address: rev?.address ?? null, nearestPlace: rev?.landmark ?? null });
      }
      case 'navigation.searchPlace':
      case 'navigation.findNearestPlace': {
        // No GPS needed: the newest position of any age only biases the search.
        const r = await findPlaces({ query: (args.query as string) || undefined, category: (args.category as string) || undefined, bias: searchBias(), radiusM: 3000 });
        lastPlaces = r.places;
        if (!r.places.length) return ok(a, { places: [], note: r.biased ? 'No matching places found nearby.' : 'No matching places found.' });
        // App rule: the best match that is not known to be closed. It becomes the OFFER: if the user
        // says yes, the app starts walking directions to exactly this place (core/ai/navIntent.ts).
        const pick = spec.type === 'navigation.findNearestPlace' ? (r.places.find((p) => p.openNow !== false) ?? r.places[0]) : r.places[0];
        chosen = pick;
        offerDestination(pick);
        const gps = gpsNote();
        return ok(a, {
          offered: placeOut(pick),
          alternatives: r.places.filter((p) => p !== pick).slice(0, 3).map(placeOut),
          gps,
          instruction: `Tell the user the offered place name${pick.distanceM != null ? ' and distance' : ''}, then ask if they want to go there. If they say yes, call start_navigation with this placeId. Do not search again.${gps === 'live' ? '' : ' GPS has no live position yet: that is fine, directions start automatically once it does. Never say the location is unavailable.'}`,
        });
      }
      case 'navigation.setDestination': {
        const id = (args.placeId as string | undefined)?.trim();
        const query = (args.query as string | undefined)?.trim();
        let p: PlaceResult | null = id ? (lastPlaces.find((x) => x.placeId === id) ?? (pendingOffer()?.placeId === id ? pendingOffer() : null) ?? (chosen?.placeId === id ? chosen : null)) : null;
        // A real Google place id the model kept from earlier: look it up instead of refusing.
        if (!p && id) p = await placeById(id).catch(() => null);
        if (!p && query) {
          const r = await findPlaces({ query, bias: searchBias() });
          lastPlaces = r.places;
          p = r.places[0] ?? null;
          if (!p) return fail(a, `No place called "${query}" was found. Ask the user for the name or address again.`);
        }
        if (!p) return fail(a, id ? 'That place could not be found. Search for it with search_place first.' : 'Give a placeId from a search, or the place name as query.');
        return goTo(a, p);
      }
      case 'navigation.startNavigation': {
        const p = (args.placeId ? lastPlaces.find((x) => x.placeId === args.placeId) : null) ?? pendingOffer() ?? chosen;
        if (!p) return fail(a, 'No destination chosen. Search for a place first.');
        return goTo(a, p);
      }
      case 'navigation.stopNavigation':
        stopRealNavigation('user');
        return ok(a, { stopped: true });
      case 'navigation.reroute':
        await realReroute();
        return ok(a, { rerouted: !useNavView.getState().error, error: useNavView.getState().error });
      case 'navigation.repeatDirection':
      case 'navigation.getRouteStatus': {
        const n = useNavView.getState();
        if (!n.active) return ok(a, { active: false });
        return ok(a, { active: true, destination: n.destination?.name, remainingM: n.remainingM == null ? null : Math.round(n.remainingM), etaMin: n.etaSec == null ? null : Math.max(1, Math.round(n.etaSec / 60)), next: n.next?.text ?? null, offRoute: n.offRoute });
      }
      // ── SAFETY ──
      case 'safety.getSafetyState': {
        const e = useSafetyEval.getState();
        return ok(a, { state: e.state, reasons: e.reasons, sos: useSafety.getState().phase });
      }
      case 'safety.triggerSOS':
        if (!getSettings().sosTriggers.voice) return fail(a, 'Voice SOS is turned off in settings. The user can hold the stick button for 3 seconds.');
        startSos('voice');
        return ok(a, { countdownSeconds: getSettings().sosCancelSec });
      case 'safety.cancelSOS':
        cancelSos();
        return ok(a, { phase: useSafety.getState().phase });
      // ── COMMUNICATION ──
      case 'communication.getGuardianContact':
      {
        const c = safetyContact();
        return ok(a, { name: c.name, heardAs: s.guardian.heardAs || null, hasPhoneNumber: !!c.phone });
      }
      case 'communication.callGuardian': {
        const c = safetyContact();
        const r = await placeCall(c.name, c.phone);
        if (r === 'no_number') return fail(a, 'No safety phone number is saved. The user can add one in Settings.');
        return ok(a, { result: r, meaning: r === 'call_started' ? 'The phone is calling now.' : 'The dialer is open; the user must press call.' });
      }
      case 'communication.sendSmsToGuardian': {
        const c = safetyContact();
        // Help / "where I am" texts carry the position as a plain Maps link (the receiver may not have the app).
        const sos = useSafety.getState().phase === 'active' || useSafety.getState().phase === 'countdown';
        const addLocation = c.phone != null && (sos || wantsLocation(String(args.text)));
        const body = addLocation ? (await messageWithLocation(String(args.text), { timeoutMs: 6000 })).text : String(args.text);
        const r = await sendSms(c.name, c.phone, body);
        if (r === 'no_number') return fail(a, 'No safety phone number is saved. The user can add one in Settings.');
        if (r === 'failed') return fail(a, 'The text could not be sent (no mobile network or SMS balance). Do not say it was sent.');
        const meaning =
          r === 'sent' ? 'The mobile network accepted the SMS.' : r === 'queued' ? 'The SMS was handed to the phone; delivery is not confirmed yet.' : r === 'demo' ? 'Demo mode: nothing was sent.' : 'The message composer is open; the user must press send. Do not say it was sent.';
        return ok(a, { result: r, meaning, locationIncluded: addLocation && /maps\.google\.com/.test(body) });
      }
      // ── AUDIO ──
      case 'audio.speak':
        // In a Live session the model's own voice is the output; a second (TTS) voice would talk over it.
        if (liveAudioActive()) return ok(a, { queued: false, note: 'Say this yourself in your spoken reply.' });
        void say(String(args.text), { lang: resolveLang(), priority: 'normal' });
        return ok(a, { queued: true });
      case 'audio.stopSpeaking':
        await stopAll();
        return ok(a, { stopped: true });
      case 'audio.repeatLastAnnouncement': {
        const last = useAudio.getState().lastSpoken ?? useAssistant.getState().lastSpoken;
        return ok(a, { lastAnnouncement: last?.text ?? null });
      }
      case 'audio.setAssistantVolume':
        useSession.getState().updateSettings({ assistantVolume: Math.round(Number(args.level)) });
        return ok(a, { level: Math.round(Number(args.level)) });
      // ── HISTORY ──
      case 'history.getConversationHistory': {
        const cid = useAssistant.getState().conversationId;
        if (!cid) return ok(a, { messages: [] });
        const msgs = await loadMessages(cid, Number(args.limit ?? 10));
        return ok(a, { messages: msgs.map((m) => ({ role: m.role, text: m.text.slice(0, 300) })) });
      }
      // ── AI ──
      case 'ai.escalate': {
        const r = await call<any, any>('assistantTurn', { lang: resolveLang(), input: { kind: 'text', text: String(args.text), source: 'voice' }, context: { navigating: false, sosPhase: 'idle', locationAvailable: false, deviceConnected: true, internet: true } }, 45000);
        return ok(a, { reply: r.reply?.text || 'Flash escalation succeeded but no text returned.' });
      }
      // ── SETTINGS ──
      case 'settings.getSetting':
        return ok(a, { key: args.key, value: getSettings()[args.key as keyof ReturnType<typeof getSettings>] as unknown as string });
      case 'settings.changeSetting':
        return changeSetting(a, String(args.key), String(args.value));
    }
    return fail(a, 'Not implemented');
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === 'stick-offline') return fail(a, 'The stick is not connected.');
    if (msg === 'location-unavailable') return fail(a, 'No live GPS position yet. The destination can still be set: call set_destination or start_navigation again.');
    if (msg === 'no-route') return fail(a, 'Google found no walking route to that place.');
    return fail(a, msg || 'Tool failed');
  }
}

function changeSetting(a: Action, key: string, raw: string): ToolResult {
  const up = useSession.getState().updateSettings;
  const bool = (v: string) => (/^(true|on|yes|1)$/i.test(v) ? true : /^(false|off|no|0)$/i.test(v) ? false : null);
  const num = (v: string, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  switch (key) {
    case 'voiceRate': {
      const n = num(raw, 0.7, 1.4);
      if (n == null) return fail(a, 'voiceRate must be between 0.7 and 1.4');
      up({ voiceRate: n });
      break;
    }
    case 'textScale': {
      const n = num(raw, 0.85, 1.6);
      if (n == null) return fail(a, 'textScale must be between 0.85 and 1.6');
      up({ textScale: n });
      break;
    }
    case 'assistantVolume': {
      const n = num(raw, 0, 100);
      if (n == null) return fail(a, 'assistantVolume must be 0-100');
      up({ assistantVolume: Math.round(n) });
      break;
    }
    case 'replyLang':
      if (!['auto', 'en', 'hi'].includes(raw)) return fail(a, 'replyLang must be auto, en or hi');
      up({ replyLang: raw as 'auto' | 'en' | 'hi' });
      break;
    case 'earcons':
    case 'haptics':
    case 'highContrast': {
      const b = bool(raw);
      if (b == null) return fail(a, `${key} must be on or off`);
      up({ [key]: b } as Partial<ReturnType<typeof getSettings>>);
      break;
    }
    default:
      return fail(a, 'That setting cannot be changed by voice.');
  }
  logEvent({ kind: 'device', severity: 'info', title: `Assistant changed a setting: ${key}`, detail: raw });
  return ok(a, { key, value: raw });
}
