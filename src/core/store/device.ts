import { create } from 'zustand';
import type { LinkState, NetworkStrategy } from '../types';
import type { DeviceIdentity } from '../transport/types';
import type { DeviceHealth, ObstacleZone } from '../../../shared/deviceProtocol';
import { unknownBattery, unknownCamera, unknownImu, unknownUltrasonic, type BatteryState, type CameraState, type ImuState, type UltrasonicState } from '../telemetry/types';

/**
 * THE device state. Home, Settings, Diagnostics, Safety, the assistant and the sync layer
 * all read from here; nothing keeps its own "isConnected" boolean.
 */
export interface DeviceData {
  link: LinkState;
  linkDetail: string | null;
  /** Phone internet reachability: true/false once probed, null = not yet known. */
  internet: boolean | null;
  identity: DeviceIdentity | null;
  battery: BatteryState;
  imu: ImuState;
  ultrasonic: UltrasonicState;
  camera: CameraState;
  /** ECU-local obstacle zone (decided on the stick with hysteresis). 'unknown' without a sensor/link. */
  zone: ObstacleZone;
  /** Last device-reported health block (reset reason, errors, mode, config version, firmware). */
  health: DeviceHealth | null;
  /** Device configuration sync: desired vs. acknowledged by the ECU. */
  configSync: { desiredVersion: number | null; appliedVersion: number | null; state: 'idle' | 'pending' | 'applied' | 'rejected' | 'offline'; error: string | null };
  rssi: number | null;
  lastPacketAt: number | null;
  /** Last successful write of live state to the cloud (user phone). */
  lastSync: number | null;
  source: 'mock' | 'http' | null;
}

interface DeviceState extends DeviceData {
  set: (p: Partial<DeviceData>) => void;
}

export const initialDevice = (): DeviceData => ({
  link: 'unpaired',
  linkDetail: null,
  internet: null,
  identity: null,
  battery: unknownBattery(),
  imu: unknownImu(),
  ultrasonic: unknownUltrasonic(),
  camera: unknownCamera(),
  zone: 'unknown',
  health: null,
  configSync: { desiredVersion: null, appliedVersion: null, state: 'idle', error: null },
  rssi: null,
  lastPacketAt: null,
  lastSync: null,
  source: null,
});

export const useDevice = create<DeviceState>((set) => ({
  ...initialDevice(),
  set: (p) => set(p),
}));

export function deriveStrategy(stick: boolean, internet: boolean): NetworkStrategy {
  if (stick && internet) return 'full';
  if (stick) return 'local';
  if (internet) return 'cloud';
  return 'offline';
}

/** Verified and answering (possibly degraded). Use this, never `link === 'connected'` alone. */
export const isLinked = (link: LinkState) => link === 'connected' || link === 'degraded';
export const selectStrategy = (s: Pick<DeviceData, 'link' | 'internet'>) => deriveStrategy(isLinked(s.link), s.internet === true);
export const getStrategy = () => selectStrategy(useDevice.getState());
export const stickConnected = () => isLinked(useDevice.getState().link);

/**
 * Remaining-runtime estimate from MEASURED discharge (filtered % samples over ≥ 20 min while not
 * charging). Returns null when there isn't enough data — never an assumed capacity.
 */
export const batteryHours = (samples: { t: number; pct: number; charging: boolean | null }[]) => {
  const dis = samples.filter((s) => s.charging === false);
  if (dis.length < 2) return null;
  const a = dis[0];
  const b = dis[dis.length - 1];
  const minutes = (b.t - a.t) / 60000;
  const drop = a.pct - b.pct;
  if (minutes < 20 || drop < 2) return null;
  const left = (b.pct / drop) * minutes;
  const h = Math.floor(left / 60);
  const m = Math.round(left % 60);
  return h > 0 ? `about ${h} h ${m} min` : `about ${m} min`;
};
