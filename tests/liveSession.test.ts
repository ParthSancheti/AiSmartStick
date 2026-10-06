import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liveSession } from '../src/core/ai/liveSession';
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
    expect(startRealNavigation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startRealNavigation).mock.calls[0][0].placeId).toBe('pl_barber');

    // The model also calls start_navigation: it must not start a second route.
    expect(navigatingTo('pl_barber')).toBe(true);
    const again = await startNavigationTo(place);
    expect(again.started).toBe(false);
    expect(startRealNavigation).toHaveBeenCalledTimes(1);
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
});
