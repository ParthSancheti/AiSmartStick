import type { Action, ToolResult } from '../../../shared/assistantContract';
import { TOOL_BY_NAME, type Requirement } from '../../../shared/tools';
import { validateArgs } from '../../../shared/validate';
import { useDevice, isLinked } from '../store/device';
import { useSession, getSettings } from '../store/session';
import { useSafety } from '../store/safety';
import { logEvent } from '../store/activity';
import { useLocation, freshnessLabel } from '../location/locationService';
import { searchPlaces, reverseLookup, type PlaceResult } from '../maps/mapsService';
import { startRealNavigation, stopRealNavigation, reroute as realReroute } from '../navigation/realNavigator';
import { useNavView } from '../navigation/navView';
import { useSafetyEval } from '../safety/safetyRuntime';
import { startSos, cancelSos } from '../safety/sos';
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
        const f = await captureFrame('assistant');
        return ok(a, { captured: true, width: 0, height: 0, at: f.ts, note: 'Use describe_scene/read_text to interpret a photo.' });
      }
      case 'vision.describeScene':
      case 'vision.readText':
      case 'vision.identifyObject':
      case 'vision.readSign':
      case 'vision.describeEnvironment': {
        const task = spec.name as VisionTask;
        const r = await runVision(task, args.hint as string | undefined);
        return ok(a, { ...r });
      }
      // ── NAVIGATION ──
      case 'navigation.getCurrentLocation': {
        const f = useLocation.getState().fix!;
        let rev: Awaited<ReturnType<typeof reverseLookup>> | null = null;
        if (d.internet) rev = await reverseLookup(f.lat, f.lng).catch(() => null);
        return ok(a, { accuracyM: Math.round(f.accuracyM), freshness: freshnessLabel(f.ts), address: rev?.address ?? null, nearestPlace: rev?.landmark ?? null });
      }
      case 'navigation.searchPlace':
      case 'navigation.findNearestPlace': {
        const f = useLocation.getState().fix!;
        const r = await searchPlaces({ query: (args.query as string) || undefined, category: (args.category as string) || undefined, lat: f.lat, lng: f.lng, radiusM: 3000 });
        lastPlaces = r.places;
        if (!r.places.length) return ok(a, { places: [], note: 'No matching places found nearby.' });
        if (spec.type === 'navigation.findNearestPlace') {
          // App rule: nearest place that is not known to be closed.
          const pick = r.places.find((p) => p.openNow !== false) ?? r.places[0];
          chosen = pick;
          return ok(a, { chosen: placeOut(pick), alternatives: r.places.slice(0, 3).map(placeOut) });
        }
        return ok(a, { places: r.places.slice(0, 5).map(placeOut) });
      }
      case 'navigation.setDestination': {
        const p = lastPlaces.find((x) => x.placeId === args.placeId);
        if (!p) return fail(a, 'That place id did not come from a recent search. Search again first.');
        chosen = p;
        return ok(a, { destination: placeOut(p) });
      }
      case 'navigation.startNavigation': {
        const p = (args.placeId ? lastPlaces.find((x) => x.placeId === args.placeId) : null) ?? chosen;
        if (!p) return fail(a, 'No destination chosen. Search for a place first.');
        const route = await startRealNavigation(p);
        return ok(a, { destination: p.name, distanceM: Math.round(route.distanceM), durationMin: Math.max(1, Math.round(route.durationS / 60)), firstInstruction: route.steps[0]?.instruction ?? null });
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
        return ok(a, { name: s.guardian.name || null, heardAs: s.guardian.heardAs || null, hasPhoneNumber: !!s.guardian.phone });
      case 'communication.callGuardian': {
        const r = await placeCall(s.guardian.heardAs || s.guardian.name, s.guardian.phone);
        if (r === 'no_number') return fail(a, 'No phone number is saved for the guardian.');
        return ok(a, { result: r, meaning: r === 'call_started' ? 'The phone is calling now.' : 'The dialer is open; the user must press call.' });
      }
      case 'communication.sendSmsToGuardian': {
        const r = await sendSms(s.guardian.heardAs || s.guardian.name, s.guardian.phone, String(args.text));
        if (r === 'no_number') return fail(a, 'No phone number is saved for the guardian.');
        return ok(a, { result: r, meaning: r === 'sent' ? 'The SMS was handed to Android for sending.' : 'The message composer is open; the user must press send. Do not say it was sent.' });
      }
      // ── AUDIO ──
      case 'audio.speak':
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
    if (msg === 'location-unavailable') return fail(a, 'No GPS position yet.');
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
