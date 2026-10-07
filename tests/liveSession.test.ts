import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liveSession, useLiveStatus, startFailure, CONNECT_TIMEOUT_MS } from '../src/core/ai/liveSession';
import { useSafety } from '../src/core/store/safety';
import { startConnectingTune } from '../src/core/audio/connectingTune';
import { earcon } from '../src/core/feedback/earcons';
import { useAssistant } from '../src/core/store/assistant';
import { useDevice } from '../src/core/store/device';
import * as api from '../src/core/backend/api';
import * as audioManager from '../src/core/audio/audioManager';
import { executeAction } from '../src/core/ai/executor';
import { offerDestination, clearOffer, startNavigationTo, navigatingTo } from '../src/core/ai/navIntent';
import { startRealNavigation } from '../src/core/navigation/realNavigator';
import { useNavView, emptyNav } from '../src/core/navigation/navView';

vi.mock('../src/core/backend/api', () => ({ call: vi.fn() }));

vi.mock('../src/core/audio/audioManager', () => ({
  playPcmChunk: vi.fn(),
  interruptPcm: vi.fn(),
  resetPcmStream: vi.fn(),
  onPcmInterrupted: vi.fn(() => () => {}),
  livePcmPlaying: vi.fn(() => false),
  setLiveSessionOpen: vi.fn(),
  liveAudioActive: vi.fn(() => true),
  say: vi.fn(() => Promise.resolve('spoken')),
}));

vi.mock('../src/core/ai/executor', () => ({ executeAction: vi.fn() }));
vi.mock('../src/core/navigation/realNavigator', () => ({ startRealNavigation: vi.fn() }));
vi.mock('../src/core/feedback/earcons', () => ({ loopEarcon: vi.fn(() => () => {}), earcon: vi.fn() }));

/** Every tune start gets its own stop spy; `events` records the order of tune/earcon sounds. */
const events: string[] = [];
const tuneStops: ReturnType<typeof vi.fn>[] = [];
vi.mock('../src/core/audio/connectingTune', () => ({
  startConnectingTune: vi.fn(() => {
    events.push('tune:start');
    const stop = vi.fn(() => events.push('tune:stop'));
    tuneStops.push(stop);
    return stop;
  }),
}));
/** The tune is playing iff its latest stop function has not been called. */
const tunePlaying = () => tuneStops.some((s) => s.mock.calls.length === 0);

vi.mock('../src/core/auth/authStore', () => ({
  currentUid: vi.fn(() => 'test_uid'),
  useAuth: { subscribe: vi.fn(), getState: vi.fn(() => ({})) },
}));

const mockConnect = vi.fn();
const mockSend = vi.fn();
const mockToolResponse = vi.fn();
const mockClose = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    live = { connect: mockConnect };
  },
  Modality: { AUDIO: 'AUDIO' },
}));

class FakeNode {
  connect = vi.fn(() => this);
  disconnect = vi.fn();
  gain = { value: 1 };
  onaudioprocess: ((e: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
}
let lastProcessor: FakeNode | null = null;

function installAudio() {
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: vi.fn(() => []) }) } },
    writable: true,
    configurable: true,
  });
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    state = 'running';
    sampleRate = 48000; // what Android WebView typically gives, whatever was requested
    destination = {};
    createMediaStreamSource = vi.fn(() => new FakeNode());
    createScriptProcessor = vi.fn(() => (lastProcessor = new FakeNode()));
    createGain = vi.fn(() => new FakeNode());
    resume = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  };
}

