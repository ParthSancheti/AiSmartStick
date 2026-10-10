import { Moon, Sun } from 'lucide-react';
import { toggleThemeWithTransition } from '../../util/theme';
import { useSession } from '../../core/store/session';
import { useUI } from '../../core/store/ui';
import { Atmosphere } from '../../components/Atmosphere';
import { Wordmark } from '../../components/Logo';
import { PhoneFrame } from '../../components/PhoneFrame';
import { DemoPanel } from '../../components/DemoPanel';
import { Segmented } from '../../components/glass';
import { GuardianApp } from '../guardian/GuardianApp';
import { StickUserApp } from '../user/StickUserApp';

/** Desktop demo: both phones live side by side, sharing one simulated world. */
export function Stage() {
  const theme = useSession((s) => s.settings.theme);
  const personName = useSession((s) => s.person.name);
  const heardAs = useSession((s) => s.guardian.heardAs);
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <Atmosphere variant="calm" />
      <header className="relative z-10 flex items-center justify-between gap-4 px-7 py-4">
        <div className="flex items-center gap-4">
          <Wordmark />
          <span className="text-[15px] text-ink-3">Demo mode · simulated hardware</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="w-[380px]">
            <Segmented
              label="View"
              size="sm"
              value="both"
              onChange={(v) => {
                if (v === 'both') return;
                useUI.setState({ layout: 'single' });
                useSession.setState({ entryRole: v === 'guardian' ? 'guardian' : 'user' });
              }}
              options={[
                { value: 'both', label: 'Both phones' },
                { value: 'guardian', label: 'Guardian' },
                { value: 'user', label: 'Stick user' },
              ]}
            />
          </div>
          <button
            type="button"
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={(e) => toggleThemeWithTransition(e)}
            className="glass grid h-10 w-10 place-items-center rounded-full text-ink"
            data-theme-pref={theme}
          >
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>
      <main className="relative z-10 flex min-h-0 flex-1 items-start justify-center gap-7 px-6 pb-4 overflow-x-auto overflow-y-auto">
        <PhoneFrame label={`${personName}'s phone`} sub="Stick user app (Capacitor)">
          <StickUserApp />
        </PhoneFrame>
        <div style={{ height: 'min(860px, calc(100dvh - 150px))' }}>
          <DemoPanel />
        </div>
        <PhoneFrame label={`${heardAs}'s phone`} sub="Guardian app (PWA)">
          <GuardianApp />
        </PhoneFrame>
      </main>
    </div>
  );
}
