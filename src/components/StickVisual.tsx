import { motion, useReducedMotion } from 'motion/react';
import type { LinkState } from '../core/types';
import { useDevice } from '../core/store/device';

/**
 * 2.5D render of the AI Smart Stick: handle + button, sensor pod (2 ultrasonic eyes + camera), reflective bands.
 * Orientation comes from ONE source: the filtered MPU6050 state in the device store (pose="live").
 * The Guardian passes its own link/obstacle values from the cloud feed and pose={null}.
 */
export function StickVisual({
  height = 200,
  link: linkProp,
  obstacleCm: obstacleProp,
  pose = 'live',
}: {
  height?: number;
  link?: LinkState;
  obstacleCm?: number | null;
  pose?: 'live' | { pitch: number; roll: number } | null;
}) {
  const reduce = useReducedMotion();
  const storeLink = useDevice((s) => s.link);
  const imu = useDevice((s) => s.imu);
  const us = useDevice((s) => (s.ultrasonic.status === 'ok' ? s.ultrasonic.distanceCm : null));
  const link = linkProp ?? storeLink;
  const obstacleCm = obstacleProp === undefined ? us : obstacleProp;
  const live = pose === 'live' ? (imu.status === 'ok' && imu.pitch != null ? { pitch: imu.pitch, roll: imu.roll ?? 0 } : null) : pose;
  const tilt = live ? -16 + Math.max(-40, Math.min(40, live.pitch)) : -16;
  const sway = live ? Math.max(-8, Math.min(8, live.roll / 4)) : 0;
  const led = link === 'connected' || link === 'degraded' ? '#19c3a8' : link === 'disconnected' ? '#f0a02a' : '#8fe9d6';
  const near = obstacleCm != null && obstacleCm < 150;
  const danger = obstacleCm != null && obstacleCm < 60;
  return (
    <div className="relative shrink-0" style={{ height, width: height * 0.56 }} aria-hidden>
      <svg viewBox="0 0 130 240" className="h-full w-full overflow-visible">
        <defs>
          <linearGradient id="ss-shaft" x1="0" x2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset=".45" stopColor="#eef3f2" />
            <stop offset="1" stopColor="#b9c6c5" />
          </linearGradient>
          <linearGradient id="ss-handle" x1="0" x2="1">
            <stop offset="0" stopColor="#3b4a50" />
            <stop offset=".5" stopColor="#1b2529" />
            <stop offset="1" stopColor="#0d1417" />
          </linearGradient>
          <linearGradient id="ss-pod" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#cfdbd9" />
          </linearGradient>
          <radialGradient id="ss-shadow">
            <stop offset="0" stopColor="rgba(16,36,42,.32)" />
            <stop offset="1" stopColor="rgba(16,36,42,0)" />
          </radialGradient>
          <radialGradient id="ss-led">
            <stop offset="0" stopColor={led} stopOpacity="1" />
            <stop offset="1" stopColor={led} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="92" cy="236" rx="34" ry="5" fill="url(#ss-shadow)" />
        <motion.g animate={reduce || live ? undefined : { y: [0, -4, 0] }} transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}>
          <motion.g animate={{ rotate: tilt, x: sway }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} style={{ originX: '65px', originY: '120px', transformBox: 'view-box' }}>
            <rect x="59.5" y="40" width="11" height="186" rx="5.5" fill="url(#ss-shaft)" />
            <rect x="61" y="44" width="2" height="176" rx="1" fill="#fff" opacity=".9" />
            <rect x="59.5" y="176" width="11" height="8" fill="#0fa08e" />
            <rect x="59.5" y="190" width="11" height="8" fill="#0fa08e" />
            <rect x="60.5" y="220" width="9" height="14" rx="4" fill="#1b2529" />
            <rect x="53" y="6" width="24" height="52" rx="12" fill="url(#ss-handle)" />
            <circle cx="65" cy="24" r="6" fill="#0d1417" />
            <circle cx="65" cy="24" r="4.4" fill={led} opacity=".95" />
            <circle cx="65" cy="24" r="10" fill="url(#ss-led)" opacity={link === 'connected' || link === 'degraded' ? 0.7 : 0.35} />
            <rect x="50" y="64" width="30" height="42" rx="11" fill="url(#ss-pod)" stroke="rgba(16,36,42,.12)" />
            <circle cx="58" cy="79" r="6.2" fill="#1d2a2e" />
            <circle cx="72" cy="79" r="6.2" fill="#1d2a2e" />
            <circle cx="58" cy="79" r="3.4" fill="#4a5a5f" />
            <circle cx="72" cy="79" r="3.4" fill="#4a5a5f" />
            <circle cx="65" cy="96" r="4" fill="#0b1418" />
            <circle cx="64" cy="95" r="1.2" fill="#9fd9ff" />
            {near &&
              [0, 1, 2].map((i) => (
                <motion.path
                  key={i}
                  d={`M ${44 - i * 9} ${66 - i * 6} Q ${36 - i * 12} ${79} ${44 - i * 9} ${92 + i * 6}`}
                  fill="none"
                  stroke={danger ? 'var(--sos)' : 'var(--teal)'}
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 0.9, 0] }}
                  transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.22 }}
                />
              ))}
          </motion.g>
        </motion.g>
      </svg>
    </div>
  );
}
