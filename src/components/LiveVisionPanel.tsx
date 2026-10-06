import { useVisionDebug } from '../core/store/visionDebug';
import { useDeviceTrace, type TraceStage } from '../core/device/deviceTrace';
import { useNow } from '../hooks/useNow';

const RUN_TEXT: Record<string, string> = {
  stopped: 'Vision off',
  waiting_for_stick: 'Waiting for the stick',
  loading_model: 'Loading EfficientDet-Lite0…',
  running: 'Detecting',
  paused: 'Paused',
  error: 'Detector failed to load',
};

/**
 * Real stick camera frame with live EfficientDet detections and track ids, plus the hop-by-hop
 * data-flow counters. Everything shown comes from the pipeline itself; nothing is simulated.
 */
export function LiveVisionPanel() {
  const snap = useVisionDebug((s) => s.latestSnapshot);
  const frame = useVisionDebug((s) => s.debugFrameUrl);
  const run = useVisionDebug((s) => s.runState);
  const detErr = useVisionDebug((s) => s.detectorError);
  const frameErr = useVisionDebug((s) => s.lastFrameError);
  const now = useNow(1000);
  const age = snap ? now - snap.timestamp : null;
  const fresh = age != null && age < 3000;

  return (
    <div className="flex flex-col gap-3">
      <div className="glass relative aspect-[4/3] overflow-hidden rounded-[24px] border border-glass-border bg-black/80">
        {frame ? <img src={frame} alt="Latest frame from the stick camera" className={`h-full w-full object-cover ${fresh ? '' : 'opacity-40 grayscale'}`} /> : null}
        {snap &&
          fresh &&
          snap.tracks
            .filter((t) => t.state === 'CONFIRMED' || t.state === 'TENTATIVE')
            .map((t) => (
              <div
                key={t.trackId}
                className={`absolute rounded-md border-2 ${t.state === 'CONFIRMED' ? 'border-teal' : 'border-amber border-dashed'}`}
                style={{ left: `${t.currentBox.x * 100}%`, top: `${t.currentBox.y * 100}%`, width: `${t.currentBox.w * 100}%`, height: `${t.currentBox.h * 100}%` }}
              >
                <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-bold text-white">
                  #{t.trackId} {t.label} {Math.round(t.confidence * 100)}%
                </span>
              </div>
            ))}
        {!frame && <span className="absolute inset-0 grid place-items-center px-6 text-center text-[15px] font-semibold text-white/70">{RUN_TEXT[run] ?? run}</span>}
        <span className="absolute left-3 top-3 rounded-full bg-black/60 px-2.5 py-1 text-[12px] font-bold text-white">
          {RUN_TEXT[run] ?? run}
          {fresh && snap ? ` · ${snap.objects.length} obj` : ''}
        </span>
      </div>
      {(detErr || (run === 'running' && frameErr)) && <p className="rounded-[16px] bg-amber/15 px-3 py-2 text-[13px] text-ink-2">{detErr ?? frameErr}</p>}
      <DataFlow />
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
