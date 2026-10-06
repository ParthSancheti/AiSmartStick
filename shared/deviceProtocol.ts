/**
 * AI Smart Stick device protocol, version 1.
 * Shared by the app, the Cloud Functions and (as documentation) the firmware.
 * See DEVICE_PROTOCOL.md for the wire format, auth scheme and examples.
 */
export const PROTOCOL_VERSION = 1 as const;
export const DEVICE_MODEL = 'AISS-ESP32CAM-1' as const;

export const DEVICE_API = {
  device: '/api/v1/device',
  status: '/api/v1/status',
  telemetry: '/api/v1/telemetry',
  capture: '/api/v1/capture',
  config: '/api/v1/config',
  command: '/api/v1/command',
  provision: '/api/v1/provision',
  ota: '/api/v1/ota',
} as const;

/** SoftAP the stick raises after a 5 s button hold: "AISmartStick-4F2A". */
export const SETUP_AP_PREFIX = 'AISmartStick-';
export const SETUP_AP_HOST = '192.168.4.1';
/**
 * Dashcam topology (current firmware, Net.cpp startSetupAp): the stick ALWAYS runs its own access
 * point and never joins another network. The phone binds this one network for stick traffic
 * (WifiNetworkSpecifier) while mobile data stays the default route for Firebase, Maps and Gemini.
 */
export const STICK_AP_SSID = 'SmartStick_AI';
export const STICK_AP_PASSPHRASE = 'Stick@1234';
/** Provisioning still validates station credentials (8–63 char password) although dashcam mode never uses them. */
export const DASHCAM_STATION_PLACEHOLDER = { ssid: 'dashcam-ap-only', password: 'dashcam-ap-only' } as const;
/** The stick announces itself on the phone's hotspot with UDP broadcast on this port. */
export const DISCOVERY_UDP_PORT = 4210;
/** mDNS host: aismartstick-<last4>.local */
export const MDNS_PREFIX = 'aismartstick-';

export type HapticSemantic = 'danger' | 'warning' | 'tap' | 'confirm' | 'sos' | 'locate' | 'nudge';

/** ECU-local obstacle zone (SafetyLogic.h). Decided on the stick, never by the phone or the AI. */
export type ObstacleZone = 'unknown' | 'normal' | 'awareness' | 'warning' | 'danger';
export type ButtonGesture = 'single' | 'double' | 'triple' | 'long' | 'setup';

/** Raw edge or firmware-classified gesture. The app accepts either (see core/telemetry/button.ts). */
export interface ButtonEvent {
  /** Monotonic per boot; used for de-duplication across polls. */
  id: number;
  kind: 'press' | 'release' | 'gesture';
  gesture?: ButtonGesture;
  atMs: number;
  durationMs?: number;
}

/** Processed safety events from the on-stick ECU (Nano / future firmware). */
export interface EcuSafetyEvent {
  id: number;
  type: 'fall' | 'obstacle' | 'sensor_fault';
  atMs: number;
  value?: number;
  confidence?: number;
}

export type UltrasonicRawStatus = 'ok' | 'no_echo' | 'out_of_range' | 'invalid' | 'timeout' | 'error';

export interface TelemetryPacket {
  v: 1;
  deviceId: string;
  /** Increments on every sample; resets on reboot (uptime also resets). */
  seq: number;
  uptimeMs: number;
  battery: {
    /** INA219 bus voltage (V) at the battery side. */
    busV: number | null;
    shuntMv: number | null;
    /** Positive = discharging, negative = charging (per wiring, see DEVICE_PROTOCOL.md). */
    currentMa: number | null;
    powerMw?: number | null;
    /** From a charger STAT pin if wired; null when the firmware cannot know. */
    charging: boolean | null;
    chargeSource: 'pin' | 'current' | 'none';
    ok: boolean;
  };
  imu: {
    ax: number | null;
    ay: number | null;
    az: number | null;
    gx: number | null;
    gy: number | null;
    gz: number | null;
    /** Degrees, computed on the device from the accelerometer (legacy firmware field `pitch`). */
    pitch: number | null;
    roll: number | null;
    ok: boolean;
  };
  ultrasonic: {
    distanceCm: number | null;
    echoUs: number | null;
    status: UltrasonicRawStatus;
    sampleAgeMs: number;
    /** ECU safety-state-machine zone (with hysteresis/confirmation). Optional for legacy firmware. */
    zone?: ObstacleZone;
  };
  /** Button events from the last 5 s (device keeps a queue of 16; the app de-duplicates by id). */
  button: ButtonEvent[];
  safety?: EcuSafetyEvent[];
  rssi: number | null;
  health: DeviceHealth;
}

