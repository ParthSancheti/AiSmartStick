import { motion } from 'motion/react';
import { Check, Loader2, ShieldCheck, Siren } from 'lucide-react';
import { useSafety } from '../../core/store/safety';
import { useSession } from '../../core/store/session';
import { cancelSos } from '../../core/safety/sos';
import { BRAND } from '../../core/brand/brand';
import { useLocation } from '../../core/location/locationService';
import { useRuntime } from '../../core/runtime/mode';
import { HoldButton, cx } from '../../components/glass';

function StatusLine({ done, text }: { done: boolean; text: string }) {
  return (
    <li className="flex items-center gap-3 text-[18px] font-semibold">
      <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-full', done ? 'bg-white text-sos-deep' : 'bg-white/20')}>
        {done ? <Check size={18} strokeWidth={3} /> : <Loader2 size={17} className="animate-spin" />}
      </span>
      <span className={done ? 'text-white' : 'text-white/75'}>{text}</span>
    </li>
  );
}

/** Stick user's SOS: solid colour, huge type, and the whole screen cancels during the countdown. */
export function UserSos() {
  const s = useSafety();
  const heardAs = useSession((x) => x.guardian.heardAs) || 'your safety contact';
  const names = heardAs;
  const demo = useRuntime((x) => x.mode) === 'demo';
  const hasLocation = useLocation((x) => !!x.fix) || demo;

  if (s.phase === 'countdown') {
    return (
      <motion.div
        aria-label={`SOS in ${s.countdown} seconds. Press cancel to abort.`}
        className="absolute inset-0 z-[80] flex flex-col items-center justify-between bg-sos px-6 py-12 text-center text-white"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="flex flex-col items-center pt-8">
           <h1 className="text-[32px] font-bold tracking-widest uppercase mb-1">{BRAND.name}</h1>
           <h2 className="text-[40px] font-black tracking-widest uppercase text-white/90">EMERGENCY</h2>
        </div>
        
        <motion.p key={s.countdown} initial={{ scale: 1.25, opacity: 0.4 }} animate={{ scale: 1, opacity: 1 }} className="text-[180px] font-black leading-none tabular my-8" aria-hidden>
          {s.countdown}
        </motion.p>
        
        <div className="flex flex-col items-center w-full gap-4 pb-8">
           <p className="text-[20px] font-bold text-white/80 uppercase tracking-widest">Cancelling SOS...</p>
           <button 
             onClick={(e) => {
               e.stopPropagation();
               cancelSos();
             }}
             className="w-full bg-white text-sos font-black text-[28px] rounded-full h-[80px] flex items-center justify-center uppercase tracking-wider active:scale-95 transition-transform"
           >
             CANCEL SOS
           </button>
        </div>
      </motion.div>
    );
  }

  if (s.phase === 'resolved') {
    return (
      <motion.div className="absolute inset-0 z-[80] grid place-items-center bg-ok px-8 text-center text-white" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} role="status">
        <div>
          <ShieldCheck size={80} className="mx-auto mb-5" strokeWidth={1.6} />
          <p className="text-[34px] font-bold leading-tight">{s.resolvedBy === 'user' ? 'You’re marked safe' : `${heardAs} closed the SOS`}</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      role="alertdialog"
      aria-label="SOS sent"
      className="absolute inset-0 z-[80] flex flex-col bg-sos-deep px-5 pb-5 text-white"
      style={{ paddingTop: 'calc(var(--island, 0px) + 24px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      <div className="flex flex-1 flex-col justify-center">
        <Siren size={56} className="mb-4" />
        <h1 className="text-[40px] font-bold leading-[1.05]">{s.delivery === 'sms' ? 'SOS sent by SMS' : s.delivery === 'pending' ? 'Sending SOS…' : 'SOS sent'}</h1>
        <ul className="mt-6 space-y-3.5">
          <StatusLine done={s.delivery !== 'pending'} text={s.dispatchFailed ? 'Not delivered yet, still trying' : s.delivery === 'pending' ? 'Sending alert…' : s.delivery === 'sms' ? `Text to ${names} (check it was sent)` : 'Alert delivered'} />
          {s.delivery === 'cloud' && !demo && <StatusLine done={s.guardianNotify === 'sent'} text={s.guardianNotify === 'sent' ? `${names}'s phone notified` : s.guardianNotify === 'no_devices' ? `${names} has no phone set up for alerts` : s.guardianNotify === 'failed' ? `Couldn't notify ${names}'s phone` : `Notifying ${names}…`} />}
          <StatusLine done={hasLocation} text={hasLocation ? 'Location shared' : 'Location not available yet'} />
          <StatusLine done={s.guardianAck} text={s.guardianAck ? `${heardAs} has seen it` : `Waiting for ${heardAs}`} />
          {s.guardianOnWay && <StatusLine done text={`${heardAs} is on the way`} />}
        </ul>
      </div>
      <HoldButton label="I'm safe, cancel SOS" holdingLabel="Keep holding" ms={2000} onComplete={cancelSos} className="h-[72px] w-full text-[20px]" />
      <p className="mt-2 text-center text-[15px] text-white/80">Hold for 2 seconds</p>
    </motion.div>
  );
}