/** Connects a fake Live socket and returns its onmessage callback. */
async function openSession(model = 'models/live-test') {
  let onMessage: (m: unknown) => void = () => {};
  vi.mocked(api.call).mockResolvedValueOnce({ token: 'auth_tokens/ephemeral', liveModel: model });
  mockConnect.mockImplementationOnce(({ callbacks }) => {
    onMessage = callbacks.onmessage;
    callbacks.onopen();
    return Promise.resolve({ sendRealtimeInput: mockSend, sendToolResponse: mockToolResponse, close: mockClose });
  });
  expect(await liveSession.start()).toBe(true);
  return (m: unknown) => onMessage(m);
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const place = { placeId: 'pl_barber', name: "Boy's Hairstyle", address: 'MG Road', lat: 20.1, lng: 74.5, distanceM: 480, openNow: true, primaryType: 'barber_shop' };

describe('Gemini Live session', () => {
  beforeEach(() => {
    useAssistant.setState({ phase: 'idle', heard: '', reply: '' });
    useDevice.setState({ internet: true });
    useNavView.setState(emptyNav());
    clearOffer();
    vi.clearAllMocks();
    installAudio();
    events.length = 0;
    tuneStops.length = 0;
    useSafety.setState({ phase: 'idle' });
    vi.mocked(earcon).mockImplementation((n) => void events.push(`earcon:${n}`));
  });

  afterEach(() => {
    liveSession.stop('user');
  });

  it('gets a one-use token from Firebase and connects with the server-chosen model', async () => {
    await openSession('models/server-chosen-live');
    expect(api.call).toHaveBeenCalledWith('getLiveToken', {}, 15000);
    expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({ model: 'models/server-chosen-live' }));
    const cfg = mockConnect.mock.calls[0][0].config;
    expect(cfg.responseModalities).toEqual(['AUDIO']);
    expect(cfg.inputAudioTranscription).toEqual({});
    expect(useAssistant.getState().phase).toBe('listening');
    expect(audioManager.setLiveSessionOpen).toHaveBeenCalledWith(true);
  });

  it('streams the microphone as 16 kHz PCM in the SDK realtime-input shape', async () => {
    await openSession();
    // 100 ms of 48 kHz audio from the WebView → 1600 samples at 16 kHz = 3200 bytes.
    lastProcessor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4800).fill(0.25) } });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const arg = mockSend.mock.calls[0][0];
    expect(arg.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(atob(arg.audio.data).length).toBe(3200);
  });

  it('routes model audio to the audio owner and stops it on interruption', async () => {
    const msg = await openSession();
    msg({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } });
    expect(audioManager.playPcmChunk).toHaveBeenCalledWith('AAAA', 24000);
    expect(useAssistant.getState().phase).toBe('speaking');
    msg({ serverContent: { interrupted: true } });
    expect(audioManager.interruptPcm).toHaveBeenCalled();
  });

  it('"Yes" starts navigation to exactly the offered place, once', async () => {
    vi.mocked(startRealNavigation).mockImplementation(async (p) => {
      useNavView.setState({ ...emptyNav(), active: true, source: 'real', destination: { name: p.name, placeId: p.placeId, lat: p.lat, lng: p.lng } });
      return { distanceM: 480, durationS: 360, steps: [{ instruction: 'Head north', maneuver: null, distanceM: 100 }], path: [] } as never;
    });
    const msg = await openSession();
    offerDestination(place); // what find_nearest_place does
    msg({ serverContent: { inputTranscription: { text: 'Yes.' } } });
    await flush();
    // Judged only once the utterance is complete, never on a first fragment.
    expect(startRealNavigation).not.toHaveBeenCalled();
    msg({ serverContent: { turnComplete: true } });
    await flush();
    expect(startRealNavigation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startRealNavigation).mock.calls[0][0].placeId).toBe('pl_barber');

    // The model also calls start_navigation: it must not start a second route.
    expect(navigatingTo('pl_barber')).toBe(true);
    const again = await startNavigationTo(place);
    expect(again.started).toBe(false);
    expect(startRealNavigation).toHaveBeenCalledTimes(1);
  });

  it('"Okay, what about a hospital?" is a new request, not a yes', async () => {
    const msg = await openSession();
    offerDestination(place);
    msg({ serverContent: { inputTranscription: { text: 'Okay' } } });
    msg({ serverContent: { inputTranscription: { text: ', what about a hospital?' } } });
    msg({ serverContent: { turnComplete: true } });
    await flush();
    expect(startRealNavigation).not.toHaveBeenCalled();
  });

  it('"No" withdraws the offer; nothing starts', async () => {
    const msg = await openSession();
    offerDestination(place);
    msg({ serverContent: { inputTranscription: { text: 'No, not now' } } });
    msg({ serverContent: { inputTranscription: { text: ' yes' } } });
    await flush();
    expect(startRealNavigation).not.toHaveBeenCalled();
  });

  it('confirm-gated tools wait for the user’s yes', async () => {
    vi.mocked(executeAction).mockResolvedValue({ id: 'x', name: 'send_sms_to_guardian', ok: true, data: { result: 'sent' } } as never);
    const msg = await openSession();
    const call = { toolCall: { functionCalls: [{ id: 't1', name: 'send_sms_to_guardian', args: { text: 'Running late' } }] } };
    msg(call);
    await flush();
    expect(executeAction).not.toHaveBeenCalled();
    expect(mockToolResponse.mock.calls[0][0].functionResponses[0].response.needsConfirmation).toBe(true);

    msg({ serverContent: { turnComplete: true } });
    msg({ serverContent: { inputTranscription: { text: 'haan' } } });
    msg(call);
    await flush();
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  // ── Connecting tune + start reliability ──────────────────────────────────────────

  it('plays the connecting tune while connecting, stops it when open, then the listening earcon', async () => {
    await openSession();
    expect(startConnectingTune).toHaveBeenCalledTimes(1);
    expect(tunePlaying()).toBe(false);
    expect(events.slice(0, 3)).toEqual(['tune:start', 'tune:stop', 'earcon:listen']);
    expect(useLiveStatus.getState().connecting).toBe(false);
    expect(useAssistant.getState().phase).toBe('listening');
  });

  it('shows "connecting" only while the tune plays', async () => {
    let resolveToken: (v: unknown) => void = () => {};
    vi.mocked(api.call).mockReturnValueOnce(new Promise((r) => (resolveToken = r)) as never);
    const p = liveSession.start();
    expect(useLiveStatus.getState().connecting).toBe(true);
    expect(liveSession.isConnecting).toBe(true);
    expect(tunePlaying()).toBe(true);
    liveSession.stop('user');
    expect(useLiveStatus.getState().connecting).toBe(false);
    expect(tunePlaying()).toBe(false);
    resolveToken({ token: 't', liveModel: 'm' });
    expect(await p).toBe(false);
    // Cancelled before the token arrived: no socket is ever opened.
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('stops the tune and speaks a clear reason when the token call fails', async () => {
    vi.mocked(api.call).mockRejectedValueOnce(Object.assign(new Error('Unauthenticated'), { code: 'functions/unauthenticated' }));
    expect(await liveSession.start()).toBe(false);
    expect(tunePlaying()).toBe(false);
    expect(useAssistant.getState().phase).toBe('error');
    expect(useAssistant.getState().unavailable).toBe('Please sign in again');
    expect(audioManager.say).toHaveBeenCalledWith(expect.stringMatching(/sign in/i), expect.objectContaining({ priority: 'user' }));
    expect(liveSession.isActive).toBe(false);
  });

  it('stops the tune when the socket closes before opening', async () => {
    vi.mocked(api.call).mockResolvedValueOnce({ token: 't', liveModel: 'm' });
    mockConnect.mockImplementationOnce(({ callbacks }) => {
      setTimeout(() => callbacks.onclose({ code: 1008, reason: 'model not found' }), 0);
      return Promise.resolve({ sendRealtimeInput: mockSend, sendToolResponse: mockToolResponse, close: mockClose });
    });
    expect(await liveSession.start()).toBe(false);
    expect(tunePlaying()).toBe(false);
    expect(useAssistant.getState().phase).toBe('error');
    expect(mockClose).toHaveBeenCalled();
    expect(audioManager.setLiveSessionOpen).not.toHaveBeenCalledWith(true);
  });

  it('never hangs in "connecting": one overall timeout stops the tune and says so', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api.call).mockReturnValueOnce(new Promise(() => {}) as never); // token never arrives
      const p = liveSession.start();
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS + 10);
      expect(await p).toBe(false);
      expect(tunePlaying()).toBe(false);
      expect(useAssistant.getState().unavailable).toBe('Connection timed out');
      expect(audioManager.say).toHaveBeenCalledWith(expect.stringMatching(/too long/i), expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it('a socket that arrives after cancel is closed, not left open', async () => {
    let resolveSocket: (v: unknown) => void = () => {};
    vi.mocked(api.call).mockResolvedValueOnce({ token: 't', liveModel: 'm' });
    mockConnect.mockImplementationOnce(() => new Promise((r) => (resolveSocket = r)));
    const p = liveSession.start();
    await flush();
    expect(mockConnect).toHaveBeenCalled();
    liveSession.stop('user');
    resolveSocket({ sendRealtimeInput: mockSend, sendToolResponse: mockToolResponse, close: mockClose });
    expect(await p).toBe(false);
    await flush();
    expect(mockClose).toHaveBeenCalled();
    expect(tunePlaying()).toBe(false);
  });

  it('SOS while connecting abandons the connection and silences the tune', async () => {
    vi.mocked(api.call).mockReturnValueOnce(new Promise(() => {}) as never);
    void liveSession.start();
    expect(tunePlaying()).toBe(true);
    useSafety.setState({ phase: 'countdown' });
    expect(tunePlaying()).toBe(false);
    expect(liveSession.isActive).toBe(false);
    expect(audioManager.say).not.toHaveBeenCalled(); // SOS speaks; the assistant stays quiet
  });

  it('SOS does not cut an open conversation', async () => {
    await openSession();
    useSafety.setState({ phase: 'countdown' });
    expect(liveSession.isActive).toBe(true);
  });

  it('a mic permission refusal stops everything and explains it', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
    vi.mocked(api.call).mockResolvedValueOnce({ token: 't', liveModel: 'm' });
    mockConnect.mockImplementationOnce(({ callbacks }) => {
      callbacks.onopen();
      return Promise.resolve({ sendRealtimeInput: mockSend, sendToolResponse: mockToolResponse, close: mockClose });
    });
    expect(await liveSession.start()).toBe(false);
    expect(useAssistant.getState().unavailable).toBe('Microphone permission needed');
    expect(mockClose).toHaveBeenCalled();
    expect(audioManager.setLiveSessionOpen).toHaveBeenLastCalledWith(false);
  });

  it('every start/stop cycle leaves no tune behind', async () => {
    for (let i = 0; i < 3; i++) {
      await openSession();
      liveSession.stop('user');
    }
    vi.mocked(api.call).mockRejectedValueOnce(new Error('boom'));
    await liveSession.start();
    expect(tuneStops).toHaveLength(4);
    expect(tunePlaying()).toBe(false);
  });

  it('failure messages name the cause', () => {
    expect(startFailure('Permission denied', '', 'NotAllowedError').label).toBe('Microphone permission needed');
    expect(startFailure('Too many requests. Please wait a moment.', 'functions/resource-exhausted').label).toMatch(/busy/i);
    expect(startFailure('The assistant took too long to connect.').label).toBe('Connection timed out');
    expect(startFailure('weird').label).toBe('Could not connect');
  });
});
