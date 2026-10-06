import { loopEarcon } from '../feedback/earcons';
import { GoogleGenAI } from '@google/genai';
import { call } from '../backend/api';
import { TOOLS } from '../../../shared/tools';
import { toGeminiParameters } from '../../../shared/validate';
import { useAssistant, pushThread } from '../store/assistant';
import { MicStream } from '../voice/micStream';
import { executeAction } from './executor';
import * as audioManager from '../audio/audioManager';

let stopConnectingTone = () => {};
export class LiveSession {
  private ai: GoogleGenAI | null = null;
  private session: any = null;
  private mic: MicStream | null = null;
  private active = false;
  private transcriptBuffer = '';

  async start() {
    if (this.active) return true;
    this.active = true;
    useAssistant.setState({ phase: 'thinking', unavailable: null });

    try {
      const config = await call('getLiveToken', {}, 15000) as { token: string, liveModel: string };
      this.ai = new GoogleGenAI({ apiKey: config.token, httpOptions: { apiVersion: 'v1alpha' } });

      const tools = [{ 
        functionDeclarations: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiParameters(t.params) as any
        }))
      }];

      
      try { stopConnectingTone = loopEarcon('connecting'); } catch(e){}
      this.session = await this.ai.live.connect({
        model: "gemini-3.8-live", // Requested by user
        config: {
          generationConfig: {
            responseModalities: ["AUDIO"] as any
          },
          systemInstruction: { parts: [{ text: `You are the AI SmartStick voice assistant. Answer briefly.
You are in a Live Session. 
When the user asks for directions or to go somewhere:
1. Call search_place or find_nearest_place to find the destination.
2. Tell the user the found destination and distance, and ask "Should I take you there?" or "Should I start navigation?".
3. Wait for the user to say yes.
4. If they confirm, call start_navigation. DO NOT search again if you already found it.` }] },
          tools: tools as any
        },
        callbacks: {
          onopen: () => { stopConnectingTone(); },
          onmessage: async (msg) => {
            if (msg.serverContent?.interrupted) {
              audioManager.interruptPcm();
            }

            const outTranscript = msg.serverContent?.outputTranscription;
            if (outTranscript && outTranscript.text) {
              this.transcriptBuffer += outTranscript.text;
            }
            if ((outTranscript?.finished || msg.serverContent?.turnComplete) && this.transcriptBuffer.trim()) {
              const text = this.transcriptBuffer.trim();
              pushThread('assistant', text);
              this.transcriptBuffer = '';
            }

            const parts = msg.serverContent?.modelTurn?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  if (useAssistant.getState().phase !== 'speaking') {
                    useAssistant.setState({ phase: 'speaking' });
                  }
                  audioManager.playPcmChunk(part.inlineData.data, 24000);
                }
              }
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
                if (typeof this.session.sendToolResponse === 'function') {
                  this.session.sendToolResponse({ functionResponses: results });
                } else {
                  this.session.send({ toolResponse: { functionResponses: results } });
                }
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
          if (typeof this.session.sendRealtimeInput === 'function') {
            this.session.sendRealtimeInput([{ mimeType: 'audio/pcm;rate=16000', data: base64 }]);
          } else {
            this.session.send({ realtimeInput: { mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data: base64 }] } });
          }
        }
      };
      await this.mic.start();
      useAssistant.setState({ phase: 'listening' });
      return true;
    } catch (e) {
      console.error(e);
      stopConnectingTone();
        useAssistant.setState({ phase: 'error', unavailable: 'Could not connect to Live API' });
      this.stop();
      return false;
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
      if (typeof this.session.close === 'function') {
        this.session.close();
      }
      this.session = null;
    }
    useAssistant.setState({ phase: 'idle' });
  }
}

export const liveSession = new LiveSession();
