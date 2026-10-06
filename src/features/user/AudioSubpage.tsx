import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, Headphones, Volume2, VolumeX, Settings2, Bluetooth } from 'lucide-react';
import { useAudioRoute } from '../../core/audio/audioRoute';
import { useSession } from '../../core/store/session';
import { say, useAudio } from '../../core/audio/audioManager';
import { AissNative } from '../../core/native/aissNative';
import { resolveLang } from '../../core/ai/voiceOut';
import { Atmosphere } from '../../components/Atmosphere';

const Cool3DHeadphone = () => (
  <motion.div 
    className="relative w-32 h-32 flex items-center justify-center"
    style={{ transformStyle: 'preserve-3d' }}
    animate={{ rotateY: [0, 360], rotateX: [5, -5, 5] }}
    transition={{ rotateY: { duration: 8, repeat: Infinity, ease: 'linear' }, rotateX: { duration: 4, repeat: Infinity, ease: 'easeInOut' } }}
  >
    {/* Center band */}
    <div className="absolute w-20 h-24 border-t-8 border-l-8 border-r-8 border-white rounded-t-[50px] drop-shadow-[0_0_15px_rgba(255,255,255,0.5)]" style={{ transform: 'translateZ(0px)' }} />
    {/* Left Cup */}
    <div className="absolute left-[12px] bottom-[10px] w-8 h-14 bg-gradient-to-br from-info to-teal rounded-[12px] shadow-[0_0_20px_var(--teal)]" style={{ transform: 'translateZ(12px) rotateY(-20deg)' }} />
    <div className="absolute left-[18px] bottom-[12px] w-6 h-10 bg-black/60 rounded-[8px]" style={{ transform: 'translateZ(15px) rotateY(-20deg)' }} />
    {/* Right Cup */}
    <div className="absolute right-[12px] bottom-[10px] w-8 h-14 bg-gradient-to-br from-info to-teal rounded-[12px] shadow-[0_0_20px_var(--teal)]" style={{ transform: 'translateZ(-12px) rotateY(20deg)' }} />
    <div className="absolute right-[18px] bottom-[12px] w-6 h-10 bg-black/60 rounded-[8px]" style={{ transform: 'translateZ(-15px) rotateY(20deg)' }} />
  </motion.div>
);

const Cool3DSpeaker = () => (
  <motion.div 
    className="relative w-32 h-32 flex items-center justify-center"
    style={{ transformStyle: 'preserve-3d' }}
    animate={{ rotateY: [0, 360], scale: [1, 1.05, 1] }}
    transition={{ rotateY: { duration: 10, repeat: Infinity, ease: 'linear' }, scale: { duration: 0.6, repeat: Infinity, ease: 'easeInOut' } }}
  >
    {/* Speaker Box */}
    <div className="absolute w-20 h-28 bg-gradient-to-br from-ink to-ink rounded-[16px] shadow-[0_0_30px_rgba(0,0,0,0.8)] border border-ink" style={{ transform: 'translateZ(10px)' }} />
    <div className="absolute w-20 h-28 bg-ink-3 rounded-[16px]" style={{ transform: 'translateZ(-10px)' }} />
    {/* Main Woofer */}
    <div className="absolute w-12 h-12 rounded-full bg-black border-[3px] border-ink top-[15px]" style={{ transform: 'translateZ(12px)' }} />
    <div className="absolute w-5 h-5 rounded-full bg-ink-3 top-[28px]" style={{ transform: 'translateZ(14px)' }} />
    {/* Tweeter */}
    <div className="absolute w-6 h-6 rounded-full bg-black border-2 border-ink bottom-[20px]" style={{ transform: 'translateZ(12px)' }} />
  </motion.div>
);

/**
 * AI SmartStick audio output. Shows the REAL current route (Android AudioManager) and controls
 * only this app's own audio: assistant voice on/off, volume, test. Pairing earbuds happens in
 * Android Bluetooth settings; the app follows whatever route the system picks.
 */
