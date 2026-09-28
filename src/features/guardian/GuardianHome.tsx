import { Map, Phone, Camera, ChevronRight, Link2, BatteryFull, Smartphone, MessageSquare } from 'lucide-react';
import { freshnessLabel } from '../../core/location/locationService';
import { useUI, toastGuardian } from '../../core/store/ui';
import { useNow } from '../../hooks/useNow';
import { TopNav, useSafetyStatus, SafetyHalo } from './parts';
import { StickVisual } from '../../components/StickVisual';
import { MapView } from '../../components/MapView';
import { AppScreen, SafeAreaContent } from '../../components/Layout';
import { useFeed, feedFresh } from '../../core/sync/guardianFeed';
import { AissNative } from '../../core/native/aissNative';
import { BRAND } from '../../core/brand/brand';
import { linkLabel, batteryLabel, TONE_TEXT } from '../shared/labels';
import type { LinkState } from '../../core/types';

export function GuardianHome() {
  const f = useFeed();
  const now = useNow(5000);
  const userName = f.userName || 'Your person';
  const setUI = useUI((s) => s.set);
  const status = useSafetyStatus();
  const fresh = feedFresh(f.device?.updatedAt, now);
  // Stale device data is shown as "unknown", never as a live connection.
  const link = linkLabel(f.device && fresh ? (f.device.link as LinkState) : 'unknown');
  const bat = batteryLabel(f.device ? { status: fresh ? (f.device.battery.status as 'ok') : 'stale', percent: f.device.battery.percent, charging: f.device.battery.charging } : null);
  const loc = f.location;
  const live = status.updated === 'Live';
  const halo = status.level === 'safe' ? 'bg-teal text-on-teal' : status.level === 'attention' ? 'bg-amber text-white' : status.level === 'critical' ? 'bg-sos text-white' : 'glass text-ink';
  const dial = (kind: 'tel' | 'sms') => {
    if (!f.userPhone) return toastGuardian(`${userName} has not added a phone number yet`);
    if (kind === 'tel') void AissNative.placeCall({ number: f.userPhone, direct: false }).catch(() => undefined);
    else void AissNative.sendSms({ number: f.userPhone, body: '', direct: false }).catch(() => undefined);
  };

  return (
    <AppScreen>
      <TopNav />
      <SafeAreaContent className="px-5 pb-[120px] pt-4" style={{ zIndex: 10 }}>
        <div className="h-16 shrink-0" />
        
        {/* 1. PRIMARY SAFETY CARD */}
        <button 
          className={`w-full text-left rounded-[28px] p-6 shadow-lg interactive ${halo}`}
          onClick={() => setUI({ guardianTab: 'activity' })}
        >
          <div className="flex items-start gap-5">
            <SafetyHalo level={status.level} size={100} />
            <div className="flex-1 pt-1">
              <h2 className="text-[28px] font-extrabold leading-tight tracking-tight mb-1">{status.headline}</h2>
              <p className="text-[16px] font-semibold opacity-90 mb-3 leading-snug">{status.activity}</p>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${live ? 'bg-current animate-pulse' : 'bg-current opacity-50'}`} />
                <span className="text-[13px] font-bold opacity-80">{status.updated}</span>
              </div>
            </div>
          </div>
          {status.reasons.length > 0 && (
            <div className="mt-4 pt-3 border-t border-white/20 flex flex-col gap-1">
              {status.reasons.map((r, i) => (
                <p key={i} className="text-[14px] opacity-90 leading-snug">⚠ {r}</p>
              ))}
            </div>
          )}
        </button>

        {/* 2. DEVICE CARD - same as User App */}
        <div className="glass rounded-[36px] p-5 flex border border-glass-border shadow-2xl relative overflow-hidden shrink-0 min-h-[260px]">
          <div className="absolute inset-0 bg-gradient-to-br from-teal/5 to-info/10 pointer-events-none" />
          
          <div className="w-[160px] flex flex-col items-center justify-center relative">
             <StickVisual link={f.device && fresh ? (f.device.link as LinkState) : 'disconnected'} obstacleCm={null} pose={null} height={200} />
             <p className="absolute bottom-1 font-bold text-[14px] tracking-widest text-ink uppercase opacity-90 drop-shadow-md">{BRAND.name}</p>
          </div>
          
          <div className="flex-1 flex flex-col justify-center gap-3 pl-2 pr-1">
             <div className="glass rounded-[20px] px-4 py-3 flex flex-col items-center justify-center border border-glass-border">
               <Link2 size={22} className={`${TONE_TEXT[link.tone]} mb-1.5`} />
               <span className={`${TONE_TEXT[link.tone]} font-bold text-[13px]`}>{link.text}</span>
             </div>
             <div className="glass rounded-[20px] px-4 py-3 flex flex-col items-center justify-center border border-glass-border">
               <BatteryFull size={22} className={`${TONE_TEXT[bat.tone]} mb-1.5`} />
               <span className="text-ink font-bold text-[14px]">{bat.text}</span>
             </div>
             <div className="glass rounded-[20px] px-4 py-3 flex flex-col items-center justify-center border border-glass-border">
               <Smartphone size={22} className="text-ink-3 mb-1.5" />
               <span className="text-ink font-bold text-[13px]">{!f.device ? 'Phone: no data' : f.device.phoneInternet && fresh ? 'Phone online' : 'Phone offline'}</span>
             </div>
          </div>
        </div>

        {/* 3. MAP PREVIEW */}
        <div className="glass rounded-[28px] overflow-hidden border border-glass-border shadow-sm">
          <div className="p-5 pb-3">
            <div className="flex justify-between items-end">
              <div>
                <p className="text-[12px] font-bold text-ink-3 uppercase tracking-wider mb-0.5">Current Location</p>
                <p className="text-[16px] font-bold text-ink">{status.activity}</p>
              </div>
              <span className={`text-[11px] font-bold px-2 py-1 rounded-full shrink-0 ${live ? 'text-teal-ink bg-teal-soft' : 'text-amber-ink bg-amber-soft'}`}>
                {loc ? freshnessLabel(loc.measuredAt, now) : status.updated}
              </span>
            </div>
          </div>
          <div className="w-full h-[130px] bg-map-bg relative">
            <MapView mini className="absolute inset-0 h-full w-full" position={loc ? { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM } : null} stale={!live} />
          </div>
          <button 
            className="w-full px-5 py-3 flex items-center justify-between text-[14px] font-bold text-teal-ink hover:bg-teal-soft/30 transition-colors interactive"
            onClick={() => setUI({ guardianTab: 'map' })}
            aria-label="View full map"
          >
            View Full Map <ChevronRight size={18} />
          </button>
        </div>

        {/* QUICK ACTIONS */}
        <div className="grid grid-cols-2 gap-4 mb-6">
          <button 
            onClick={() => setUI({ guardianTab: 'map' })}
            className="flex flex-col items-center justify-center gap-2 glass p-5 rounded-[28px] interactive text-center border border-glass-border h-[130px]"
            aria-label="View location"
          >
            <div className="p-3 bg-teal/10 rounded-full text-teal shrink-0">
              <Map size={28} />
            </div>
            <div>
              <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">Location</p>
              <p className="text-[15px] font-bold text-ink mt-0.5">View Map</p>
            </div>
          </button>
          
          <button 
            onClick={() => setUI({ guardianTab: 'vision' })}
            className="flex flex-col items-center justify-center gap-2 glass p-5 rounded-[28px] interactive text-center border border-glass-border h-[130px]"
            aria-label="Request photo"
          >
            <div className="p-3 bg-info/10 rounded-full text-info shrink-0">
              <Camera size={28} />
            </div>
            <div>
              <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">Camera</p>
              <p className="text-[15px] font-bold text-ink mt-0.5">Request Photo</p>
            </div>
          </button>

          <button 
            onClick={() => dial('tel')}
            className="flex flex-col items-center justify-center gap-2 glass p-5 rounded-[28px] interactive text-center border border-glass-border h-[130px]"
          >
            <div className="p-3 bg-ok/10 rounded-full text-ok shrink-0">
              <Phone size={28} />
            </div>
            <div>
              <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">Voice</p>
              <p className="text-[15px] font-bold text-ink mt-0.5">Call {userName.split(' ')[0]}</p>
            </div>
          </button>
          
          <button 
            onClick={() => dial('sms')}
            className="flex flex-col items-center justify-center gap-2 glass p-5 rounded-[28px] interactive text-center border border-glass-border h-[130px]"
          >
            <div className="p-3 bg-teal/10 rounded-full text-teal shrink-0">
              <MessageSquare size={28} />
            </div>
            <div>
              <p className="text-[13px] text-ink-2 font-bold uppercase tracking-wider">Text</p>
              <p className="text-[15px] font-bold text-ink mt-0.5">Message</p>
            </div>
          </button>
        </div>
      </SafeAreaContent>
    </AppScreen>
  );
}
