export type Role = 'guardian' | 'user';
/** Stick ↔ phone link. 'unpaired' = no stick provisioned; 'auth_failed' = a stick answered but failed the key check. */
/**
 * 'degraded' = verified and answering, but slow/lossy or reporting hardware errors.
 * 'protocol_mismatch' = the stick firmware speaks another protocol version (terminal until updated).
 */
export type LinkState = 'unpaired' | 'searching' | 'connecting' | 'connected' | 'degraded' | 'reconnecting' | 'disconnected' | 'auth_failed' | 'protocol_mismatch';
/** What the phone can reach right now: stick (local link) × cloud (internet). */
export type NetworkStrategy = 'full' | 'local' | 'cloud' | 'offline';
/**
 * Assistant state machine (drives the AI Orb). 'listening' includes live transcription (partial
 * results are shown as they arrive); 'vision' = capturing/analysing a photo; 'interrupted' = speech
 * was cut by a higher-priority announcement; 'error' = the last request failed (auto-clears).
 */
export type AssistantPhase = 'idle' | 'listening' | 'thinking' | 'vision' | 'speaking' | 'interrupted' | 'error';
export type SosPhase = 'idle' | 'countdown' | 'active' | 'resolved';
export type SosTrigger = 'button' | 'voice' | 'fall';
/** How an active SOS left the phone: through the cloud, or via SMS fallback when there's no data. */
export type SosDelivery = 'pending' | 'cloud' | 'sms';
export type ReplyLang = 'en' | 'hi';
export type ButtonPattern = 'single' | 'double' | 'triple' | 'hold' | 'setup-hold';
export type GlassTier = 'full' | 'lite' | 'solid';
export type ThemePref = 'system' | 'light' | 'dark';

export interface Point { x: number; y: number }


export type EventKind = 'safety' | 'navigation' | 'device' | 'vision' | 'message';
export type Severity = 'info' | 'success' | 'warning' | 'critical';
export interface ActivityEvent {
  id: string;
  ts: number;
  kind: EventKind;
  severity: Severity;
  title: string;
  detail?: string;
}

export type PlaceCategory = 'mall' | 'pharmacy' | 'hospital' | 'bus' | 'atm' | 'cafe' | 'home';
export interface Place {
  id: string;
  name: string;
  nameHi: string;
  category: PlaceCategory;
  pos: Point;
  address: string;
}

export type Turn = 'start' | 'left' | 'right' | 'arrive';
export interface RouteStep {
  /** distance along the route (map units) where this step begins */
  startAt: number;
  turn: Turn;
  street: string;
  lengthU: number;
  heading: 'north' | 'south' | 'east' | 'west';
}

export interface Contact {
  id: string;
  name: string;
  relation: string;
  phone: string;
  aliases: string[];
}

export interface VisionFrame {
  blob: Blob;
  ts: number;
  scene: number;
  origin: 'assistant' | 'guardian' | 'sos';
  description?: string;
}

export interface ToolCard {
  kind: 'navigation' | 'call' | 'message' | 'scene' | 'status' | 'sos' | 'location';
  title: string;
  detail?: string;
}