export function AudioSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const route = useAudioRoute(3000);
  const s = useSession((x) => x.settings);
  const update = useSession((x) => x.updateSettings);
  const speaking = useAudio((x) => x.speaking);
  const muted = !s.voiceOut;
  const showcase = route.route === 'bluetooth' || route.route === 'wired' ? 'earbuds' : route.route === 'speaker' ? 'speaker' : 'none';
  const routeName = route.route === 'bluetooth' ? route.name ?? 'Bluetooth audio' : route.route === 'wired' ? 'Wired headphones' : route.route === 'speaker' ? 'Phone speaker' : 'System default';

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          className="absolute inset-0 z-[100] bg-bg flex flex-col pointer-events-auto"
        >
          <Atmosphere variant="user" />

          <div className="px-4 pb-8 flex-1 flex flex-col overflow-y-auto no-scrollbar" style={{ paddingTop: 'calc(var(--island, 0px) + 12px)' }}>
            <div className="mb-5 mt-8 flex items-center gap-4 z-10 shrink-0">
              <button onClick={onClose} className="h-12 w-12 glass interactive rounded-full flex items-center justify-center text-ink shrink-0" aria-label="Back">
                <ChevronLeft size={24} />
              </button>
              <h1 className="text-[28px] font-bold tracking-[-0.02em] text-ink">Audio Output</h1>
            </div>

            <div className="flex-1 flex flex-col relative z-10">
            {showcase === 'none' ? (
               <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
                 <div className="w-24 h-24 rounded-full bg-info/10 text-info flex items-center justify-center mb-6">
                   <Headphones size={48} />
                 </div>
                 <h2 className="text-2xl font-extrabold text-ink mb-2">{route.native ? 'Output not reported' : 'Using this device’s speaker'}</h2>
                 <p className="text-ink-2 mb-8">{route.native ? 'Android did not report the current audio route.' : 'Audio routing is controlled by the browser here. In the Android app this shows your earbuds or speaker.'} Earbuds give the most private, clear guidance.</p>
               </div>
            ) : (
               <div className="flex-1 flex flex-col">
                  <div className="flex-1 flex flex-col items-center justify-center">
                    <div className="relative w-64 h-64 flex items-center justify-center">
                      {speaking && (
                        <>
                          <motion.div className="absolute inset-0 rounded-full border-2 border-info/30" animate={{ scale: [1, 1.5, 2], opacity: [0.8, 0.4, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }} />
                          <motion.div className="absolute inset-4 rounded-full border-2 border-info/40" animate={{ scale: [1, 1.5, 2], opacity: [0.8, 0.4, 0] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeOut', delay: 0.5 }} />
                        </>
                      )}
                      <div className="w-40 h-40 rounded-[32px] glass flex items-center justify-center z-10 border border-info/30 shadow-[0_20px_60px_-20px_var(--info)] bg-info/10 backdrop-blur-md" style={{ perspective: 1000 }}>
                        {showcase === 'earbuds' ? <Cool3DHeadphone /> : <Cool3DSpeaker />}
                      </div>
                    </div>
                    <div className="text-center mt-4 space-y-2">
                      <h2 className="text-2xl font-extrabold text-ink tracking-tight">{routeName}</h2>
                      <p className="text-ok font-bold uppercase tracking-wider text-[14px]">Current output · reported by Android</p>
                    </div>
                  </div>
               </div>
            )}

            <div className="flex flex-col gap-3 mt-8">
               <h3 className="text-sm font-bold text-ink-3 uppercase tracking-wider mb-2 pl-2">AI SmartStick audio</h3>

               <button type="button" onClick={() => update({ voiceOut: !s.voiceOut })} className="glass w-full rounded-[24px] p-5 flex items-center justify-between border border-glass-border interactive">
                 <div className="flex items-center gap-4">
                   <div className={`w-12 h-12 rounded-full flex items-center justify-center ${muted ? 'bg-ink/5 text-ink-2' : 'bg-info/20 text-info'}`}>{muted ? <VolumeX size={24} /> : <Volume2 size={24} />}</div>
                   <div className="text-left">
                     <p className="font-bold text-ink text-[16px]">Assistant voice</p>
                     <p className={`${muted ? 'text-ink-3' : 'text-ok'} text-[13px] font-bold mt-0.5`}>{muted ? 'Muted (SOS still speaks)' : 'On'}</p>
                   </div>
                 </div>
               </button>

               <div className="glass w-full rounded-[24px] p-5 border border-glass-border">
                 <label htmlFor="aiss-vol" className="flex items-center justify-between text-[16px] font-bold text-ink">Volume <span className="text-teal">{s.assistantVolume}%</span></label>
                 <input id="aiss-vol" type="range" min={0} max={100} step={5} value={s.assistantVolume} onChange={(e) => update({ assistantVolume: Number(e.target.value) })} className="mt-3 w-full accent-teal" />
                 <button type="button" onClick={() => void say('This is how the assistant sounds.', { lang: resolveLang(), priority: 'normal' })} className="mt-3 w-full h-11 rounded-full bg-ink/5 text-[15px] font-bold text-ink interactive">Play test sound</button>
               </div>

               {route.native && (
                 <button type="button" onClick={() => void AissNative.openBluetoothSettings().catch(() => undefined)} className="glass flex items-center justify-center gap-3 w-full h-[64px] rounded-[24px] font-bold text-[16px] text-ink interactive border border-glass-border shadow-sm">
                   <Bluetooth size={20} /> Connect earbuds in Bluetooth settings <Settings2 size={18} className="text-ink-3" />
                 </button>
               )}
               <p className="px-2 text-[13px] leading-snug text-ink-3">The stick itself has no speaker. This controls only AI SmartStick speech and sounds, not music or other apps.</p>
            </div>
          </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
