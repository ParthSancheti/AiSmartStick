import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Atmosphere } from '../../components/Atmosphere';
import { ChevronLeft, Mic, StopCircle } from 'lucide-react';
import { useVoiceAssistant } from '../../hooks/useVoiceAssistant';
import { useSafety } from '../../core/store/safety';
import { useDevice } from '../../core/store/device';
import { useNavView } from '../../core/navigation/navView';
import { AiOrb, orbPhaseFor } from '../../components/AiOrb';
import { log } from '../../core/log';

function OneLineCaption({ text, phase }: { text: string; phase: string }) {
  const [display, setDisplay] = useState('');
  
  useEffect(() => {
    if (!text || (phase !== 'speaking' && phase !== 'listening' && phase !== 'thinking' && phase !== 'error')) {
      setDisplay('');
      return;
    }
    const punctuationRegex = /([.?!,;:]s+)/;
    const parts = text.split(punctuationRegex);
    let lastPhrase = text;
    if (parts.length > 2) {
      lastPhrase = parts.slice(-2).join('').trim();
      if (!lastPhrase) lastPhrase = parts.slice(-4).join('').trim();
    }
    if (lastPhrase.length > 50) {
      const words = lastPhrase.split(' ');
      lastPhrase = words.slice(-8).join(' ');
    }
    setDisplay(lastPhrase.trim());
  }, [text, phase]);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: display ? 1 : 0, y: display ? 0 : 10 }}
      transition={{ duration: 0.3 }}
      className="text-[24px] font-medium text-ink leading-tight text-center px-8 min-h-[32px] overflow-hidden whitespace-nowrap text-ellipsis"
    >
      {display}
    </motion.div>
  );
}

export function LiveAiSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ai = useVoiceAssistant();
  const sosPhase = useSafety().phase;
  const netState = useDevice().internet;
  const navActive = useNavView().active;
  
  useEffect(() => {
    if (open) {
      log.info('[LIVE] pageOpened');
      if (ai.phase === 'idle' && !ai.unavailable) {
        ai.start();
      }
    } else {
      ai.cancel();
    }
  }, [open]);

  let visualState = 'idle';
  let subtitle = '';
  
  if (ai.phase === 'thinking') {
    visualState = 'connecting';
    subtitle = ai.reply || 'Connecting...';
  } else if (ai.phase === 'listening') {
    visualState = 'listening';
    subtitle = ai.heard || 'Listening...';
  } else if (ai.phase === 'speaking') {
    visualState = 'speaking';
    subtitle = ai.reply || 'Speaking...';
  } else if (ai.phase === 'error' || ai.unavailable) {
    visualState = 'error';
    subtitle = ai.unavailable ? `Failed: ${ai.unavailable}` : 'Connection lost. Tap to fix.';
  }

  const orbPhase = orbPhaseFor({ assistant: ai.phase, sosActive: sosPhase === 'active' || sosPhase === 'countdown', internet: netState, navigating: navActive, unavailable: ai.unavailable });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 1.05 }}
          transition={{ duration: 0.4, type: 'spring', damping: 25, stiffness: 200 }}
          className="absolute inset-0 z-[100] bg-bg flex flex-col justify-between overflow-hidden"
        >
          {/* Ambient GPU-friendly Animated Background */}
          <Atmosphere variant="user" />

          {/* Top Bar */}
          <div className="relative z-50 pointer-events-auto pt-[calc(env(safe-area-inset-top)+16px)] mt-8 px-4 flex items-center gap-4 w-full">
            <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0 hover:bg-black/5 transition-colors">
              <ChevronLeft size={24} />
            </button>
            <h1 className="text-[28px] font-bold tracking-[-0.02em] text-ink">Assistant</h1>
          </div>

          {/* Central AI Visual */}
          <div className="relative z-20 flex-1 flex flex-col items-center justify-center -mt-10">
            <motion.div
              animate={{ 
                scale: visualState === 'connecting' ? [0.95, 1.05, 0.95] : visualState === 'listening' ? 1.05 : 1,
              }}
              transition={{ duration: visualState === 'connecting' ? 1.5 : 0.5, repeat: visualState === 'connecting' ? Infinity : 0 }}
              className="relative interactive"
              onClick={() => {
                if (visualState === 'error') ai.start();
                else if (ai.phase === 'listening' || ai.phase === 'speaking') ai.cancel();
                else if (ai.phase === 'idle') ai.start();
              }}
            >
              <AnimatePresence>
                {visualState === 'listening' && (
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1.2 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ duration: 0.4 }}
                    className="absolute inset-[-30px] rounded-full border border-teal/40 shadow-[0_0_30px_rgba(45,212,191,0.2)]"
                  />
                )}
              </AnimatePresence>
              
              <AiOrb size={220} phase={orbPhase} />
            </motion.div>
            
            <div className="h-20 flex items-center justify-center mt-12 w-full">
              <OneLineCaption text={subtitle} phase={ai.phase} />
            </div>
          </div>

          {/* Bottom Control / Status */}
          <div className="relative z-10 w-full pb-[calc(env(safe-area-inset-bottom)+2rem)] flex flex-col items-center">
            {visualState === 'error' ? (
              <button 
                onClick={() => ai.start()}
                className="glass border border-glass-border text-ink hover:bg-black/5 px-8 py-3 rounded-full font-bold backdrop-blur-md transition-all active:scale-95"
              >
                Tap to Reconnect
              </button>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <button 
                  onClick={() => ai.phase === 'listening' || ai.phase === 'speaking' || ai.phase === 'thinking' ? ai.cancel() : ai.start()}
                  className={`w-[64px] h-[64px] rounded-full flex items-center justify-center transition-all shadow-[0_0_30px_rgba(0,0,0,0.5)] backdrop-blur-md interactive border ${ai.phase === 'listening' ? 'bg-sos/20 border-sos/50 text-sos hover:bg-sos/30' : 'glass border-glass-border text-ink hover:bg-black/5'}`}
                >
                  {ai.phase === 'listening' || ai.phase === 'speaking' || ai.phase === 'thinking' ? <StopCircle size={28} /> : <Mic size={28} />}
                </button>
                <span className="text-[12px] font-medium tracking-wide text-ink-3 uppercase">
                  {visualState === 'connecting' ? 'Connecting...' : visualState === 'listening' ? 'Listening' : visualState === 'speaking' ? 'Speaking' : 'Tap to talk'}
                </span>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
