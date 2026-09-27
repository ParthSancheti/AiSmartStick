import { useRef, useState } from 'react';
import { useVision } from '../../core/store/vision';
import { Aperture, CameraOff, Ear, RefreshCw, Sparkles, WifiOff, Box } from 'lucide-react';
import { useFeed, feedFresh } from '../../core/sync/guardianFeed';
import { ObstacleView } from '../../components/ObstacleView';
import type { UltrasonicState } from '../../core/telemetry/types';
import { useGuardianVision } from '../../hooks/useGuardianVision';
import { useNow } from '../../hooks/useNow';
import { timeAgo } from '../../core/util';
import { Glass, GlassButton, Toggle, Segmented } from '../../components/glass';
import { GHeader, GScreen, TopNav } from './parts';

const SESSION_TEXT: Record<string, string> = {
  requesting: 'Sending request…',
  waiting: `Waiting for their phone…`,
  connecting: 'Connecting…',
  active: 'Receiving photo…',
  reconnecting: 'Reconnecting…',
};

export function GuardianVision() {
  const session = useVision((x) => x.session);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const v = useGuardianVision(canvasRef);
  const now = useNow(1000);
  const f = useFeed();
  const name = f.userName || 'Your person';
  const heardAs = f.heardAs || 'You';
  const fresh = feedFresh(f.device?.updatedAt, now);
  const internet = !!f.device && fresh && f.device.phoneInternet;
  const stickUp = !!f.device && fresh && (f.device.link === 'connected' || f.device.link === 'degraded');
  const noPermission = f.permissions ? !f.permissions.camera : false;
  const blocked = !internet || !stickUp || noPermission;
  const blockedText = noPermission
    ? `${name} has not allowed camera access for you.`
    : !internet
      ? `${name}'s phone is offline or not reporting. Photos will work again when it reconnects.`
      : `The stick isn't connected to ${name}'s phone, so the camera can't be reached.`;
  const us: Pick<UltrasonicState, 'status' | 'distanceCm' | 'measuredAt'> | null = f.device
    ? { status: (fresh ? f.device.sensors.ultrasonic : 'stale') as UltrasonicState['status'], distanceCm: f.device.sensors.obstacleCm ?? null, measuredAt: f.device.updatedAt }
    : null;

  const [viewMode, setViewMode] = useState<'camera' | 'ar'>('camera');

  return (
    <GScreen>
      <TopNav />
      <GHeader title="Vision" subtitle={`Photos from ${name}'s stick, on request`} />

      <div className="mb-4">
        <Segmented
          label="View Mode"
          value={viewMode}
          onChange={setViewMode}
          options={[
            { value: 'camera', label: 'Camera' },
            { value: 'ar', label: 'Obstacle sensor' },
          ]}
        />
      </div>

      <div className="mb-4 flex items-center gap-2.5 rounded-[18px] bg-teal-soft px-4 py-3 text-[14.5px] font-medium leading-snug text-teal-ink">
        <Ear size={18} className="shrink-0" />
        {name} hears “{heardAs} asked to see your camera” when you look. Photos are sent phone-to-phone and never stored.
      </div>

      {viewMode === 'camera' ? (
        <>
          <div className="relative mb-4 aspect-[4/3] overflow-hidden rounded-[30px] bg-[#0f1c21] shadow-[0_30px_60px_-30px_rgba(8,40,44,.7)]">
            <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-cover" aria-label={v.frame?.description ?? 'No photo yet'} role="img" />
            {!v.frame && !v.requesting && (
              <div className="absolute inset-0 grid place-items-center p-6 text-center text-white/80">
                <div>
                  {blocked ? <WifiOff size={34} className="mx-auto mb-3" /> : <Aperture size={34} className="mx-auto mb-3" />}
                  <p className="text-[16px] font-semibold">{blocked ? 'Camera unavailable' : 'No photo yet'}</p>
                  <p className="mx-auto mt-1 max-w-[28ch] text-[14px] text-white/60">{blocked ? blockedText : 'Take a photo to see what is in front of him right now.'}</p>
                </div>
              </div>
            )}
            {v.requesting && (
              <div className="absolute inset-0 grid place-items-center">
                <div className="shimmer absolute inset-0" />
                <p className="relative rounded-full bg-black/45 px-4 py-2 text-[14px] font-semibold text-white" aria-live="polite">{SESSION_TEXT[session] ?? 'Asking the stick camera…'}</p>
              </div>
            )}
            {v.frame && (
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/45 px-3 py-1.5 text-[13px] font-semibold text-white backdrop-blur-md">
                <span className={`h-2 w-2 rounded-full ${v.autoRefresh ? 'animate-pulse bg-[#ff5a4e]' : 'bg-white/70'}`} />
                {v.autoRefresh ? 'Refreshing every 3 s' : `Photo from ${timeAgo(v.frame.ts, now)}`}
              </div>
            )}
          </div>

          {v.error && !v.requesting && (
            <p className="mb-4 flex items-start gap-2 rounded-[18px] bg-amber-soft px-4 py-3 text-[14.5px] font-medium text-amber-ink">
              <CameraOff size={18} className="mt-0.5 shrink-0" />
              {v.error === 'phone'
                ? `${name}'s phone is offline, so no photo could be taken.`
                : v.error === 'denied'
                  ? `${name} declined the camera request.`
                  : v.error === 'permission'
                    ? 'Camera access is not permitted for this link.'
                    : v.error === 'failed'
                      ? 'The photo could not be delivered (network or timeout). Try again.'
                      : `Couldn't reach the stick camera. Check that the stick is on.`}
            </p>
          )}

          <div className="mb-4 flex gap-2">
            <GlassButton variant="teal" size="lg" className="flex-1" disabled={blocked || v.requesting} onClick={() => void v.request()}>
              {v.frame ? <RefreshCw size={19} /> : <Aperture size={20} />}
              {v.frame ? 'Take new photo' : 'Take photo'}
            </GlassButton>
          </div>
          <Glass className="mb-4 flex items-center justify-between gap-3 rounded-[22px] px-4 py-3">
            <div>
              <p className="text-[16px] font-semibold text-ink">Keep refreshing</p>
              <p className="text-[13.5px] text-ink-3">A new photo every 3 seconds while this screen is open.</p>
            </div>
            <Toggle label="Keep refreshing" on={v.autoRefresh} disabled={blocked} onChange={v.setAutoRefresh} />
          </Glass>

          {v.frame?.description && (
            <Glass className="rounded-[26px] p-4">
              <p className="mb-1.5 flex items-center gap-1.5 text-[14px] font-semibold text-teal-ink">
                <Sparkles size={16} /> The assistant sees (demo)
              </p>
              <p className="text-[17px] leading-relaxed text-ink">{v.frame.description}</p>
            </Glass>
          )}
        </>
      ) : (
        <div className="mb-4">
          <div className="w-full rounded-[30px] overflow-hidden border border-glass-border relative shadow-[0_30px_60px_-30px_rgba(8,40,44,.7)]">
            <ObstacleView us={us} live={stickUp} label="Stick sensor" />
          </div>
          <Glass className="mt-4 rounded-[26px] p-4">
            <p className="mb-1.5 flex items-center gap-1.5 text-[14px] font-semibold text-teal-ink">
              <Box size={16} /> What this shows
            </p>
            <p className="text-[15px] leading-relaxed text-ink">One forward distance from the stick’s ultrasonic sensor, as last reported by {name}'s phone (updated every few seconds, not a video). The stick does not build a 3D map.</p>
          </Glass>
        </div>
      )}
    </GScreen>
  );
}
