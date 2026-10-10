/** Request/response contract between the app and the assistant Cloud Function. */
export type Lang = 'en' | 'hi';

export interface AssistantContext {
  deviceConnected: boolean;
  internet: boolean;
  navigating: boolean;
  sosPhase: 'idle' | 'countdown' | 'active' | 'resolved';
  locationAvailable: boolean;
  guardianName: string | null;
  localTime: string;
}

export interface ToolResult {
  /** Echoes Action.id */
  id: string;
  name: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

export interface AssistantTurnRequest {
  conversationId?: string;
  lang: Lang | 'auto';
  input: { kind: 'text'; text: string; source: 'voice' | 'typed' | 'button' } | { kind: 'toolResults'; results: ToolResult[] };
  context: AssistantContext;
}

export interface Action {
  id: string;
  /** Gemini function name */
  name: string;
  /** Dotted action type, e.g. navigation.searchPlace */
  type: string;
  arguments: Record<string, unknown>;
}

export interface AssistantTurnResponse {
  conversationId: string;
  reply: { text: string; language: Lang } | null;
  actions: Action[];
  requiresConfirmation: boolean;
  priority: 'normal' | 'high' | 'critical';
}

export type VisionTask = 'describe_scene' | 'read_text' | 'identify_object' | 'read_sign' | 'describe_environment';

/** Separate photo and sensor evidence: visual identity, unidentified forward range, and stick pose; timestamps need not coincide. */
export interface SensorContext {
  forwardDistanceCm: number | null;
  ultrasonicStatus: string;
  zone: string;
  pitchDeg: number | null;
  rollDeg: number | null;
  headingDeg: number | null;
  speedMps: number | null;
  measuredAt: number;
}

export interface VisionRequest {
  task: VisionTask;
  lang: Lang;
  /** base64 JPEG, validated by the app first. Never stored by the backend. */
  imageBase64: string;
  hint?: string;
  sensors?: SensorContext;
}

/** Scene evidence: each object has its own source; a forward ultrasonic reflection has no camera-object identity. */
export interface FusedObject {
  label: string;
  position: 'left' | 'center' | 'right';
  /** The vision model reports position thirds, not boxes; null until an on-device detector provides one. */
  bbox: { x: number; y: number; w: number; h: number } | null;
  confidence: number;
  radarDistanceCm: number | null;
  source: ('vision' | 'ultrasonic')[];
  timestamp: number;
}

export interface FusedScene {
  objects: FusedObject[];
  pose: { pitchDeg: number | null; rollDeg: number | null };
  motion: { speedMps: number | null; headingDeg: number | null };
  timestamp: number;
}

export interface VisionHazard {
  type: 'obstacle' | 'person' | 'vehicle' | 'stairs' | 'curb' | 'doorway' | 'pole' | 'animal' | 'other';
  position: 'left' | 'center' | 'right';
  distance: 'near' | 'medium' | 'far' | 'unknown';
  confidence: 'low' | 'medium' | 'high';
  note?: string;
}

export interface VisionResult {
  /** One or two short sentences to speak. States uncertainty; never claims safety. */
  spoken: string;
  hazards: VisionHazard[];
  text?: string;
  object?: string;
  imageQuality: 'good' | 'dark' | 'blurry' | 'blocked' | 'unknown';
  uncertain: boolean;
  /** Added on the phone after the response (not produced by the model). */
  fused?: FusedScene;
}
