import { useAssistant } from '../core/store/assistant';
import { startListening, cancelListening, submitUtterance, simulateSpeech } from '../core/ai/assistant';
import { recognitionSupported } from '../core/voice/recognition';

/**
 * React face of the assistant. The engine lives in core/ai/assistant.ts so the
 * physical stick button can drive it even when no screen is mounted.
 */
export function useVoiceAssistant() {
  const phase = useAssistant((s) => s.phase);
  const heard = useAssistant((s) => s.heard);
  const reply = useAssistant((s) => s.reply);
  const card = useAssistant((s) => s.card);
  const lang = useAssistant((s) => s.lang);
  const unavailable = useAssistant((s) => s.unavailable);
  return {
    unavailable,
    phase,
    heard,
    reply,
    card,
    lang,
    start: startListening,
    cancel: cancelListening,
    submit: submitUtterance,
    simulate: simulateSpeech,
    micSupported: recognitionSupported(),
  };
}