export interface DeviceHealth {
  camera: 'ok' | 'error' | 'busy';
  i2c: 'ok' | 'error';
  motor: 'idle' | 'running';
  heapFree?: number;
  heapMin?: number;
  psramFree?: number;
  resetReason?: string;
  bootCount?: number;
  mode?: 'normal' | 'sleep' | 'setup' | 'safe';
  configVersion?: number;
  firmware?: string;
  wifi?: 'off' | 'connecting' | 'connected' | 'lost' | 'setup_ap';
  /** Machine codes: camera_init, camera_capture, i2c, imu, ina219, ultrasonic_stale, wifi, heap_low, config */
  errors?: string[];
}

/** GET /api/v1/status */
export interface DeviceStatusPacket {
  deviceId: string;
  protocolVersion: number;
  uptimeMs: number;
  rssi: number | null;
  health: DeviceHealth;
}

/**
 * Canonical device configuration — ONE model shared by app settings and ECU (DeviceConfig.h).
 * Versioned: the ECU rejects a configVersion that is not newer than the active one.
 */
export interface DeviceConfig {
  configVersion: number;
  obstacle: { enabled: boolean; awarenessCm: number; warningCm: number; dangerCm: number; hysteresisCm: number; confirmSamples: number };
  haptics: { intensity: number; obstacleAlerts: boolean };
  fall: { enabled: boolean; impactG: number; freeFallG: number; tiltDeg: number; inactivityMs: number };
  power: { autoSleepMin: number };
}

export interface DeviceInfoPacket {
  deviceId: string;
  model: string;
  firmware: string;
  protocolVersion: number;
  paired: boolean;
  uptimeMs: number;
  /** HMAC-SHA256(deviceKey, challenge + deviceId), hex. Proves the stick holds the key. */
  proof?: string;
}

export type DeviceCommand =
  | { type: 'haptic'; pattern: HapticSemantic; intensity?: number }
  | { type: 'locate' }
  | { type: 'nudge' }
  | { type: 'setMode'; mode: 'normal' | 'sleep' }
  | { type: 'setConfig'; config: DeviceConfig }
  | { type: 'getConfig' }
  | { type: 'selfTest' }
  | { type: 'calibrateImu' }
  | { type: 'reboot' }
  | { type: 'factoryReset' };

export const DEVICE_COMMAND_TYPES = ['haptic', 'locate', 'nudge', 'setMode', 'setConfig', 'getConfig', 'selfTest', 'calibrateImu', 'reboot', 'factoryReset'] as const;

/** Wire envelope for POST /api/v1/command (idempotent by commandId, bounded by expiresAt). */
export interface CommandEnvelope {
  commandId: string;
  type: DeviceCommand['type'];
  payload: Record<string, unknown>;
  issuedAt: number;
  expiresAt: number;
}

export type CommandStatus = 'completed' | 'failed' | 'rejected' | 'expired' | 'duplicate';

export interface CommandAck {
  commandId: string;
  status: CommandStatus;
  error?: string;
  result?: Record<string, unknown>;
}

/** Sent once over the stick's setup AP. */
export interface ProvisioningPacket {
  v: 1;
  /** Phone hotspot SSID and password the stick should join. */
  ssid: string;
  password: string;
  /** 32 random bytes, base64. Becomes the HMAC key for every later request. */
  deviceKey: string;
  /** SHA-256(userUid), hex. Lets the stick report who it belongs to without storing the uid. */
  ownerHash: string;
  nonce: string;
}

export interface ProvisioningResult {
  ok: boolean;
  deviceId: string;
  model: string;
  firmware: string;
  protocolVersion: number;
  error?: DeviceErrorCode;
}

export type DeviceErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'busy'
  | 'camera_error'
  | 'not_found'
  | 'unsupported_version'
  | 'provision_failed'
  | 'replay';

export interface DeviceError {
  error: DeviceErrorCode;
  message?: string;
}

/** JSON body of the UDP discovery broadcast on the phone hotspot. */
export interface DiscoveryAnnouncement {
  v: 1;
  deviceId: string;
  ip: string;
  port: number;
  uptimeMs: number;
  /** HMAC-SHA256(deviceKey, deviceId + ip + uptimeMs), hex. */
  sig: string;
}

/** Headers returned with /api/v1/capture. */
export const CAPTURE_HEADERS = {
  width: 'x-aiss-width',
  height: 'x-aiss-height',
  timestamp: 'x-aiss-ts',
  seq: 'x-aiss-seq',
} as const;

/** Request auth headers (see DEVICE_PROTOCOL.md §Authentication). */
export const AUTH_HEADERS = {
  device: 'x-aiss-device',
  ts: 'x-aiss-ts',
  nonce: 'x-aiss-nonce',
  sig: 'x-aiss-sig',
} as const;

/** Legacy test firmware (/data JSON). Mapped by core/device/legacyAdapter.ts. */
export interface LegacyDataPacket {
  distance_cm?: number;
  pitch?: number;
  roll?: number;
  button_state?: number | boolean;
  battery_pct?: number;
  is_charging?: boolean | number;
}
