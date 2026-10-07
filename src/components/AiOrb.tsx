import { ShieldAlert, WifiOff, Unlink } from 'lucide-react';

export type AiOrbPhase = 'ready' | 'listening' | 'thinking' | 'vision' | 'speaking' | 'navigating' | 'interrupted' | 'error' | 'offline' | 'disconnected' | 'sos';

const SPIN: Record<AiOrbPhase, number> = { ready: 24, listening: 8, thinking: 2.4, vision: 1.8, speaking: 6, navigating: 14, interrupted: 24, error: 0, offline: 0, disconnected: 0, sos: 1 };
const PULSE: Record<AiOrbPhase, { scale: number[]; duration: number }> = {
  ready: { scale: [1, 1.025, 1], duration: 4.8 },
  listening: { scale: [1, 1.06, 1.015, 1.05, 1], duration: 1.2 },
  thinking: { scale: [1, 0.965, 1], duration: 1.3 },
  speaking: { scale: [1, 1.05, 0.99, 1.035, 1], duration: 0.85 },
  vision: { scale: [1, 0.95, 1], duration: 1.0 },
  navigating: { scale: [1, 1.02, 1], duration: 3.2 },
  interrupted: { scale: [1, 1], duration: 1 },
  error: { scale: [1, 1], duration: 1 },
  offline: { scale: [1, 1], duration: 1 },
  disconnected: { scale: [1, 1], duration: 1 },
  sos: { scale: [1, 1.15, 1], duration: 0.5 },
};

const LABELS: Record<AiOrbPhase, string> = {
  ready: 'Assistant is ready',
  listening: 'Listening to your command',
  thinking: 'Thinking about what you said',
  speaking: 'Speaking',
  vision: 'Looking through the stick camera',
  navigating: 'Guiding your walk',
  interrupted: 'Stopped for a more important message',
  error: 'The last request did not work',
  offline: 'Phone is offline',
  disconnected: 'Assistant is disconnected',
  sos: 'Emergency SOS active'
};

/**
 * The assistant's body. One living object on the screen: its motion tells a
 * low-vision user what the assistant is doing even without reading.
 */
