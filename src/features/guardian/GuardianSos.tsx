import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { BellOff, Car, Phone, ShieldCheck, Siren } from 'lucide-react';
import { useSession } from '../../core/store/session';
import { useVision } from '../../core/store/vision';
import { toastGuardian } from '../../core/store/ui';
import { useFeed, guardianActions } from '../../core/sync/guardianFeed';
import { requestSnapshot } from '../../core/camera/cameraSession';
import { useRuntime } from '../../core/runtime/mode';
import { freshnessLabel } from '../../core/location/locationService';
import { AissNative } from '../../core/native/aissNative';
import { useNow } from '../../hooks/useNow';
import { loadMedical, type MedicalProfile } from '../../core/profile/medical';
import { loopEarcon } from '../../core/feedback/earcons';
import { haptics } from '../../core/feedback/haptics';
import { guardianSurfaceActive } from '../../core/surfaces';
import { clock } from '../../core/util';
import { MapView } from '../../components/MapView';
import { FrameCanvas } from '../../components/FrameCanvas';
import { HoldButton } from '../../components/glass';

const TRIGGER = { button: 'The stick button was held', voice: 'Help was asked for by voice', fall: 'The stick detected a possible fall' };

/** Full-screen takeover. Solid colour on purpose: no glass, nothing to decode. */
export function GuardianSos() {
  const reduce = useReducedMotion();
  const sos = useFeed((x) => x.sos);
  const f = useFeed();
  const name = f.userName || 'Your person';
  const sirenOn = useSession((x) => x.settings.siren);
  const demo = useRuntime((x) => x.mode) === 'demo';
  const frame = useVision((x) => (demo ? x.latest : x.guardianFrame));
  const requesting = useVision((x) => x.requesting);
  const now = useNow(1000);
  const ack = !!sos?.acknowledgedAt;
  const [med, setMed] = useState<MedicalProfile | null>(null);
  useEffect(() => {
    if (!demo && f.userUid && f.permissions?.sos) void loadMedical(f.userUid).then(setMed).catch(() => setMed(null));
  }, [demo, f.userUid, f.permissions?.sos]);
  const onWay = !!sos?.onTheWayAt;
  const loc = sos?.location ?? (f.location ? { lat: f.location.lat, lng: f.location.lng, accuracyM: f.location.accuracyM, measuredAt: f.location.measuredAt } : null);
  const call = async () => {
    void guardianActions.acknowledge();
    if (!f.userPhone) return toastGuardian(`No phone number saved for ${name}`);
    toastGuardian(`Calling ${name}…`);
    await AissNative.placeCall({ number: f.userPhone, direct: false }).catch(() => undefined);
  };

  useEffect(() => {
    if (!sos || sos.state !== 'active' || ack || !sirenOn || !guardianSurfaceActive()) return;
    const stop = loopEarcon('siren');
    haptics.play('sos');
    const vib = setInterval(() => haptics.play('sos'), 2600);
    return () => {
      stop();
      clearInterval(vib);
    };
  }, [sos?.state, ack, sirenOn]);

  if (!sos) return null;
  if (sos.state === 'resolved') {
    return (
      <motion.div className="absolute inset-0 z-[70] grid place-items-center bg-ok p-8 text-center text-white" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
        <div>
          <ShieldCheck size={72} className="mx-auto mb-5" strokeWidth={1.6} />
          <h1 className="text-[32px] font-bold leading-tight">{sos.resolvedBy === 'user' ? `${name} marked themselves safe` : 'SOS resolved'}</h1>
          <p className="mt-2 text-[17px] text-white/85">{sos.resolvedBy === 'user' ? 'The alert was closed from the stick user’s phone.' : 'The stick user was told.'}</p>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      role="alertdialog"
      aria-live="assertive"
      aria-label={`SOS from ${name}`}
      className="absolute inset-0 z-[70] overflow-y-auto bg-sos-deep text-white no-scrollbar"
      initial={{ opacity: 0, scale: 1.04 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      style={{ background: 'radial-gradient(120% 60% at 50% 0%, var(--sos), var(--sos-deep) 70%)' }}
    >
      <div className="mx-auto max-w-[560px] px-5 pb-8" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 22px)' }}>
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-4 grid h-24 w-24 place-items-center">
            {!reduce &&
              [0, 1].map((i) => (
                <motion.span
                  key={i}
                  className="absolute inset-0 rounded-full border-4 border-white/60"
                  animate={{ scale: [1, 1.7], opacity: [0.8, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, delay: i * 0.8 }}
                />
              ))}
            <span className="grid h-24 w-24 place-items-center rounded-full bg-white text-sos-deep">
              <Siren size={44} />
            </span>
          </div>
          <h1 className="text-[36px] font-bold leading-[1.05] tracking-[-0.02em]">{name} needs help</h1>
          <p className="mt-2 text-[17px] text-white/90">
            {TRIGGER[sos.trigger ?? 'button']} at {clock(sos.createdAt)}.
          </p>
          {onWay ? (
            <p className="mt-3 rounded-full bg-white/15 px-4 py-2 text-[15px] font-semibold">You marked “on my way”</p>
          ) : ack ? (
            <p className="mt-3 rounded-full bg-white/15 px-4 py-2 text-[15px] font-semibold">You acknowledged the alert</p>
          ) : null}
        </div>

        <div className="mt-6 overflow-hidden rounded-[26px] bg-white text-[#10242a]">
          <MapView mini className="block h-[140px] w-full" position={loc ? { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM } : null} />
          <div className="px-4 py-3">
            <p className="text-[17px] font-bold">{f.locationLabel ?? (loc ? `GPS ±${Math.round(loc.accuracyM)} m` : 'Location unavailable')}</p>
            <p className="text-[14px] text-[#647c82]">{demo ? 'Demo location' : loc ? freshnessLabel(loc.measuredAt, now) : 'The phone has not shared a position'}</p>
            {loc && !demo && (
              <a className="mt-1 inline-block text-[14px] font-bold text-[#0a8576] underline" href={`https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}&travelmode=driving`} target="_blank" rel="noreferrer">
                Directions in Google Maps
              </a>
            )}
          </div>
        </div>

        {med && (med.bloodGroup || med.allergies || med.medications || med.conditions || med.notes) && (
          <div className="mt-3 rounded-[22px] bg-white/15 px-4 py-3 text-[14.5px] leading-snug ring-1 ring-white/25">
            <p className="font-bold">Medical information</p>
            {med.bloodGroup && <p>Blood group: {med.bloodGroup}</p>}
            {med.allergies && <p>Allergies: {med.allergies}</p>}
            {med.medications && <p>Medications: {med.medications}</p>}
            {med.conditions && <p>Conditions: {med.conditions}</p>}
            {med.notes && <p>{med.notes}</p>}
          </div>
        )}
        {frame ? (
          <div className="mt-3 overflow-hidden rounded-[26px] bg-black/30">
            <FrameCanvas frame={frame} className="block aspect-[4/3] w-full" label="Photo from the stick camera" />
            <p className="px-4 py-2.5 text-[14px] text-white/85">Photo from the stick, {clock(frame.ts)} · not stored</p>
          </div>
        ) : (
          !demo && (
            <button type="button" disabled={requesting} onClick={() => void requestSnapshot('snapshot')} className="mt-3 h-12 w-full rounded-[22px] bg-white/15 text-[15.5px] font-semibold ring-1 ring-white/35 disabled:opacity-60">
              {requesting ? 'Asking the stick camera…' : 'See a photo from the stick (they will be told)'}
            </button>
          )
        )}

        <div className="mt-5 space-y-2.5">
          <motion.button
            type="button"
            whileTap={{ scale: 0.97 }}
            onClick={() => void call()}
            className="flex h-16 w-full items-center justify-center gap-3 rounded-[24px] bg-white text-[19px] font-bold text-sos-deep"
          >
            <Phone size={22} /> Call {name}
          </motion.button>
          <div className="grid grid-cols-2 gap-2.5">
            <button type="button" onClick={() => void guardianActions.onTheWay()} className="flex h-14 items-center justify-center gap-2 rounded-[22px] bg-white/18 text-[16px] font-semibold ring-1 ring-white/35">
              <Car size={19} /> I'm on my way
            </button>
            <a href="tel:112" className="flex h-14 items-center justify-center gap-2 rounded-[22px] bg-white/18 text-[16px] font-semibold ring-1 ring-white/35">
              <Phone size={19} /> Call 112
            </a>
          </div>
          {!ack && (
            <button type="button" onClick={() => void guardianActions.acknowledge()} className="flex h-12 w-full items-center justify-center gap-2 text-[15.5px] font-semibold text-white/90">
              <BellOff size={18} /> Stop siren and tell {name} I've seen it
            </button>
          )}
          <HoldButton label="Hold to mark as resolved" holdingLabel="Keep holding" onComplete={() => void guardianActions.resolve()} className="w-full !bg-white/10 !text-white ring-1 ring-white/30" tone="glass" />
        </div>
      </div>
    </motion.div>
  );
}
