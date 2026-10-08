import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { AnimatePresence } from 'motion/react';
import { Activity, ChevronRight, LocateFixed } from 'lucide-react';
import { SubPageView } from '../../components/Layout';
import { ConnectionTest } from './ConnectionTest';
import { openLocationTest, TEST_PAGE_Z } from './LocationTest';

/**
 * DIAGNOSTICS: the stick Connection test and the Location test, reachable from anywhere
 * (Stick diagnostics on Home, Settings → Stick & hardware, setup). Like LocationTestHost, the
 * Connection test page is rendered by one host mounted in StickUserApp (inside its text-size /
 * high-contrast root), so it opens on top of whichever page asked for it without nesting sub-pages.
 */
export const useConnectionTest = create<{ open: boolean }>(() => ({ open: false }));
export const openConnectionTest = () => useConnectionTest.setState({ open: true });
export const closeConnectionTest = () => useConnectionTest.setState({ open: false });

let nextHostId = 1;
const useHosts = create<{ ids: number[] }>(() => ({ ids: [] }));

/** Mount once (StickUserApp). Duplicate hosts are safe: only the first mounted one renders. */
export function ConnectionTestHost() {
  const [id] = useState(() => nextHostId++);
  useEffect(() => {
    useHosts.setState((s) => ({ ids: [...s.ids, id] }));
    return () => useHosts.setState((s) => ({ ids: s.ids.filter((x) => x !== id) }));
  }, [id]);
  const owner = useHosts((s) => s.ids[0] === id);
  const open = useConnectionTest((s) => s.open);
  if (!owner) return null;
  return (
    <AnimatePresence>
      {open && (
        <div key="conntest" className={`absolute inset-0 ${TEST_PAGE_Z}`}>
          <SubPageView onClose={closeConnectionTest} title="Connection test">
            <ConnectionTest />
          </SubPageView>
        </div>
      )}
    </AnimatePresence>
  );
}

function DiagRow({ icon, iconBg, label, detail, onClick }: { icon: React.ReactNode; iconBg: string; label: string; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="interactive flex min-h-[68px] w-full items-center gap-3 px-4 py-3 text-left">
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${iconBg}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] font-bold text-ink">{label}</span>
        <span className="mt-0.5 block text-[13px] leading-snug text-ink-3">{detail}</span>
      </span>
      <ChevronRight size={20} className="shrink-0 text-ink-3" />
    </button>
  );
}

/** The two diagnostics rows (a glass list). */
export function DiagnosticsRows({ className = '' }: { className?: string }) {
  return (
    <div className={`glass overflow-hidden rounded-[24px] [&>*+*]:border-t [&>*+*]:border-line ${className}`}>
      <DiagRow icon={<Activity size={20} />} iconBg="bg-teal/10 text-teal" label="Connection test" detail="Check every step between phone and stick, with a report to copy" onClick={openConnectionTest} />
      <DiagRow icon={<LocateFixed size={20} />} iconBg="bg-info/10 text-info" label="Location test" detail="Permission, GPS signal and sources, with a report to copy" onClick={openLocationTest} />
    </div>
  );
}
