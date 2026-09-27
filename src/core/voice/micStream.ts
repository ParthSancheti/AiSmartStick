export class MicStream {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  public onData: ((base64: string) => void) | null = null;

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    } });
    
    this.ctx = new AudioContext({ sampleRate: 16000 });
    const source = this.ctx.createMediaStreamSource(this.stream);
    
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const pcmFloat = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(pcmFloat.length);
      for (let i = 0; i < pcmFloat.length; i++) {
        let s = Math.max(-1, Math.min(1, pcmFloat[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      if (this.onData) {
        // Convert to base64
        let binary = '';
        const bytes = new Uint8Array(pcm16.buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        this.onData(btoa(binary));
      }
    };

    source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
  }

  stop() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
  }
}
