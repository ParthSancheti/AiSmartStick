import { CornerUpLeft, CornerUpRight, MoveUp, Phone, Navigation } from 'lucide-react';
import { useSession } from '../../core/store/session';
import { toastGuardian } from '../../core/store/ui';
import { meters } from '../../core/util';
import { MapView } from '../../components/MapView';
import { GlassButton, Glass, Toggle } from '../../components/glass';
import { Meter } from '../../components/StatusBits';
import { PersonAvatar, useSafetyStatus, TopNav } from './parts';
import { useFeed } from '../../core/sync/guardianFeed';
import { freshnessLabel } from '../../core/location/locationService';
import { OSM_ATTRIBUTION, isOsmPlaceId } from '../../core/maps/osmFallback';
import { AissNative } from '../../core/native/aissNative';
import { useNow } from '../../hooks/useNow';
import { useRuntime } from '../../core/runtime/mode';

export function GuardianMap() {
  const f = useFeed();
  const name = f.userName || 'Your person';
  const nav = f.navigation;
  const loc = f.location;
  const status = useSafetyStatus();
  const now = useNow(1000);
  const demo = useRuntime((x) => x.mode) === 'demo';
  const next = nav?.nextInstruction ?? null;
  const NextIcon = next && /left/i.test(next) ? CornerUpLeft : next && /right/i.test(next) ? CornerUpRight : MoveUp;
  const fresh = loc ? freshnessLabel(loc.measuredAt, now) : null;
  const where = f.locationLabel ?? (loc ? `GPS ±${Math.round(loc.accuracyM)} m` : f.permissions && !f.permissions.location ? 'Location sharing is off' : 'Location unavailable');
  // Geofence preference lives in the guardian's synced settings (enforced by a Cloud Function).
  const geofence = useSession((x) => x.settings.geofence);
  const update = useSession((x) => x.updateSettings);
  const geofenceOn = geofence.enabled;
  const radius = geofence.radiusM;
  const setGeofenceOn = (v: boolean) => update({ geofence: { ...geofence, enabled: v } });
  const useCurrentAsCenter = () => {
    if (!loc) return toastGuardian('No current location to use');
    update({ geofence: { ...geofence, center: { lat: loc.lat, lng: loc.lng }, name: 'Chosen place' } });
    toastGuardian('Safe area centred on their current location');
  };
  const setRadius = (v: number) => update({ geofence: { ...geofence, radiusM: v } });
  const call = () => {
    if (!f.userPhone) return toastGuardian(`${name} has not added a phone number`);
    void AissNative.placeCall({ number: f.userPhone, direct: false }).catch(() => undefined);
  };
  const directions = () => {
    if (!loc) return toastGuardian('No location to navigate to');
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`, '_blank', 'noopener');
  };
  return (
    <div className="absolute inset-0 flex flex-col overflow-y-auto no-scrollbar pb-[120px]" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 10px)' }}>
      <div className="z-10 px-4 pb-2 shrink-0 relative">
        <TopNav />
        <Glass className="flex items-center gap-3 rounded-full py-2 pl-2 pr-5 mt-2 shadow-sm">
          <PersonAvatar size={40} />
          <div className="min-w-0">
            <p className="truncate text-[16px] font-bold text-ink">{name}</p>
            <p className="truncate text-[13.5px] text-ink-3">
              {demo ? `${status.updated} · ${where}` : fresh ? `${fresh} · ${where}` : where}
            </p>
          </div>
        </Glass>
      </div>

      <div className="relative shrink-0 h-[320px] mx-4 mt-2 rounded-[32px] overflow-hidden shadow-lg border border-glass-border">
        <MapView className="absolute inset-0 h-full w-full" position={loc ? { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM } : null} stale={fresh !== 'Live'} destination={nav?.destination ? { lat: nav.destination.lat, lng: nav.destination.lng } : null} />
      </div>
        
      <div className="px-4 mt-4 shrink-0">
        <Glass className="rounded-[28px] p-5 shadow-sm">
          {nav?.active && nav.destination ? (
            <>
              <p className="text-[14px] font-semibold text-teal-ink">{nav.arrived ? 'Arrived' : 'Walking with the assistant'}</p>
              <h2 className="text-[21px] font-bold tracking-[-0.01em] text-ink">{nav.destination.name}</h2>
              <p className="text-[15px] text-ink-2">
                {nav.arrived ? 'Arrived near the destination.' : nav.remainingM != null ? `${meters(nav.remainingM)} left${nav.etaSec != null ? `, about ${Math.max(1, Math.round(nav.etaSec / 60))} min` : ''}` : 'Distance unknown'}
              </p>
              {nav.remainingM != null && <Meter className="mt-3" value={Math.max(0, 100 - (nav.remainingM / Math.max(nav.remainingM, 1)) * 100)} />}
              {next && !nav.arrived && (
                <p className="mt-3 flex items-center gap-2 text-[15px] font-medium text-ink">
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-teal-soft text-teal-ink">
                    <NextIcon size={17} />
                  </span>
                  Next: {next}
                </p>
              )}
              {/* Required attribution when the destination came from OpenStreetMap (Google search failed). */}
              {isOsmPlaceId(nav.destination.placeId) && <p className="mt-2 text-[11px] text-ink-3">{OSM_ATTRIBUTION}</p>}
            </>
          ) : (
            <>
              <h2 className="text-[20px] font-bold tracking-[-0.01em] text-ink">{where}</h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-[15px] text-ink-2">
                <Navigation size={16} /> {demo ? 'Demo location' : fresh ?? 'No position shared yet'}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 mb-5">
                <GlassButton size="sm" variant="teal" className="h-12 text-[15px]" onClick={call}>
                  <Phone size={18} /> Call
                </GlassButton>
                <GlassButton size="sm" className="h-12 text-[15px]" onClick={directions}>
                  Directions
                </GlassButton>
              </div>

              <div className="pt-5 border-t border-line">
                <div className="flex justify-between items-center mb-4">
                  <p className="text-[16px] font-semibold text-ink">Geofencing Alerts</p>
                  <Toggle label="Geofencing" on={geofenceOn} onChange={setGeofenceOn} />
                </div>
                <div className="flex justify-between items-center text-[14px] text-ink-2 mb-3">
                  <span>Safe Radius</span>
                  <span className="font-bold text-teal text-[15px]">{radius} m</span>
                </div>
                <input 
                  type="range" 
                  min="50" 
                  max="1000" 
                  step="50" 
                  value={radius} 
                  onChange={(e) => setRadius(Number(e.target.value))} 
                  className={`w-full accent-teal ${!geofenceOn && 'opacity-50 grayscale'}`} 
                  disabled={!geofenceOn} 
                />
                <div className="mt-3 flex items-center justify-between gap-2 text-[13.5px] text-ink-3">
                  <span>Centre: {geofence.center ? geofence.name : `${name}'s home address`}</span>
                  <button type="button" onClick={geofence.center ? () => update({ geofence: { ...geofence, center: null, name: 'Home' } }) : useCurrentAsCenter} className="font-semibold text-teal-ink underline" disabled={!geofenceOn}>
                    {geofence.center ? 'Use home address' : 'Use current location'}
                  </button>
                </div>
                <p className="mt-1 text-[12.5px] text-ink-3">You get a notification when they leave or come back. Short GPS jumps are ignored.</p>
              </div>
            </>
          )}
        </Glass>
      </div>
    </div>
  );
}
