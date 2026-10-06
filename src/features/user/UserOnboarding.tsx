import { useEffect, useState, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight, Check, Search, MapPin, Shield, Loader2, Mic, Delete, Vibrate, ArrowRight, Home } from 'lucide-react';
import { useSession } from '../../core/store/session';
import { GlassButton, cx } from '../../components/glass';
import { StickVisual } from '../../components/StickVisual';
import { AppScreen } from '../../components/Layout';
import { BrandLogo } from '../../core/brand/BrandLogo';
import { BRAND } from '../../core/brand/brand';
import { useAuth } from '../../core/auth/authStore';
import { signInWithGoogle } from '../../core/auth/authService';
import { firebaseConfigured } from '../../core/runtime/env';
import { autocomplete, placeDetails, type Suggestion } from '../../core/maps/mapsService';
import { useLocation } from '../../core/location/locationService';
import { StickSetup } from './StickSetup';
import { MapView } from '../../components/MapView';
import { AiOrb } from '../../components/AiOrb';
import { isLinked, useDevice } from '../../core/store/device';
import { wait } from '../../core/util';
import { sendSms } from '../../core/phone';

type Step = 'carousel' | 'signin' | 'welcome' | 'address' | 'safety' | 'stick' | 'done';

const SLIDES = [
  { eyebrow: 'INDEPENDENCE', title: 'Move with confidence.', body: 'SmartStick helps you stay aware of what is around you while keeping the experience simple and natural.' },
  { eyebrow: 'SMART AWARENESS', title: 'The stick senses. AI understands.', body: 'Advanced spatial detection and object recognition keep you safe and informed about your surroundings.' },
  { eyebrow: 'EVERYWHERE WITH YOU', title: 'Your assistant, wherever you go.', body: 'Voice-guided walking navigation and contextual help are always just a button press away.' },
];

function Title({ children }: { children: React.ReactNode }) {
  return <h1 className="text-[28px] font-extrabold leading-[1.1] text-white mb-4 tracking-tight drop-shadow-md">{children}</h1>;
}

function Body({ children }: { children: React.ReactNode }) {
  return <p className="text-[15px] text-white/80 leading-[1.6] mb-8 font-medium drop-shadow-sm">{children}</p>;
}

