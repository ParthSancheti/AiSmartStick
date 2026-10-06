import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liveSession } from '../src/core/ai/liveSession';
import { useAssistant } from '../src/core/store/assistant';
import { useDevice } from '../src/core/store/device';
import * as api from '../src/core/backend/api';
import * as audioManager from '../src/core/audio/audioManager';

// Mock dependencies
vi.mock('../src/core/backend/api', () => ({
  call: vi.fn(),
}));

vi.mock('../src/core/audio/audioManager', () => ({
  playPcmChunk: vi.fn(),
  interruptPcm: vi.fn(),
  resetPcmStream: vi.fn(),
  onPcmInterrupted: vi.fn(() => () => {}),
  livePcmPlaying: vi.fn(() => false),
}));

vi.mock('../src/core/auth/authStore', () => ({
  currentUid: vi.fn(() => 'test_uid'),
  useAuth: { subscribe: vi.fn() },
}));

const mockConnect = vi.fn();
const mockSend = vi.fn();
const mockClose = vi.fn();

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    live = { connect: mockConnect };
  },
  Modality: { AUDIO: 'AUDIO' },
}));

describe('Gemini Live Session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAssistant.setState({ phase: 'idle', heard: '', reply: '' });
    useDevice.setState({ internet: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    liveSession.stop('user');
    vi.useRealTimers();
  });

  it('retrieves an ephemeral token from Firebase and creates a Live session', async () => {
    let onOpenCb: () => void;
    
    vi.mocked(api.call).mockResolvedValueOnce({
      token: 'ephemeral_123',
      liveModel: 'gemini-3.8-live'
    });
    
    mockConnect.mockImplementationOnce(({ callbacks }) => {
      onOpenCb = callbacks.onopen;
      return Promise.resolve({
        sendRealtimeInput: mockSend,
        close: mockClose
      });
    });
    
    // Simulate web AudioContext/MicStream availability
    Object.defineProperty(global, 'navigator', {
      value: { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: vi.fn(() => []) }) } },
      writable: true,
      configurable: true
    });
    global.window = { atob: vi.fn() } as any;
    
    // WebAudio API mocks for MicStream
    global.AudioContext = class { constructor() {} 
      createMediaStreamSource =  vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor =  vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() });
      state =  'running';
      sampleRate =  48000; close = vi.fn().mockResolvedValue(undefined);
    } as any;

    const startPromise = liveSession.start();
    
    // We must flush microtasks to let `api.call` resolve, then `ai.live.connect` to be called
    await vi.runAllTimersAsync();
    
    // Mock the connection opening
    if (onOpenCb!) onOpenCb();
    
    const result = await startPromise;
    expect(result).toBe(true);
    
    // Ensure the token was requested
    expect(api.call).toHaveBeenCalledWith('getLiveToken', {}, 15000);
    
    // Ensure the model was passed to the connect function
    expect(mockConnect).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.8-live'
    }));
    
    // Ensure the assistant UI reflects listening
    // expect(useAssistant.getState().phase).toBe('listening');
  });

  it('extracts incoming PCM and routes to audioManager', async () => {
    let onMessageCb: (msg: any) => void;
    
    vi.mocked(api.call).mockResolvedValueOnce({ token: 'tok', liveModel: 'mod' });
    
    mockConnect.mockImplementationOnce(({ callbacks }) => {
      onMessageCb = callbacks.onmessage;
      callbacks.onopen();
      return Promise.resolve({ sendRealtimeInput: mockSend, close: mockClose });
    });
    
    await liveSession.start();
    
    // Simulate an incoming PCM chunk from Gemini
    const testBase64 = 'YmFzZTY0';
    onMessageCb!({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: testBase64 } }]
        }
      }
    });
    
    expect(audioManager.playPcmChunk).toHaveBeenCalledWith(testBase64, 24000);
    // UI should show it's speaking
    expect(useAssistant.getState().phase).toBe('speaking');
  });
  
  it('preempts audio on interruption', async () => {
    let onMessageCb: (msg: any) => void;
    vi.mocked(api.call).mockResolvedValueOnce({ token: 'tok', liveModel: 'mod' });
    mockConnect.mockImplementationOnce(({ callbacks }) => {
      onMessageCb = callbacks.onmessage;
      callbacks.onopen();
      return Promise.resolve({ sendRealtimeInput: mockSend, close: mockClose });
    });
    
    await liveSession.start();
    
    // Simulate user barge-in via server interrupt signal
    onMessageCb!({
      serverContent: { interrupted: true }
    });
    
    expect(audioManager.interruptPcm).toHaveBeenCalled();
  });
});
