import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useSession } from '../../core/store/session';
import { haptics } from '../../core/feedback/haptics';
import { Atmosphere } from '../../components/Atmosphere';
import { AppScreen, SafeAreaContent, FloatingHeader } from '../../components/Layout';
import { Wordmark } from '../../components/Logo';
import { useRuntime } from '../../core/runtime/mode';
import { GlassButton, cx } from '../../components/glass';
import { StickVisual } from '../../components/StickVisual';
import { AiOrb } from '../../components/AiOrb';
import { ShieldAlert } from 'lucide-react';

const SLIDES = [
  {
    title: 'Your AI mobility companion',
    body: 'The AI SmartStick helps you navigate the world with confidence using AI voice assistance and obstacle detection.',
  },
  {
    title: 'A friend who sees the street',
    body: 'Ask “what’s in front of me?” in English or Hindi, and the assistant describes your surroundings out loud.',
  },
  {
    title: 'Connected to family',
    body: 'Family members can link their phones to provide remote help, view location, and receive SOS alerts instantly.',
  },
];

export function EntryFlow() {
  const [step, setStep] = useState<'carousel' | 'role'>('carousel');
  const [slide, setSlide] = useState(0);

  const choose = (role: 'guardian' | 'user') => {
    haptics.play('success');
    useSession.setState({ entryRole: role });
  };

  return (
    <AppScreen>
      <Atmosphere variant="calm" />
      
      <AnimatePresence mode="wait">
        <motion.div key={step} className="absolute inset-0 flex flex-col" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.3 }}>
          {step === 'carousel' ? (
            <SafeAreaContent className="px-6 pb-6 pt-10">
              <div className="flex justify-center mb-8 shrink-0">
                <Wordmark />
              </div>
              <div className="grid flex-1 place-items-center mb-8 shrink-0 min-h-[260px]">
                <AnimatePresence mode="wait">
                  <motion.div key={slide} initial={{ opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.3 }} className="grid place-items-center">
                    {slide === 0 && <StickVisual height={230} link="connected" obstacleCm={90} />}
                    {slide === 1 && <AiOrb size={170} phase="speaking" />}
                    {slide === 2 && <ShieldAlert size={140} className="text-sos" strokeWidth={1.5} />}
                  </motion.div>
                </AnimatePresence>
              </div>
              
              <div className="flex justify-center gap-2 pb-6 shrink-0" aria-label={`Slide ${slide + 1} of 3`}>
                {SLIDES.map((_, i) => (
                  <span key={i} className={cx('h-2 rounded-full transition-all', i === slide ? 'w-6 bg-teal' : 'w-2 bg-ink/20')} />
                ))}
              </div>
              
              <div className="shrink-0 text-center mb-8">
                <h1 className="text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-ink">{SLIDES[slide].title}</h1>
                <p className="mt-3 text-[17px] leading-relaxed text-ink-2">{SLIDES[slide].body}</p>
              </div>
              
              <div className="flex gap-3 shrink-0">
                {slide < 2 && (
                  <GlassButton size="lg" className="flex-1" onClick={() => setStep('role')}>
                    Skip
                  </GlassButton>
                )}
                <GlassButton size="lg" variant="teal" className="flex-[2]" onClick={() => (slide < 2 ? setSlide(slide + 1) : setStep('role'))}>
                  {slide < 2 ? 'Next' : 'Get started'}
                </GlassButton>
              </div>
            </SafeAreaContent>
          ) : (
            <SafeAreaContent className="px-5 pb-5 pt-4">
              <FloatingHeader className="pt-4 pb-0 items-center">
                <Wordmark />
              </FloatingHeader>
              <div className="h-12 shrink-0" />
              
              <motion.button
                type="button"
                whileTap={{ scale: 0.98 }}
                onClick={() => choose('guardian')}
                className="glass mt-5 flex flex-1 flex-col justify-end rounded-[34px] p-6 text-left"
              >
                <span className="text-[30px] font-bold leading-tight tracking-[-0.02em] text-ink">I'm family</span>
                <span className="mt-1 text-[17px] text-ink-2">Set up the stick and look after someone</span>
              </motion.button>
              
              <motion.button
                type="button"
                whileTap={{ scale: 0.98 }}
                onClick={() => choose('user')}
                className="mt-3 flex flex-[1.3] flex-col justify-end rounded-[34px] bg-teal p-6 text-left text-on-teal shadow-[0_24px_50px_-24px_var(--teal)]"
                aria-label="I use the AI SmartStick. Tap anywhere in the bottom half."
              >
                <span className="text-[34px] font-bold leading-tight tracking-[-0.02em]">I use the AI SmartStick</span>
                <span className="mt-1 text-[18px] opacity-90">Tap anywhere here</span>
              </motion.button>
              
              {useRuntime.getState().mode === 'demo' && <p className="mt-3 text-center text-[13px] text-ink-3 shrink-0">Demo mode: triple-tap the top-left corner, or press D, for demo controls.</p>}
            </SafeAreaContent>
          )}
        </motion.div>
      </AnimatePresence>
    </AppScreen>
  );
}
