import { useVisionDebug } from '../core/store/visionDebug';
import { useDeviceTrace, type TraceStage } from '../core/device/deviceTrace';
import { useNow } from '../hooks/useNow';
import { LiveCameraView } from './LiveCameraView';

const RUN_TEXT: Record<string, string> = {
  stopped: 'Object detection is off',
  waiting_for_stick: 'Object detection waits for the stick',
  loading_model: 'Loading object detection…',
  running: 'Detecting objects',
  paused: 'Object detection paused',
  error: 'Object detection failed to load',
};

/** Detection results older than this are not drawn: they would sit on the wrong objects. */
const SNAPSHOT_FRESH_MS = 3000;

/**
 * Live stick camera (core/camera/liveStream.ts) with the latest detections and track ids drawn on
 * top, the detector state on its own line, and the hop-by-hop data-flow counters. The picture never
 * waits for the detector: a loading or failed detector only changes the line under it.
 * Everything shown comes from the pipeline itself; nothing is simulated.
 */
export function LiveVisionPanel() {
  return (
    <div className="flex flex-col gap-3">
      <LiveCameraView label="Live picture from the stick camera, with detected objects">
        <DetectionBoxes />
      </LiveCameraView>
      <DetectorStatus />
      <DataFlow />
    </div>
  );
}

/**
 * Detection boxes for a LiveCameraView overlay (normalized 0..1 boxes). Drawn only while the vision
 * snapshot is fresh; otherwise nothing.
 */
export function DetectionBoxes() {
  const snap = useVisionDebug((s) => s.latestSnapshot);
  const now = useNow(1000);
  if (!snap || now - snap.timestamp >= SNAPSHOT_FRESH_MS) return null;
  return (
    <>
      {snap.tracks
        .filter((t) => t.state === 'CONFIRMED' || t.state === 'TENTATIVE')
        .map((t) => (
          <span
            key={t.trackId}
            className={`absolute block rounded-md border-2 ${t.state === 'CONFIRMED' ? 'border-teal' : 'border-amber border-dashed'}`}
            style={{ left: `${t.currentBox.x * 100}%`, top: `${t.currentBox.y * 100}%`, width: `${t.currentBox.w * 100}%`, height: `${t.currentBox.h * 100}%` }}
          >
            {/* Label above the box; inside it when the box touches the top edge. */}
            <span className={`absolute left-0 block whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white ${t.currentBox.y < 0.08 ? 'top-0' : '-top-6'}`}>
              #{t.trackId} {t.label} {Math.round(t.confidence * 100)}%
            </span>
          </span>
        ))}
    </>
  );
}

/** One line: what the object detector is doing, plus its error (if any) in its own box. */
export function DetectorStatus({ className = '' }: { className?: string }) {
  const snap = useVisionDebug((s) => s.latestSnapshot);
  const run = useVisionDebug((s) => s.runState);
  const detErr = useVisionDebug((s) => s.detectorError);
  const frameErr = useVisionDebug((s) => s.lastFrameError);
  const now = useNow(1000);
  const fresh = snap != null && now - snap.timestamp < SNAPSHOT_FRESH_MS;
  const n = fresh && snap ? snap.objects.length : null;
  const dot = run === 'running' ? 'bg-ok' : run === 'error' ? 'bg-sos' : run === 'loading_model' || run === 'waiting_for_stick' ? 'bg-amber' : 'bg-ink-3';
  const err = detErr ?? (run === 'running' ? frameErr : null);
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <p className="flex min-w-0 items-center gap-2 px-1 text-[14px] font-semibold text-ink-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} aria-hidden />
        <span className="min-w-0 break-words">
          {RUN_TEXT[run] ?? run}
          {run === 'running' && n != null ? ` · ${n === 1 ? '1 object' : `${n} objects`}` : ''}
        </span>
      </p>
      {err && <p className="break-words rounded-[16px] bg-amber/15 px-3 py-2 text-[13px] text-ink-2">{err}</p>}
    </div>
  );
}

const FLOW: { stage: TraceStage; label: string }[] = [
  { stage: 'connected', label: 'Connected' },
  { stage: 'packet_received', label: 'Packets received' },
  { stage: 'packet_valid', label: 'Packets valid' },
  { stage: 'telemetry_parsed', label: 'Telemetry parsed' },
  { stage: 'store_updated', label: 'Store updated' },
  { stage: 'button_event', label: 'Button events' },
  { stage: 'frame_received', label: 'Frames received' },
  { stage: 'detector_ran', label: 'Detections run' },
];

/** CONNECTED → PACKET RECEIVED → VALID → PARSED → STORE UPDATED, frames and detector, with ages. */
export function DataFlow() {
  const t = useDeviceTrace();
  const now = useNow(1000);
  return (
    <div className="glass overflow-hidden rounded-[24px] border border-glass-border [&>*+*]:border-t [&>*+*]:border-line">
      {FLOW.map(({ stage, label }) => {
        const last = t.last[stage];
        const live = last != null && now - last < 3000;
        return (
          <div key={stage} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[14px]">
            <span className="flex items-center gap-2 text-ink-2">
              <span className={`h-2 w-2 rounded-full ${live ? 'bg-ok' : last ? 'bg-amber' : 'bg-line'}`} aria-hidden />
              {label}
            </span>
            <span className="tabular font-semibold text-ink">
              {t.counts[stage]}
              <span className="ml-2 text-[12px] font-normal text-ink-3">{last ? `${Math.max(0, Math.round((now - last) / 1000))} s ago` : 'never'}</span>
            </span>
          </div>
        );
      })}
      {(t.counts.packet_rejected > 0 || t.counts.frame_rejected > 0 || t.counts.auth_failed > 0) && (
        <div className="px-4 py-2.5 text-[13px] text-amber-ink">
          Rejected: {t.counts.packet_rejected} packets · {t.counts.frame_rejected} frames · {t.counts.auth_failed} auth{t.lastError ? ` · last: ${t.lastError}` : ''}
        </div>
      )}
    </div>
  );
}
