import { GoogleGenAI } from '@google/genai';
import { call } from '../backend/api';
import { TOOLS } from '../../../shared/tools';
import { toGeminiParameters } from '../../../shared/validate';
import { useAssistant, pushThread } from '../store/assistant';
import { MicStream } from '../voice/micStream';
import { executeAction } from './executor';
import { speakReply } from './voiceOut';

export class LiveSession {
  private ai: GoogleGenAI | null = null;
  private session: any = null;
  private mic: MicStream | null = null;
  private active = false;
  private transcriptBuffer = '';

  async start() {
    if (this.active) return;
    this.active = true;
    useAssistant.setState({ phase: 'thinking', unavailable: null });

    try {
      const config = await call('getLiveToken', {}) as { token: string, liveModel: string };
      this.ai = new GoogleGenAI({ apiKey: config.token, httpOptions: { apiVersion: 'v1alpha' } });

      const tools = [{ 
        functionDeclarations: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiParameters(t.params) as any
        }))
      }];

      this.session = await this.ai.live.connect({
        model: config.liveModel,
        config: {
          generationConfig: {
            responseModalities: ["AUDIO"] as any
          },
          systemInstruction: { parts: [{ text: "You are the AI Smart Stick voice assistant. Answer briefly. You are in a Live Session." }] },
          tools: tools as any
        },
        callbacks: {
          onmessage: async (msg) => {
            const outTranscript = msg.serverContent?.outputTranscription;
            if (outTranscript && outTranscript.text) {
              this.transcriptBuffer += outTranscript.text;
            }
            if ((outTranscript?.finished || msg.serverContent?.turnComplete) && this.transcriptBuffer.trim()) {
              const text = this.transcriptBuffer.trim();
              pushThread('assistant', text);
              speakReply(text, useAssistant.getState().lang, 'user');
              this.transcriptBuffer = '';
            }

            const parts = msg.serverContent?.modelTurn?.parts;
            if (parts) {
              // Ignore part.text as we use outputTranscription for speech
              // Ignore part.inlineData (audio) as we don't play native audio
            }
            const calls = msg.toolCall?.functionCalls;
            if (calls) {
              const results = [];
              for (const c of calls) {
                const spec = TOOLS.find(t => t.name === c.name);
                if (spec) {
                  const callId = c.id || 'unknown';
                  const callName = c.name || 'unknown';
                  const out = await executeAction({ id: callId, name: callName as any, type: spec.type, arguments: c.args as any });
                  results.push({
                    id: callId,
                    name: callName,
                    response: out.ok ? { result: out.data } : { error: out.error }
                  });
                }
              }
              if (results.length > 0) {
                this.session.send({ toolResponse: { functionResponses: results } });
              }
            }
          },
          onerror: (err) => {
            console.error('LiveSession error:', err);
            this.stop();
          },
          onclose: () => {
            this.stop();
          }
        }
      });

      this.mic = new MicStream();
      this.mic.onData = (base64) => {
        if (this.active && this.session) {
          this.session.send({ realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64 }] } });
        }
      };
      await this.mic.start();
      useAssistant.setState({ phase: 'listening' });
    } catch (e) {
      console.error(e);
      useAssistant.setState({ phase: 'error', unavailable: 'Could not connect to Live API' });
      this.stop();
    }
  }

  stop() {
    this.active = false;
    this.transcriptBuffer = '';
    if (this.mic) {
      this.mic.stop();
      this.mic = null;
    }
    if (this.session) {
      this.session = null;
    }
    useAssistant.setState({ phase: 'idle' });
  }
}

export const liveSession = new LiveSession();
