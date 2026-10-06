import type { CommandAck, DeviceCommand, TelemetryPacket } from '../../../shared/deviceProtocol';
import type { LinkState } from '../types';

export interface DeviceIdentity {
  deviceId: string;
  model: string;
  firmware: string;
  protocolVersion: number;
}

export interface StickEvents {
  /** One validated-shape telemetry packet from the stick (raw, before filtering). */
  packet: (p: TelemetryPacket, receivedAt: number) => void;
  link: (s: LinkState, detail?: string) => void;
  identity: (id: DeviceIdentity) => void;
}

export interface CapturedFrame {
  blob: Blob;
  width: number | null;
  height: number | null;
  capturedAt: number;
  /** Demo only: which synthetic scene was drawn. */
  scene?: number;
}

/**
 * One interface, many transports. The rest of the app only talks to this.
 * MockTransport (demo mode only) and HttpTransport (real ESP32 on the phone hotspot).
 */
export interface StickTransport {
  readonly kind: 'mock' | 'http';
  connect(): Promise<void>;
  disconnect(): void;
  on<E extends keyof StickEvents>(event: E, cb: StickEvents[E]): () => void;
  captureFrame(opts?: { sceneHint?: number; timeoutMs?: number }): Promise<CapturedFrame>;
  /** Sends an idempotent, expiring command and resolves with the stick's acknowledgement. */
  send(cmd: DeviceCommand, opts?: { commandId?: string; ttlMs?: number }): Promise<CommandAck>;
  /** Pushes a new firmware binary to the stick. */
  pushOTA?(blob: Blob, sha256: string): Promise<void>;
}

export class Emitter<T extends { [K in keyof T]: (...args: never[]) => void }> {
  private map = new Map<keyof T, Set<T[keyof T]>>();
  on<E extends keyof T>(e: E, cb: T[E]) {
    if (!this.map.has(e)) this.map.set(e, new Set());
    this.map.get(e)!.add(cb);
    return () => {
      this.map.get(e)?.delete(cb);
    };
  }
  emit<E extends keyof T>(e: E, ...args: Parameters<T[E]>) {
    this.map.get(e)?.forEach((cb) => (cb as (...a: Parameters<T[E]>) => void)(...args));
  }
  clear() {
    this.map.clear();
  }
}

/** JPEG sanity check: SOI/EOI markers, plausible size. The camera is never trusted blindly. */
export async function validateJpeg(blob: Blob): Promise<string | null> {
  if (blob.size < 2_000) return 'frame too small';
  if (blob.size > 2_000_000) return 'frame too large';
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  // Some camera drivers pad the buffer after EOI; accept EOI within the last 64 bytes.
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 64)).arrayBuffer());
  if (head[0] !== 0xff || head[1] !== 0xd8) return 'not a JPEG (missing SOI)';
  let eoi = false;
  for (let i = tail.length - 2; i >= 0 && !eoi; i--) eoi = tail[i] === 0xff && tail[i + 1] === 0xd9;
  if (!eoi) return 'truncated JPEG (missing EOI)';
  return null;
}

export const newCommandId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Splits a DeviceCommand into the wire envelope's type + payload. */
export function toEnvelopeParts(cmd: import('../../../shared/deviceProtocol').DeviceCommand) {
  const { type, ...payload } = cmd as { type: string } & Record<string, unknown>;
  return { type, payload };
}

/** Largest telemetry response accepted; anything bigger is treated as malformed. */
export const MAX_TELEMETRY_BYTES = 16_384;
