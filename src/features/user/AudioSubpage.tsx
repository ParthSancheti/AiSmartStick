import { Headphones, Volume2, VolumeX, Settings2, Bluetooth, Speaker } from 'lucide-react';
import { useAudioRoute } from '../../core/audio/audioRoute';
import { useSession } from '../../core/store/session';
import { say, useAudio } from '../../core/audio/audioManager';
import { AissNative } from '../../core/native/aissNative';
import { resolveLang } from '../../core/ai/voiceOut';
import { SubPage } from '../../components/Layout';

/**
 * AI SmartStick audio output. Shows the REAL current route (Android AudioManager) and controls
 * only this app's own audio: assistant voice on/off, volume, test. Pairing earbuds happens in
 * Android Bluetooth settings; the app follows whatever route the system picks.
 */
export function AudioSubpage({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <SubPage open={open} onClose={onClose} title="Audio output" background="none" z={100}>
      <AudioContent />
    </SubPage>
  );
}

function AudioContent() {
  const route = useAudioRoute(3000);
  const voiceOut = useSession((x) => x.settings.voiceOut);
  const volume = useSession((x) => x.settings.assistantVolume);
  const update = useSession((x) => x.updateSettings);
  const speaking = useAudio((x) => x.speaking);
  const muted = !voiceOut;
  const showcase = route.route === 'bluetooth' || route.route === 'wired' ? 'earbuds' : route.route === 'speaker' ? 'speaker' : 'none';
  const routeName = route.route === 'bluetooth' ? route.name ?? 'Bluetooth audio' : route.route === 'wired' ? 'Wired headphones' : route.route === 'speaker' ? 'Phone speaker' : 'System default';
  const Icon = route.route === 'bluetooth' ? Bluetooth : showcase === 'speaker' ? Speaker : Headphones;

  return (
    <>
      <div className="glass flex flex-col items-center rounded-[30px] px-5 py-7 text-center">
        <div className="relative grid h-28 w-28 place-items-center">
          {speaking && <span className="audio-ring absolute inset-0 rounded-full border-2 border-info/40" aria-hidden />}
          <span className="grid h-24 w-24 place-items-center rounded-full bg-info/10 text-info">
            <Icon size={46} />
          </span>
        </div>
        {showcase === 'none' ? (
          <>
            <h2 className="mt-4 break-words text-[22px] font-extrabold text-ink">{route.native ? 'Output not reported' : 'This device’s speaker'}</h2>
            <p className="mt-2 text-[14.5px] leading-snug text-ink-2">
              {route.native ? 'Android did not report the current audio route.' : 'Audio routing is controlled by the browser here. In the Android app this shows your earbuds or speaker.'} Earbuds give the most private, clear guidance.
            </p>
          </>
        ) : (
          <>
            <h2 className="mt-4 break-words text-[22px] font-extrabold tracking-tight text-ink">{routeName}</h2>
            <p className="mt-1 text-[13px] font-bold uppercase tracking-wider text-ok">Current output · reported by Android</p>
          </>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <h3 className="px-1 text-[13px] font-bold uppercase tracking-wider text-ink-3">AI SmartStick audio</h3>
        <button type="button" onClick={() => update({ voiceOut: !voiceOut })} className="glass interactive flex min-h-[76px] w-full items-center gap-4 rounded-[24px] px-4 py-3 text-left" aria-pressed={!muted}>
          <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-full ${muted ? 'bg-ink/5 text-ink-2' : 'bg-info/15 text-info'}`}>{muted ? <VolumeX size={24} /> : <Volume2 size={24} />}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] font-bold text-ink">Assistant voice</span>
            <span className={`mt-0.5 block text-[13px] font-bold ${muted ? 'text-ink-3' : 'text-ok'}`}>{muted ? 'Muted (SOS still speaks)' : 'On'}</span>
          </span>
        </button>

        <div className="glass w-full rounded-[24px] p-4">
          <label htmlFor="aiss-vol" className="flex items-center justify-between text-[16px] font-bold text-ink">
            Volume <span className="text-teal tabular">{volume}%</span>
          </label>
          <input id="aiss-vol" type="range" min={0} max={100} step={5} value={volume} onChange={(e) => update({ assistantVolume: Number(e.target.value) })} className="mt-3 h-8 w-full accent-teal" />
          <button type="button" onClick={() => void say('This is how the assistant sounds.', { lang: resolveLang(), priority: 'normal' })} className="mt-3 h-12 w-full rounded-full bg-ink/5 text-[15px] font-bold text-ink active:bg-ink/10">
            Play test sound
          </button>
        </div>

        {route.native && (
          <button type="button" onClick={() => void AissNative.openBluetoothSettings().catch(() => undefined)} className="glass interactive flex min-h-[60px] w-full items-center justify-center gap-3 rounded-[24px] px-4 text-[15.5px] font-bold text-ink">
            <Bluetooth size={20} className="shrink-0" /> <span className="min-w-0">Connect earbuds in Bluetooth settings</span> <Settings2 size={18} className="shrink-0 text-ink-3" />
          </button>
        )}
        <p className="px-1 text-[13px] leading-snug text-ink-3">The stick itself has no speaker. This controls only AI SmartStick speech and sounds, not music or other apps.</p>
      </section>
    </>
  );
}
