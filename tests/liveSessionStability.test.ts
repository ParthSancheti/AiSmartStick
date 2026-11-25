import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  apiCalls: [] as unknown[][],
  aiOpts: [] as { apiKey?: string; httpOptions?: { apiVersion?: string } }[],
  connectConfigs: [] as { model?: string; config?: Record<string, unknown> }[],
  callbacksList: [] as {
    onopen?: () => void;
    onmessage?: (msg: unknown) => void;
    onerror?: (e: unknown) => void;
    onclose?: (e: unknown) => void;
  }[],
  sessions: [] as { sendClientContent: ReturnType<typeof import('vitest').vi.fn>; sendRealtimeInput: ReturnType<typeof import('vitest').vi.fn>; close: ReturnType<typeof import('vitest').vi.fn> }[],
  micStart: vi.fn(async () => {}),
  micStop: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  Modality: { AUDIO: 'AUDIO' },
  GoogleGenAI: class {
    constructor(opts: { apiKey?: string; httpOptions?: { apiVersion?: string } }) {
      m.aiOpts.push(opts);
    }
    live = {
      connect: vi.fn(async (params: { model?: string; config?: Record<string, unknown>; callbacks?: any }) => {
        m.connectConfigs.push({ model: params.model, config: params.config });
        m.callbacksList.push(params.callbacks);
        const s = {
          sendClientContent: vi.fn(),
          sendRealtimeInput: vi.fn(),
          sendToolResponse: vi.fn(),
          close: vi.fn(),
        };
        m.sessions.push(s);
        queueMicrotask(() => params.callbacks?.onopen?.());
        return s;
      }),
    };
  },
}));

vi.mock('../src/core/backend/api', () => ({
  call: vi.fn(async (...args: unknown[]) => {
    m.apiCalls.push(args);
    return { token: 'auth_tokens/test-ephemeral', liveModel: 'gemini-3.8-live', flashModel: 'gemini-3.8-flash' };
  }),
}));

vi.mock('../src/core/voice/micStream', () => ({
  MicStream: class {
    sampleRate = 16000;
    onData: ((data: string) => void) | null = null;
    start = m.micStart;
    stop = m.micStop;
  },
}));

vi.mock('../src/core/audio/audioManager', () => ({
  setLiveSessionOpen: vi.fn(),
  localSpeechActive: vi.fn(() => false),
  livePcmPlaying: vi.fn(() => false),
  playPcmChunk: vi.fn(),
  finishPcmTurn: vi.fn(),
  interruptPcm: vi.fn(),
  say: vi.fn(async () => 'spoken'),
}));
vi.mock('../src/core/audio/connectingTune', () => ({ startConnectingTune: vi.fn(() => () => {}) }));
vi.mock('../src/core/feedback/earcons', () => ({ earcon: vi.fn() }));
vi.mock('../src/core/feedback/haptics', () => ({ haptics: { play: vi.fn() } }));

import { liveSession } from '../src/core/ai/liveSession';

describe('Gemini 3.8 Live protocol stability (v1beta, compression, resumption, blocking tools)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    m.apiCalls.length = 0;
    m.aiOpts.length = 0;
    m.connectConfigs.length = 0;
    m.callbacksList.length = 0;
    m.sessions.length = 0;
    m.micStart.mockClear();
    m.micStop.mockClear();
    liveSession.stop('user');
  });

  afterEach(() => {
    liveSession.stop('user');
    vi.useRealTimers();
  });

  it('connects on v1beta with contextWindowCompression, sessionResumption, VAD tuning, and BLOCKING tools', async () => {
    const ok = await liveSession.start();
    expect(ok).toBe(true);
    expect(m.aiOpts[0]).toEqual({ apiKey: 'auth_tokens/test-ephemeral', httpOptions: { apiVersion: 'v1beta' } });
    const cfg = m.connectConfigs[0]?.config ?? {};
    expect(cfg.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(cfg.sessionResumption).toEqual({});
    expect((cfg.speechConfig as any)?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe('Kore');
    expect((cfg.realtimeInputConfig as any)?.automaticActivityDetection?.startOfSpeechSensitivity).toBe('START_SENSITIVITY_LOW');
    const decls = ((cfg.tools as any)?.[0]?.functionDeclarations ?? []) as { behavior?: string }[];
    expect(decls.length).toBeGreaterThan(0);
    expect(decls.every((d) => d.behavior === 'BLOCKING')).toBe(true);
  });

  it('retains sessionResumption handle and seamlessly reconnects on goAway without dropping the call', async () => {
    expect(await liveSession.start()).toBe(true);
    expect(m.connectConfigs).toHaveLength(1);

    await m.callbacksList[0].onmessage?.({
      sessionResumptionUpdate: { resumable: true, newHandle: 'resume-handle-xyz' },
      goAway: { timeLeft: '15s' },
    });

    await vi.advanceTimersByTimeAsync(1600);
    expect(liveSession.isActive).toBe(true);
    expect(m.connectConfigs).toHaveLength(2);
    expect(m.connectConfigs[1].config?.sessionResumption).toEqual({ handle: 'resume-handle-xyz' });
    // Seamless resume reuses cached token within its lifetime without greeting again.
    expect(m.apiCalls).toHaveLength(1);
    expect(m.sessions[1].sendClientContent).not.toHaveBeenCalled();
  });
});
