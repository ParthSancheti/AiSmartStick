import { motion } from 'motion/react';
import { Activity as ActivityIcon, House, Map, ScanEye } from 'lucide-react';
import { useUI, type GuardianTab } from '../../core/store/ui';
import { haptics } from '../../core/feedback/haptics';
import { cx } from '../../components/glass';

const TABS: { id: GuardianTab; label: string; Icon: typeof House }[] = [
  { id: 'home', label: 'Home', Icon: House },
  { id: 'vision', label: 'Vision', Icon: ScanEye },
  { id: 'map', label: 'Map', Icon: Map },
  { id: 'activity', label: 'Logs', Icon: ActivityIcon },
];

export function FloatingNav() {
  const tab = useUI((s) => s.guardianTab);
  
  const go = (t: GuardianTab) => {
    if (t === tab) return;
    haptics.play('tick');
    useUI.setState({ guardianTab: t });
  };

  return (
    <nav aria-label="Main Navigation" className="absolute inset-x-0 bottom-6 z-30 flex justify-center px-4">
      <div className="glass flex items-center gap-1.5 rounded-full p-2 shadow-2xl">
        {TABS.map(({ id, label, Icon }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => go(id)}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'relative flex h-12 items-center justify-center gap-2 rounded-full px-4 text-[14px] font-bold transition-all duration-300 ease-out',
                active ? 'text-teal-ink' : 'text-ink-2 hover:text-ink'
              )}
            >
              {active && (
                <motion.span
                  layoutId="guardian-nav-pill"
                  className="absolute inset-0 rounded-full bg-teal/20 border border-teal/30 shadow-[0_4px_12px_rgba(20,184,166,0.2)]"
                  transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                />
              )}
              <Icon size={20} strokeWidth={active ? 2.5 : 2} className="relative z-10" />
              {active && (
                <motion.span
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 'auto' }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.2 }}
                  className="relative z-10 whitespace-nowrap overflow-hidden"
                >
                  {label}
                </motion.span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
