import { useEffect, useRef, useState } from 'react';
import { ScanEye } from 'lucide-react';
import { SubPage } from '../../components/Layout';
import { LiveCameraView } from '../../components/LiveCameraView';
import { DetectionBoxes, DetectorStatus } from '../../components/LiveVisionPanel';
import { describeErrorText, streamInfoLine } from '../../components/liveCameraText';
import { useLiveStream } from '../../core/camera/liveStream';
import { useDevice, isLinked } from '../../core/store/device';
import { useRuntime } from '../../core/runtime/mode';
import { useSession } from '../../core/store/session';
import { useAssistant } from '../../core/store/assistant';
import { runVision } from '../../core/ai/executor';
import { runDirect } from '../../core/ai/assistant';
import { speakReply, resolveLang } from '../../core/ai/voiceOut';

/**
 * Full-screen stick camera: the live picture with detection boxes, how it arrives (video or
 * snapshots, fps, size), the object detector state, and "Describe what the camera sees".
 * A SubPage: the hardware back button closes it (core/backStack.ts via SubPageView).
 */
export function CameraView({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <SubPage open={open} onClose={onClose} title="Camera" background="none">
      <LiveCameraView label="Live picture from the stick camera, with detected objects">
        <DetectionBoxes />
      </LiveCameraView>
      <div className="-mt-2 flex flex-col gap-2">
        <StreamInfo />
        <DetectorStatus />
      </div>
      <DescribePanel />
    </SubPage>
  );
}

/** Source, rate and size of the picture. Own selectors: the fps is rounded so this does not re-render per frame. */
function StreamInfo() {
  const linked = useDevice((d) => isLinked(d.link));
  const status = useLiveStream((s) => s.status);
  const source = useLiveStream((s) => s.source);
  const fps = useLiveStream((s) => Math.round(s.fps * 2) / 2);
  const width = useLiveStream((s) => s.width);
  const height = useLiveStream((s) => s.height);
  const hasFrame = useLiveStream((s) => s.frameUrl != null);
  const error = useLiveStream((s) => s.error);
  return (
    <>
      <p className="tabular break-words px-1 text-[14px] font-semibold text-ink-2">{streamInfoLine({ status, source, fps, width, height, hasFrame }, linked)}</p>
      {linked && error && <p className="break-words rounded-[16px] bg-amber/15 px-3 py-2 text-[13px] text-ink-2">{error}</p>}
    </>
  );
}

/** Every wait has an end: the server call itself can hang before its own timeout starts. */
const DESCRIBE_TIMEOUT_MS = 60_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error('describe-timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** One tap: one picture to the assistant, the answer shown here and read aloud (assistant voice). */
function DescribePanel() {
  const linked = useDevice((d) => isLinked(d.link));
  const internet = useDevice((d) => d.internet);
  const demo = useRuntime((s) => s.mode) === 'demo';
  const voiceOn = useSession((s) => s.settings.voiceOut);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  // Bumped on every run and on close: a late answer from an old run (or a closed page) is dropped.
  const runId = useRef(0);
  useEffect(
    () => () => {
      runId.current++;
    },
    [],
  );

  const describe = async () => {
    if (busy) return;
    const id = ++runId.current;
    const lang = resolveLang();
    const finish = (text: string, error: boolean, speak = true) => {
      if (id !== runId.current) return;
      setResult({ text, error });
      setBusy(false);
      if (speak) void speakReply(text, lang, 'vision');
    };
    if (!linked) return finish('The stick is not connected. Connect it to use the camera.', true);
    if (!demo && internet === false) return finish('No internet. The phone needs internet to describe the picture.', true);
    const phase = useAssistant.getState().phase;
    if (phase === 'thinking' || phase === 'vision') return finish('The assistant is busy. Try again in a moment.', true);
    setBusy(true);
    setResult(null);
    try {
      if (demo) {
        // Demo: the simulated assistant answers and speaks by itself.
        await withTimeout(runDirect('describe_scene', 'What is in front of me?'), DESCRIBE_TIMEOUT_MS);
        const reply = useAssistant.getState().reply;
        finish(reply || 'Could not describe the picture. Try again.', !reply, false);
      } else {
        const res = await withTimeout(runVision('describe_scene'), DESCRIBE_TIMEOUT_MS);
        finish(res.spoken, false);
      }
    } catch (e) {
      finish(describeErrorText(e), true);
    }
  };

  return (
    <div className="glass flex flex-col rounded-[28px] p-4">
      <button
        type="button"
        onClick={() => void describe()}
        aria-disabled={busy || undefined}
        className={`flex min-h-16 w-full min-w-0 items-center justify-center gap-3 rounded-[22px] bg-teal px-5 py-3 text-center text-[18px] font-bold leading-snug text-on-teal shadow-[0_10px_24px_-12px_var(--teal)] transition-transform active:scale-[0.98] ${busy ? 'opacity-80' : ''}`}
      >
        {busy ? <span className="block h-6 w-6 shrink-0 animate-spin rounded-full border-[3px] border-current border-t-transparent" aria-hidden /> : <ScanEye size={26} className="shrink-0" aria-hidden />}
        <span className="min-w-0 break-words">{busy ? 'Looking…' : 'Describe what the camera sees'}</span>
      </button>
      {/* Already read aloud when the assistant voice is on; otherwise TalkBack reads it from here. */}
      <div aria-live={voiceOn ? 'off' : 'polite'}>
        {result && (
          <p className={`mt-3 break-words rounded-[20px] px-4 py-3 text-[17px] font-semibold leading-snug ${result.error ? 'bg-amber/15 text-amber-ink' : 'bg-ink/5 text-ink'}`}>{result.text}</p>
        )}
      </div>
      {!result && !busy && (
        <p className="mt-3 px-1 text-[13.5px] leading-snug text-ink-3">{voiceOn ? 'Sends one picture to the assistant. You hear the answer and see it here.' : 'Sends one picture to the assistant. The answer shows here.'}</p>
      )}
    </div>
  );
}
