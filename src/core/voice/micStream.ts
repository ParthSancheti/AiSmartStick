/**
 * Microphone → 16 kHz mono PCM16 (base64) chunks for the Gemini Live API.
 *
 * Android WebView may ignore the requested AudioContext sample rate (it often runs at 48 kHz), so the
 * actual rate is checked and the signal is resampled to 16 kHz before sending. ~100 ms chunks.
 */
export const LIVE_INPUT_RATE = 16_000;

export function floatToPcm16Base64(input: Float32Array, inRate: number, outRate = LIVE_INPUT_RATE): string {
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // Box-filter downsampling: average the input samples that map onto this output sample.
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio)) || start + 1;
    let acc = 0;
    for (let j = start; j < end; j++) acc += input[j];
    const v = Math.max(-1, Math.min(1, acc / Math.max(1, end - start)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const bytes = new Uint8Array(pcm.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export class MicStream {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  public onData: ((base64: string) => void) | null = null;
  public sampleRate = 0;

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    try {
      this.ctx = new AudioContext({ sampleRate: LIVE_INPUT_RATE });
    } catch {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);
    this.sampleRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // ~100 ms per chunk at the actual rate (power of two required by ScriptProcessor).
    const size = this.sampleRate > 24_000 ? 4096 : 2048;
    this.processor = this.ctx.createScriptProcessor(size, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.onData) return;
      this.onData(floatToPcm16Base64(e.inputBuffer.getChannelData(0), this.sampleRate));
    };
    // ScriptProcessor only runs when connected to the destination; a muted gain keeps the mic silent.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.ctx.destination);
  }

  stop() {
    this.onData = null;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.processor = null;
    this.source = null;
    this.sink = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
