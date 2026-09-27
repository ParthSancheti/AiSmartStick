import { motion } from 'motion/react';
import { useSession } from '../../core/store/session';
import { haptics } from '../../core/feedback/haptics';
import { Atmosphere } from '../../components/Atmosphere';
import { Wordmark } from '../../components/Logo';
import { useRuntime } from '../../core/runtime/mode';

/**
 * First screen on a new phone. Two halves, because the person holding it may
 * not be able to see: the whole bottom half is one big target for the stick user.
 * (The shipped Stick User app skips this; it only exists in the combined build.)
 */
export function EntryFlow() {
  const choose = (role: 'guardian' | 'user') => {
    haptics.play('success');
    useSession.setState({ entryRole: role });
  };
  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Atmosphere variant="calm" />
      <div className="relative flex flex-1 flex-col px-5 pb-5 pt-4">
        <Wordmark />
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
          aria-label="I use the AI Smart Stick. Tap anywhere in the bottom half."
        >
          <span className="text-[34px] font-bold leading-tight tracking-[-0.02em]">I use the AI Smart Stick</span>
          <span className="mt-1 text-[18px] opacity-90">Tap anywhere here</span>
        </motion.button>
        {useRuntime.getState().mode === 'demo' && <p className="mt-3 text-center text-[13px] text-ink-3">Demo mode: triple-tap the top-left corner, or press D, for demo controls.</p>}
      </div>
    </div>
  );
}
