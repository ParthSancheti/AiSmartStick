import { useEffect, useState } from 'react';
import { useVisionDebug } from '../../core/store/visionDebug';
import { useWalkingGuidance } from '../../core/guidance/guidanceState';

export function DetectionDebugView({ onClose }: { onClose: () => void }) {
  const snap = useVisionDebug((s) => s.latestSnapshot);
  const debugFrameUrl = useVisionDebug((s) => s.debugFrameUrl);
  const runState = useVisionDebug((s) => s.runState);
  const detectorStatus = useVisionDebug((s) => s.detectorStatus);
  const detectorError = useVisionDebug((s) => s.detectorError);
  const frameError = useVisionDebug((s) => s.lastFrameError);
  const guidance = useWalkingGuidance();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden) setNow(Date.now()); }, 100);
    return () => clearInterval(id);
  }, []);

  if (!snap) {
    return (
      <div className="absolute inset-0 z-[200] flex flex-col bg-black text-green-400 font-mono text-[10px] p-2 overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <div className="text-sm font-bold text-white bg-red-600 px-2">DETECTION ENGINE DEBUG</div>
          <button onClick={onClose} className="px-3 py-1 bg-gray-800 text-white border border-gray-600 uppercase">Close</button>
        </div>
        <div>STATE: {runState.toUpperCase()} · DETECTOR: {detectorStatus.toUpperCase()}</div>
        {detectorError && <div className="mt-2 text-red-400">DETECTOR ERROR: {detectorError}</div>}
        {frameError && <div className="mt-2 text-amber-300">LAST FRAME ERROR: {frameError}</div>}
        <div className="mt-2">WAITING FOR FIRST SNAPSHOT...</div>
        <div className="mt-2">LOCAL PLAN: {guidance.plan} · ROUTE HOLD: {guidance.routeHold ? 'YES' : 'NO'}</div>
        <div>FRESH FORWARD RANGE: {guidance.frontDistanceCm ?? 'UNKNOWN'} cm</div>
      </div>
    );
  }

  const { metrics, frameWidth, frameHeight } = snap as any;
  const ctx = snap.sensorContext;
  
  // Calculate inference FPS
  const infFps = metrics?.inferenceFps?.toFixed(1) ?? '0.0';
  const processingAge = now - snap.timestamp;
  const frameAge = snap.frameTimestamp ? now - snap.frameTimestamp : 0;

  return (
    <div className="absolute inset-0 z-[200] flex flex-col bg-black text-green-400 font-mono text-[10px] p-2 overflow-y-auto leading-tight pointer-events-auto select-none">
      <div className="flex justify-between items-center mb-2 shrink-0 border-b border-green-800 pb-1">
        <div className="font-bold text-white bg-red-600 px-2 py-0.5">SMARTSTICK DETECTION DEBUG</div>
        <button onClick={onClose} className="px-3 py-1 bg-gray-800 text-white border border-gray-600 uppercase text-xs">Close</button>
      </div>

      <div className="mb-3">
        <div className="text-white border-b border-green-800 mb-1">CAMERA</div>
        <div className="grid grid-cols-2 gap-x-2">
          <div>STATUS</div><div>{snap.frameTimestamp ? 'CONNECTED' : 'DISCONNECTED'}</div>
          <div>RESOLUTION</div><div>{frameWidth && frameHeight ? `${frameWidth}x${frameHeight}` : 'UNKNOWN'}</div>
          <div>FPS</div><div>{metrics?.effectiveFps.toFixed(1) ?? '0.0'}</div>
          <div>LATENCY</div><div>{Math.round(metrics?.captureLatency ?? 0)}ms</div>
          <div>DROPPED</div><div>{metrics?.droppedFrames ?? 0}</div>
          <div>FRAME AGE</div><div>{frameAge}ms</div>
        </div>
      </div>
      
      <div className="mb-3">
        <div className="text-white border-b border-green-800 mb-1">DETECTOR</div>
        <div className="grid grid-cols-2 gap-x-2">
          <div>WORKER</div><div>{detectorStatus.toUpperCase()}{detectorError ? ` · ${detectorError}` : ''}</div>
          <div>MODEL</div><div>EfficientDet-Lite0</div>
          <div>INF LATENCY</div><div>{Math.round(metrics?.inferenceLatency ?? 0)}ms</div>
          <div>INF FPS</div><div>{infFps}</div>
        </div>
      </div>

      <div className="mb-3">
        <div className="text-white border-b border-green-800 mb-1">LIVE CAMERA</div>
        <div className="relative w-full aspect-[4/3] bg-gray-900 border border-green-800 overflow-hidden">
          {debugFrameUrl ? (
            <img src={debugFrameUrl} className="absolute inset-0 w-full h-full object-contain" alt="Live feed" />
          ) : (
            <div className="flex h-full items-center justify-center text-gray-500">NO SIGNAL</div>
          )}
          {/* Overlays */}
          {snap.tracks.map((t) => {
            if (t.state === 'REMOVED') return null;
            const left = `${t.currentBox.x * 100}%`;
            const top = `${t.currentBox.y * 100}%`;
            const width = `${t.currentBox.w * 100}%`;
            const height = `${t.currentBox.h * 100}%`;
            const color = t.state === 'CONFIRMED' ? 'border-green-400 text-green-400' : t.state === 'LOST' ? 'border-red-500 text-red-500' : 'border-yellow-400 text-yellow-400';

            return (
              <div
                key={t.trackId}
                className={`absolute border-[1.5px] ${color}`}
                style={{ left, top, width, height }}
              >
                <div className="absolute -top-[14px] left-0 bg-black/80 whitespace-nowrap px-1 text-[9px] font-bold">
                  {t.label.toUpperCase()} {t.confidence.toFixed(2)} #{t.trackId}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mb-3">
        <div className="text-white border-b border-green-800 mb-1">PIPELINE</div>
        <div className="grid grid-cols-2 gap-x-2">
          <div>CAPTURE LATENCY</div><div>{Math.round(metrics?.captureLatency ?? 0)}ms</div>
          <div>INFERENCE LATENCY</div><div>{Math.round(metrics?.inferenceLatency ?? 0)}ms</div>
          <div>E2E LATENCY</div><div>{Math.round(snap.processingLatencyMs ?? 0)}ms</div>
          <div>TIMESTAMP</div><div>{snap.timestamp}</div>
          <div>PROCESSING AGE</div><div>{processingAge}ms</div>
        </div>
      </div>

      <div className="mb-3">
        <div className="text-white border-b border-green-800 mb-1 text-xs">TRACKS ({snap.tracks.length})</div>
        {snap.tracks.length === 0 && <div className="text-gray-500">NO ACTIVE TRACKS</div>}
        {snap.tracks.map(t => (
          <div key={t.trackId} className="mb-2 pl-1 border-l-2 border-gray-700">
            <div className="text-white font-bold">#{t.trackId} {t.label.toUpperCase()} ({t.confidence.toFixed(2)})</div>
            <div className="grid grid-cols-2 gap-x-2">
              <div>STATE</div><div className={t.state==='CONFIRMED'?'text-green-400':''}>{t.state}</div>
              <div>CENTER</div><div>({t.currentBox.x.toFixed(2)}, {t.currentBox.y.toFixed(2)})</div>
              <div>VELOCITY</div><div>{(Math.sqrt(t.velocity.x**2 + t.velocity.y**2)).toFixed(3)}/s (image units)</div>
              <div>LIFECYCLE</div><div>Age:{t.ageFrames} H:{t.hits} M:{t.misses}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="mb-3">
        <div className="text-white border-b border-green-800 mb-1">SENSORS</div>
        <div className="mb-1 text-green-300">ULTRASONIC</div>
        <div className="grid grid-cols-2 gap-x-2 mb-2">
          <div>DISTANCE</div><div>{ctx.ultrasonic.value ?? '---'} cm</div>
          <div>VALID</div><div>{ctx.ultrasonic.state === 'valid' ? 'YES' : 'NO'}</div>
          <div>STALE</div><div>{ctx.ultrasonic.state === 'stale' ? 'YES' : 'NO'}</div>
          <div>AGE</div><div>{ctx.ultrasonic.ageMs} ms</div>
          <div>QUALITY</div><div>{ctx.quality}</div>
          <div>FRONT TREND</div><div>{ctx.ultrasonicApproach?.trend ?? 'UNKNOWN'}</div>
          <div>EST RANGE RATE</div><div>{ctx.ultrasonicApproach?.closingSpeedCmS?.toFixed(1) ?? 'UNKNOWN'} cm/s</div>
          <div>EST TO WARNING</div><div>{ctx.ultrasonicApproach?.timeToWarningMs == null ? 'UNKNOWN' : `${Math.round(ctx.ultrasonicApproach.timeToWarningMs)} ms`}</div>
        </div>

        <div className="mb-1 text-green-300">IMU</div>
        <div className="grid grid-cols-2 gap-x-2">
          <div>PITCH / ROLL</div><div>{ctx.orientation.value?.pitch.toFixed(1) ?? '---'}° / {ctx.orientation.value?.roll.toFixed(1) ?? '---'}°</div>
          <div>ACCEL MAG</div><div>{ctx.accel.value?.mag.toFixed(2) ?? '---'}g</div>
          <div>ANGULAR MAG</div><div>{ctx.gyro.value?.mag.toFixed(1) ?? '---'}°/s</div>
          <div>MOTION</div><div>{ctx.motion}</div>
          <div>QUALITY</div><div>{ctx.quality}</div>
        </div>
      </div>

      <div className="mb-3">
        <div className="text-white border-b border-green-800 mb-1">FUSION</div>
        {snap.fusedObjects.length === 0 && <div className="text-gray-500">NO FUSED OBJECTS</div>}
        {snap.fusedObjects.map(f => (
          <div key={f.track.trackId} className="mb-2 pl-1 border-l-2 border-gray-700">
            <div className="text-white font-bold">#{f.track.trackId} {f.label.toUpperCase()}</div>
            <div className="grid grid-cols-2 gap-x-2">
              <div>VISUAL CONF</div><div>{f.track.confidence.toFixed(2)}</div>
              <div>POS</div><div>{f.side} / {f.depth}</div>
              <div>EVIDENCE</div><div>{f.evidence}</div>
              <div>US ASSOC</div><div>{f.ultrasonicDistanceCm !== null ? 'YES' : 'NO'}</div>
              <div>US DISTANCE</div><div>{f.ultrasonicDistanceCm !== null ? `${f.ultrasonicDistanceCm}cm` : '---'}</div>
              <div>FUSION QUAL</div><div>{snap.overallQuality}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="mb-3">
        <div className="text-white border-b border-green-800 mb-1">PATH</div>
        <div className="grid grid-cols-2 gap-x-2">
          <div>LEFT</div><div className={snap.pathState.left === 'BLOCKED' ? 'text-red-400' : ''}>{snap.pathState.left}</div>
          <div>CENTER</div><div className={snap.pathState.center === 'BLOCKED' ? 'text-red-400 font-bold' : ''}>{snap.pathState.center}</div>
          <div>RIGHT</div><div className={snap.pathState.right === 'BLOCKED' ? 'text-red-400' : ''}>{snap.pathState.right}</div>
          <div>LOCAL PLAN</div><div>{guidance.plan}</div>
          <div>ROUTE HOLD</div><div>{guidance.routeHold ? 'YES' : 'NO'}</div>
          <div>CAMERA SIDE HINTS</div><div>{guidance.directionsReliable ? 'POSE GATES PASSED' : 'UNAVAILABLE'}</div>
        </div>
      </div>

    </div>
  );
}