export function AiOrb({ size = 220, phase, holdProgress = 0 }: { size?: number; phase: AiOrbPhase; holdProgress?: number }) {
  const pulse = PULSE[phase];
  const C = 2 * Math.PI * 47;

  const isError = phase === 'offline' || phase === 'disconnected' || phase === 'error';
  const isSos = phase === 'sos';
  // All continuous motion is CSS keyframes on transform/opacity (styles.css .orb-*): it runs on the
  // compositor and never wakes the JS thread. The spinning colour field is pre-softened with extra
  // gradient stops and a soft radial veil instead of a live blur filter (expensive on phones).
  const amp = Math.max(...pulse.scale) - 1;
  const vars = {
    ['--orb-spin' as string]: `${SPIN[phase] || 1}s`,
    ['--orb-pulse' as string]: `${pulse.duration}s`,
    ['--orb-amp' as string]: String(1 + amp),
  };

  return (
    <div
      className="relative grid place-items-center"
      style={{ width: size, height: size, ...vars }}
      role="status"
      aria-live="polite"
      aria-label={LABELS[phase]}
    >
      {/* Background glow */}
      <div
        aria-hidden
        className="absolute rounded-full transition-[opacity,transform] duration-500"
        style={{
          inset: -size * 0.22,
          opacity: phase === 'ready' || isError ? 0.6 : 1,
          transform: phase === 'ready' || isError ? 'scale(1)' : 'scale(1.08)',
          background: isSos
            ? 'radial-gradient(closest-side, rgba(239, 68, 68, 0.6), transparent)'
            : isError
            ? 'radial-gradient(closest-side, rgba(245, 158, 11, 0.4), transparent)'
            : phase === 'thinking' || phase === 'vision'
            ? 'radial-gradient(closest-side, rgba(147, 51, 234, 0.5), transparent)'
            : 'radial-gradient(closest-side, rgba(34, 211, 238, 0.45), transparent)',
        }}
      />

      {/* Listening / SOS ripples */}
      {(phase === 'listening' || isSos) &&
        [0, 1, 2].map((i) => (
          <span
            key={`${phase}-${i}`}
            aria-hidden
            className={`orb-ripple absolute inset-0 rounded-full ${isSos ? 'border-4 border-sos/80' : 'border-2 border-mint/60'}`}
            style={{ animationDuration: isSos ? '1s' : '1.8s', animationDelay: `${i * (isSos ? 0.3 : 0.6)}s`, ['--orb-ripple' as string]: isSos ? 1.8 : 1.6 }}
          />
        ))}

      {/* Main orb body */}
      <div
        aria-hidden
        className={`relative grid place-items-center overflow-hidden rounded-full ${phase === 'interrupted' || isError ? '' : 'orb-pulse'}`}
        style={{ width: size, height: size, boxShadow: isSos ? '0 30px 60px -28px rgba(239,68,68,.7)' : '0 30px 60px -28px rgba(37,99,235,.4)' }}
      >
        {/* Core colour field */}
        <div
          className={`absolute ${isError ? '' : 'orb-spin'}`}
          style={{
            inset: '-30%',
            borderRadius: '50%',
            background: isSos
              ? 'conic-gradient(from 0deg, #ef4444, #dc2626, #b91c1c, #991b1b, #b91c1c, #dc2626, #ef4444)'
              : isError
              ? 'conic-gradient(from 0deg, #f59e0b, #d97706, #b45309, #78350f, #b45309, #d97706, #f59e0b)'
              : 'conic-gradient(from 0deg, #22d3ee, #1fa6ec, #2563eb, #5b48e8, #9333ea, #c040c0, #ec4899, #8f8fe8, #22d3ee)',
          }}
        />
        {/* Soft veil: hides the conic centre point (what the blur used to do) */}
        <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 50%, rgba(255,255,255,.35), rgba(255,255,255,.12) 35%, transparent 70%)' }} />

        {/* Thinking overlay */}
        <div
          className="absolute inset-0 transition-opacity duration-500"
          style={{ opacity: phase === 'thinking' || phase === 'vision' ? 1 : 0, background: 'radial-gradient(circle at 50% 62%, rgba(147,51,234,.6), transparent 62%)' }}
        />

        {/* Lighting specular highlight */}
        <div className="absolute inset-0" style={{ borderRadius: 'inherit', background: 'radial-gradient(58% 40% at 33% 22%, rgba(255,255,255,.92), rgba(255,255,255,0) 62%)' }} />

        {/* Inner shadow for 3D sphere effect */}
        <div
          className="absolute inset-0"
          style={{
            borderRadius: 'inherit',
            boxShadow: isSos
              ? 'inset 0 -22px 44px rgba(185,28,28,.6), inset 0 3px 2px rgba(255,255,255,.75), inset 0 0 0 1.5px rgba(255,255,255,.45)'
              : 'inset 0 -22px 44px rgba(37,99,235,.38), inset 0 3px 2px rgba(255,255,255,.75), inset 0 0 0 1.5px rgba(255,255,255,.45)',
          }}
        />

        {/* State icons */}
        {phase === 'offline' && <WifiOff size={size * 0.4} className="relative z-10 text-white drop-shadow-md" />}
        {phase === 'disconnected' && <Unlink size={size * 0.4} className="relative z-10 text-white drop-shadow-md" />}
        {phase === 'sos' && <ShieldAlert size={size * 0.4} className="relative z-10 text-white drop-shadow-md" />}
      </div>

      {/* SOS countdown ring */}
      {holdProgress > 0 && (
        <svg aria-hidden className="absolute" style={{ inset: -16, width: size + 32, height: size + 32 }} viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="47" fill="none" stroke="var(--sos)" strokeOpacity="0.18" strokeWidth="3" />
          <circle
            cx="50"
            cy="50"
            r="47"
            fill="none"
            stroke="var(--sos)"
            strokeWidth="3.4"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - holdProgress)}
            transform="rotate(-90 50 50)"
          />
        </svg>
      )}
    </div>
  );
}

/** ONE mapping from real system state to the orb (no animation-only states). */
export function orbPhaseFor(o: { assistant: import('../core/types').AssistantPhase; sosActive: boolean; internet: boolean | null; navigating: boolean; unavailable: string | null }): AiOrbPhase {
  if (o.sosActive) return 'sos';
  switch (o.assistant) {
    case 'listening':
    case 'thinking':
    case 'vision':
    case 'speaking':
    case 'interrupted':
    case 'error':
      return o.assistant;
  }
  if (o.internet === false) return 'offline';
  if (o.navigating) return 'navigating';
  return 'ready';
}