export function UserOnboarding() {
  const lastAppPage = useSession((s) => s.lastAppPage);
  const [step, setStep] = useState<Step>((lastAppPage as Step) || 'carousel');

  useEffect(() => {
    useSession.setState({ lastAppPage: step });
  }, [step]);
  const [slide, setSlide] = useState(0);
  const auth = useAuth();
  const link = useDevice((s) => s.link);

  // Address State
  const [addressQuery, setAddressQuery] = useState('');
  const [addressSearching, setAddressSearching] = useState(false);
  const [addressSuggestions, setAddressSuggestions] = useState<Suggestion[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<Suggestion | null>(null);

    const loc = useLocation((s) => s.fix);
  
  useEffect(() => {
    if (!addressQuery || addressQuery.length < 2) {
      setAddressSuggestions([]);
      return;
    }
    const timer = setTimeout(async () => {
      setAddressSearching(true);
      try {
        const res = await autocomplete(addressQuery, loc?.lat ?? 0, loc?.lng ?? 0, 'onboarding-session');
        setAddressSuggestions(res.suggestions || []);
      } catch (e) {
        console.error(e);
      } finally {
        setAddressSearching(false);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [addressQuery, loc]);

  const [selectedPlaceCoords, setSelectedPlaceCoords] = useState<{lat: number, lng: number} | null>(null);

  const handleSelectAddress = async (s: Suggestion) => {
    setSelectedAddress(s);
    setAddressQuery(s.main + (s.secondary ? ', ' + s.secondary : ''));
    setAddressSuggestions([]);
    try {
      const details = await placeDetails(s.placeId, 'onboarding-session');
      if (details?.place) setSelectedPlaceCoords({ lat: details.place.lat, lng: details.place.lng });
    } catch (e) {
      console.error(e);
    }
  };

  // Safety State
  const [countryCode, setCountryCode] = useState('+91');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [smsState, setSmsState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  // Setup Progress State
  const [photoAdded, setPhotoAdded] = useState(false);
  const [locationAdded, setLocationAdded] = useState(false);
  const [safetyAdded, setSafetyAdded] = useState(false);

  useEffect(() => {
    if (auth.status === 'signedIn') {
      if (auth.user?.photoURL) {
        setPhotoAdded(true);
        // Cache photo locally
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0);
            localStorage.setItem('cached_profile_pic', canvas.toDataURL('image/jpeg'));
          }
        };
        img.src = auth.user.photoURL;
      }
      if (step === 'signin') setStep('welcome');
    }
  }, [auth.status, step, auth.user]);

  const handleDragEnd = (e: any, info: any) => {
    if (info.offset.x < -50 && slide < 2) setSlide(s => s + 1);
    else if (info.offset.x > 50 && slide > 0) setSlide(s => s - 1);
  };

  return (
    <AppScreen className="bg-[#0a0d14] text-white selection:bg-teal/30">
      {/* Immersive Background Atmosphere */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <motion.div 
          className="absolute inset-0 bg-gradient-to-br from-teal-900/40 via-transparent to-[#0a0d14]"
          animate={{ backgroundPosition: ['0% 0%', '100% 100%', '0% 0%'] }}
          transition={{ duration: 15, repeat: Infinity, ease: 'linear' }}
        />
        <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-teal/20 rounded-full blur-[120px] mix-blend-screen" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] bg-cyan/10 rounded-full blur-[100px] mix-blend-screen" />
      </div>

      <div className="relative flex-1 z-10">
        <AnimatePresence mode="wait">
          {step === 'carousel' && (
            <motion.div key="carousel" initial={{ opacity: 0, filter: 'blur(20px)', scale: 1.05 }} animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }} exit={{ opacity: 0, filter: 'blur(20px)', scale: 0.95 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} className="absolute inset-0 flex flex-col px-6 pb-12 pt-[0px]">
              
              {/* 3D Stage */}
              <div className="flex-1 relative mb-6 pointer-events-none">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={slide}
                    initial={{ opacity: 0, x: 100, scale: 0.9, rotateY: -10 }}
                    animate={{ opacity: 1, x: 0, scale: 1, rotateY: 0 }}
                    exit={{ opacity: 0, x: -100, scale: 0.9, rotateY: 10 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 120, mass: 0.8 }}
                    className="absolute inset-0 flex items-center justify-center"
                  >
                    {slide === 0 && (
                      <div className="relative z-0">
                        <motion.div className="absolute inset-0 rounded-full bg-teal blur-[100px] opacity-40" animate={{ scale: [1, 1.2, 1] }} transition={{ duration: 4, repeat: Infinity }} />
                        <StickVisual height={340} pose={{ pitch: 10, roll: 0 }} link="connected" />
                      </div>
                    )}
                    {slide === 1 && (
                      <div className="relative z-0 flex items-center justify-center">
                        <motion.div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full border border-teal/30" />
                        <motion.div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 rounded-full bg-gradient-to-tr from-teal/20 to-transparent" animate={{ rotate: 360 }} transition={{ duration: 3, repeat: Infinity, ease: 'linear' }} style={{ clipPath: 'polygon(50% 50%, 100% 0, 100% 100%)' }} />
                        <motion.div className="absolute inset-0 -m-10 rounded-full border-2 border-teal/50" animate={{ scale: [1, 1.5, 2], opacity: [0.8, 0.4, 0] }} transition={{ duration: 2, repeat: Infinity }} />
                        <StickVisual height={300} pose={{ pitch: 20, roll: 5 }} obstacleCm={40} link="connected" />
                      </div>
                    )}
                    {slide === 2 && (
                        <div className="relative z-0 flex items-center justify-center pt-16">
                          <svg className="absolute -bottom-16 left-1/2 -translate-x-1/2 w-48 h-56 overflow-visible z-[-1]" viewBox="0 0 100 100">
                            <path d="M50 100 Q50 50 10 0" fill="none" stroke="currentColor" strokeWidth="2" className="text-teal/40 animate-pulse" strokeDasharray="4 4" />
                            <path d="M50 100 Q50 50 90 0" fill="none" stroke="currentColor" strokeWidth="2" className="text-teal/40 animate-pulse" strokeDasharray="4 4" style={{ animationDelay: '0.5s' }} />
                            <path d="M50 100 L50 0" fill="none" stroke="currentColor" strokeWidth="3" className="text-teal" />
                          </svg>
                          <motion.div animate={{ y: [-5, 5, -5] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }} className="absolute top-0 left-1/2 -translate-x-1/2 z-10">
                            <MapPin size={48} className="text-teal drop-shadow-xl" />
                          </motion.div>
                          <StickVisual height={280} pose={{ pitch: -5, roll: -2 }} link="connected" />
                        </div>
                      )}
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Text & Controls */}
              <motion.div drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.2} onDragEnd={handleDragEnd} className="w-full shrink-0 touch-pan-y relative z-50">
                {/* Indicators */}
                <div className="flex justify-center gap-2 mb-8">
                  {[0, 1, 2].map((i) => (
                    <motion.div key={i} className={cx("h-1.5 rounded-full bg-white", slide === i ? "w-6 opacity-100" : "w-1.5 opacity-30")} layout transition={{ type: "spring", stiffness: 300, damping: 30 }} />
                  ))}
                </div>

                <AnimatePresence mode="wait">
                  <motion.div key={slide} initial="hidden" animate="visible" exit="hidden" variants={{ hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.1 } } }} className="text-center">
                    <motion.p variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }} className="text-[10px] font-bold tracking-[0.2em] text-teal mb-3">{SLIDES[slide].eyebrow}</motion.p>
                    <motion.h1 variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }} className="text-[28px] font-extrabold leading-[1.1] text-white mb-4 tracking-tight drop-shadow-md">{SLIDES[slide].title}</motion.h1>
                    <motion.p variants={{ hidden: { opacity: 0, y: 10 }, visible: { opacity: 1, y: 0 } }} className="text-[15px] text-white/80 leading-[1.6] min-h-[80px] font-medium drop-shadow-sm px-4">{SLIDES[slide].body}</motion.p>
                  </motion.div>
                </AnimatePresence>

                <div className="mt-2 flex gap-3 relative z-50">
                  {slide < 2 && (
                    <motion.div whileTap={{ scale: 0.95 }} className="w-1/3">
                      <GlassButton className="w-full rounded-[20px] h-14 bg-white/10 border border-white/20 text-white" onClick={() => setStep('signin')}>Skip</GlassButton>
                    </motion.div>
                  )}
                  <motion.div whileTap={{ scale: 0.95 }} className="flex-1">
                    <GlassButton variant="teal" className="w-full rounded-[20px] h-14 font-bold shadow-[0_0_20px_var(--teal)] border border-teal/50" onClick={() => slide < 2 ? setSlide(s => s + 1) : setStep('signin')}>
                      {slide === 2 ? 'Get Started' : 'Next'}
                    </GlassButton>
                  </motion.div>
                </div>
              </motion.div>
            </motion.div>
          )}

          {step === 'signin' && (
            <motion.div key="signin" initial={{ opacity: 0, filter: 'blur(20px)', scale: 1.05 }} animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }} exit={{ opacity: 0, filter: 'blur(20px)', scale: 0.95 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} className="absolute inset-0 flex flex-col px-6 pb-12 pt-[60px]">
              <div className="grid flex-1 place-items-center">
                <div className="flex flex-col items-center gap-6">
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.2, type: 'spring' }} className="relative">
                    <div className="absolute inset-0 rounded-full bg-teal blur-[60px] opacity-30" />
                    <BrandLogo variant="icon" size={140} className="rounded-[40px] overflow-hidden shadow-2xl relative z-10 border border-white/10" />
                  </motion.div>
                  <motion.span initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }} className="text-[28px] font-bold text-white tracking-tight drop-shadow-md">{BRAND.name}</motion.span>
                </div>
              </div>
              <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="text-center">
                <Body>Your account keeps your preferences and intelligence synced securely.</Body>
                {!firebaseConfigured() ? (
                  <>
                    <p className="mb-4 rounded-[18px] bg-amber-500/20 border border-amber-500/30 px-4 py-3 text-[14px] font-medium text-amber-200">No Firebase configuration found.</p>
                    <GlassButton className="w-full h-14 rounded-[20px] bg-white/10 text-white" onClick={() => setStep('welcome')}>Continue in Demo</GlassButton>
                  </>
                ) : (
                  <>
                    {auth.error && <p className="mb-4 rounded-[18px] bg-amber-500/20 border border-amber-500/30 px-4 py-3 text-[14px] font-medium text-amber-200">{auth.error}</p>}
                    <motion.div whileTap={{ scale: 0.95 }}>
                      <GlassButton variant="teal" className="w-full h-14 rounded-[20px] flex items-center justify-center font-bold text-[16px] shadow-[0_0_20px_var(--teal)] border border-teal/50" disabled={auth.busy} onClick={() => void signInWithGoogle('user').catch(() => undefined)}>
                        {auth.busy ? 'Signing in...' : (
                          <>
                            <svg viewBox="0 0 24 24" width="22" height="22" className="mr-3"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
                            Continue with Google
                          </>
                        )}
                      </GlassButton>
                    </motion.div>
                    {import.meta.env.DEV && (
                      <button type="button" className="mt-4 text-[13px] text-white/50 underline w-full text-center" onClick={() => setStep('welcome')}>[Dev] Skip Sign-In
                      </button>
                    )}
                  </>
                )}
              </motion.div>
            </motion.div>
          )}

          {step === 'welcome' && (
            <motion.div key="welcome" initial={{ opacity: 0, filter: 'blur(20px)', scale: 1.05 }} animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }} exit={{ opacity: 0, filter: 'blur(20px)', scale: 0.95 }} transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }} className="absolute inset-0 flex flex-col px-6 pb-12 pt-0">
              <div className="relative z-50 px-0 pb-4" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 16px)' }}>
                {/* Space for status bar */}
              </div>
              
              <div className="flex-1 mt-6">
                <Title>Welcome aboard</Title>
                <Body>Just two quick details to personalize your experience and keep you safe.</Body>

                <div className="mt-10 flex flex-col gap-4">
                  <button className={cx("flex items-center p-5 rounded-[24px] border text-left transition-all active:scale-[0.98]", locationAdded ? "bg-teal/10 border-teal/30" : "glass bg-white/5 border-white/10 hover:bg-white/10")} onClick={() => setStep('address')}>
                    <div className={cx("w-12 h-12 rounded-full flex items-center justify-center mr-4", locationAdded ? "bg-teal/20" : "bg-white/10")}>
                      <MapPin size={24} className={locationAdded ? "text-teal" : "text-white"} />
                    </div>
                    <div className="flex-1">
                      <h3 className={cx("font-bold text-[18px]", locationAdded ? "text-teal" : "text-white")}>Home Address</h3>
                      <p className={cx("text-[14px]", locationAdded ? "text-teal/80" : "text-white/60")}>{locationAdded ? 'Address saved' : 'For navigation & safety'}</p>
                    </div>
                    <div className="shrink-0">
                      {locationAdded ? <Check size={24} className="text-teal" /> : <ChevronRight size={24} className="text-white/30" />}
                    </div>
                  </button>

                  <button className={cx("flex items-center p-5 rounded-[24px] border text-left transition-all active:scale-[0.98]", safetyAdded ? "bg-teal/10 border-teal/30" : "glass bg-white/5 border-white/10 hover:bg-white/10")} onClick={() => setStep('safety')}>
                    <div className={cx("w-12 h-12 rounded-full flex items-center justify-center mr-4", safetyAdded ? "bg-teal/20" : "bg-white/10")}>
                      <Shield size={24} className={safetyAdded ? "text-teal" : "text-white"} />
                    </div>
                    <div className="flex-1">
                      <h3 className={cx("font-bold text-[18px]", safetyAdded ? "text-teal" : "text-white")}>Safety Number</h3>
                      <p className={cx("text-[14px]", safetyAdded ? "text-teal/80" : "text-white/60")}>{safetyAdded ? 'Emergency contact added' : 'To alert in emergencies'}</p>
                    </div>
                    <div className="shrink-0">
                      {safetyAdded ? <Check size={24} className="text-teal" /> : <ChevronRight size={24} className="text-white/30" />}
                    </div>
                  </button>
                </div>
              </div>
              
              <div className="mt-auto flex flex-col gap-3">
                <GlassButton variant="teal" className="w-full rounded-[24px] h-14 font-bold text-[17px] shadow-[0_0_20px_var(--teal)] border border-teal/50" disabled={!locationAdded && !safetyAdded} onClick={() => setStep('stick')}>Continue</GlassButton>
                <button className="w-full h-12 text-[15px] font-medium text-white/50 hover:text-white/80 transition-colors" onClick={() => setStep('stick')}>Skip for now</button>
              </div>
            </motion.div>
          )}

          {step === 'address' && (
            <motion.div key="address" initial={{ opacity: 0, filter: 'blur(20px)', scale: 1.05 }} animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }} exit={{ opacity: 0, filter: 'blur(20px)', scale: 0.95 }} transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }} className="absolute inset-0 flex flex-col px-6 pb-12 pt-0">
              <div className="relative z-50 px-0 pb-4" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 16px)' }}>
                <button onClick={() => setStep('welcome')} className="h-12 w-12 glass rounded-full flex items-center justify-center text-white shrink-0 bg-white/10 border border-white/20"><ChevronRight size={24} className="rotate-180" /></button>
              </div>
              
              <div className="flex-1 mt-6 overflow-y-auto pb-32 pt-2 px-1 scrollbar-none">
                <div className="w-14 h-14 rounded-[20px] bg-teal/20 flex items-center justify-center mb-6 border border-teal/30"><MapPin size={28} className="text-teal" /></div>
                <Title>Home Address</Title>
                <Body>Set your home location for navigation and safety geofences.</Body>
                
                <div className="relative mt-8">
                  <label className="absolute left-4 top-3 text-[12px] font-bold tracking-wider text-teal uppercase z-10">Address</label>
                  <textarea
                    autoFocus
                    placeholder="e.g. 123 Main St, Apartment 4B"
                    className="w-full bg-white/5 border border-white/10 rounded-[20px] pt-9 pb-4 px-4 text-white outline-none text-[18px] placeholder:text-white/20 focus:border-teal/50 focus:bg-white/10 transition-colors resize-none shadow-inner"
                    rows={4}
                    value={addressQuery}
                    onChange={(e) => setAddressQuery(e.target.value)}
                  />
                </div>
              </div>
              
              <div className="mt-auto flex flex-col gap-3">
                <GlassButton variant="teal" className="w-full rounded-[24px] h-14 font-bold text-[17px] shadow-[0_0_20px_var(--teal)] border border-teal/50" disabled={addressQuery.trim().length < 5} onClick={async () => {
                  try {
                    const { updateProfileFields } = await import('../../core/auth/authService');
                    await updateProfileFields({ homeAddress: addressQuery.trim() });
                  } catch (e) {
                    console.error('Failed to save home address', e);
                  }
                  setLocationAdded(true);
                  setStep('welcome');
                }}>Save Address</GlassButton>
              </div>
            </motion.div>
          )}

          {step === 'safety' && (
            <motion.div key="safety" initial={{ opacity: 0, filter: 'blur(20px)', scale: 1.05 }} animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }} exit={{ opacity: 0, filter: 'blur(20px)', scale: 0.95 }} transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }} className="absolute inset-0 flex flex-col px-6 pb-12 pt-0">
              <div className="relative z-50 px-0 pb-4" style={{ paddingTop: 'calc(var(--island, var(--sat)) + 16px)' }}>
                <button onClick={() => setStep('welcome')} className="h-12 w-12 glass rounded-full flex items-center justify-center text-white shrink-0 bg-white/10 border border-white/20"><ChevronRight size={24} className="rotate-180" /></button>
              </div>
              
              <div className="flex-1 mt-6 overflow-y-auto pb-32 pt-2 px-1 scrollbar-none">
                <div className="w-14 h-14 rounded-[20px] bg-teal/20 flex items-center justify-center mb-6 border border-teal/30"><Shield size={28} className="text-teal" /></div>
                <Title>Safety Number</Title>
                <Body>Add a trusted contact to alert during emergencies.</Body>

                <div className="flex gap-3 mt-8 mb-6">
                  <div className="relative w-28">
                    <label className="absolute left-4 top-2 text-[11px] font-bold tracking-wider text-teal uppercase z-10">Code</label>
                    <input type="text" className="w-full bg-white/5 border border-white/10 rounded-[20px] pt-7 pb-3 px-4 text-white outline-none font-bold text-[18px] text-center focus:border-teal/50 focus:bg-white/10 transition-colors shadow-inner" value={countryCode} onChange={(e) => setCountryCode(e.target.value)} />
                  </div>
                  <div className="relative flex-1">
                    <label className="absolute left-4 top-2 text-[11px] font-bold tracking-wider text-teal uppercase z-10">Phone Number</label>
                    <input type="tel" autoFocus placeholder="98765 43210" className="w-full bg-white/5 border border-white/10 rounded-[20px] pt-7 pb-3 px-4 text-white outline-none text-[20px] font-bold tracking-wide placeholder:font-medium placeholder:text-white/20 focus:border-teal/50 focus:bg-white/10 transition-colors shadow-inner" value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value.replace(/[^\ds-]/g, ''))} />
                  </div>
                </div>

                </div>

              <div className="mt-auto flex flex-col gap-3 relative z-10">
                <GlassButton variant="teal" className="w-full rounded-[24px] h-14 font-bold text-[17px] shadow-[0_0_20px_var(--teal)] border border-teal/50" disabled={phoneNumber.length < 5} onClick={() => {
                  const full = countryCode + phoneNumber;
                    setSafetyAdded(true);
                    useSession.setState(s => ({ contacts: [...s.contacts.filter(c => c.id !== 'emergency'), { id: 'emergency', name: 'Emergency Contact', relation: 'emergency', phone: full, aliases: [] }] }));
                    try {
                      import('../../core/backend/api').then(({ call }) => {
                        call('sendSms', { to: full, body: 'You have been added as an Emergency Contact for an AI SmartStick user.' }).catch(() => {});
                      });
                    } catch (e) {}
                    setStep('welcome');
                }}>
                  Save Number
                </GlassButton>
              </div>
            </motion.div>
          )}

          {step === 'stick' && (
            <motion.div key="stick" initial={{ opacity: 0, filter: 'blur(20px)', scale: 1.05 }} animate={{ opacity: 1, filter: 'blur(0px)', scale: 1 }} exit={{ opacity: 0, filter: 'blur(20px)', scale: 0.95 }} transition={{ duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }} className="absolute inset-0">
              <StickSetup onDone={() => {
                useSession.setState({ userOnboarded: true });
              }} onCancel={() => {
                useSession.setState({ userOnboarded: true });
              }} />
            </motion.div>
          )}

        </AnimatePresence>
      </div>
    </AppScreen>
  );
}
