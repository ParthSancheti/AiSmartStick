import { AnimatePresence, motion } from 'motion/react';
import { Eye, Info, Link2, MessageCircle, PhoneOff } from 'lucide-react';
import { useUI } from '../../core/store/ui';
import { endCall } from '../../core/phone';
import { useNow } from '../../hooks/useNow';
import { announce } from '../../core/ai/voiceOut';
import { P } from '../../core/ai/phrases';
import { cx } from '../../components/glass';

const ICONS = { eye: Eye, message: MessageCircle, link: Link2, info: Info };

export function UserBanner() {
  const b = useUI((s) => s.userBanner);
  return (
    <div className="pointer-events-none absolute inset-x-3 z-[70]" style={{ top: 'calc(var(--island, var(--sat)) + 6px)' }}>
      <AnimatePresence>
        {b && (
          <motion.div
            key={b.id}
            role="status"
            initial={{ transform: 'translate3d(0,-30px,0)', opacity: 0 }}
            animate={{ transform: 'translate3d(0,0,0)', opacity: 1 }}
            exit={{ transform: 'translate3d(0,-30px,0)', opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            className={cx(
              'flex items-start gap-3 rounded-[24px] px-4 py-3.5 shadow-[0_18px_40px_-18px_rgba(0,0,0,.5)]',
              b.tone === 'teal' ? 'bg-teal text-on-teal' : b.tone === 'amber' ? 'bg-amber text-[#2b1a00]' : 'chip-solid',
            )}
          >
            {(() => {
              const I = ICONS[b.icon];
              return <I size={24} className="mt-0.5 shrink-0" />;
            })()}
            <div className="min-w-0">
              <p className="text-[18px] font-bold leading-snug">{b.title}</p>
              {b.body && <p className="mt-0.5 text-[16px] leading-snug opacity-90">{b.body}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function CallOverlay() {
  const call = useUI((s) => s.call);
  return (
    <AnimatePresence>
      {call && (
        <motion.div
          className="absolute inset-0 z-[72] flex flex-col items-center justify-between bg-[#0c1d24] px-6 pb-10 text-white"
          style={{ paddingTop: 'calc(var(--island, var(--sat)) + 60px)' }}
          initial={{ opacity: 0, transform: 'translate3d(0,30px,0)' }}
          animate={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
          exit={{ opacity: 0, transform: 'translate3d(0,30px,0)' }}
          transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          role="dialog"
          aria-label={`Call with ${call.name}`}
        >
          <div className="text-center">
            <div className="mx-auto mb-5 grid h-28 w-28 place-items-center rounded-full bg-teal text-[44px] font-bold">{call.name[0]}</div>
            <p className="text-[34px] font-bold">{call.name}</p>
            <CallTimer startedAt={call.startedAt} />
          </div>
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                endCall();
                announce(P.callEnded);
              }}
              aria-label="End call"
              className="mx-auto grid h-24 w-24 place-items-center rounded-full bg-sos"
            >
              <PhoneOff size={40} />
            </button>
            <p className="mt-3 text-[17px] text-white/75">Or press the stick button once</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** The 1 s clock runs only while a call is on screen (not for the whole app lifetime). */
function CallTimer({ startedAt }: { startedAt: number }) {
  const now = useNow(1000);
  const text =
    now - startedAt < 2500
      ? 'Calling…'
      : (() => {
          const s = Math.floor((now - startedAt - 2500) / 1000);
          return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
        })();
  return (
    <p className="mt-1 text-[19px] text-white/70 tabular" aria-live="polite">
      {text}
    </p>
  );
}
