import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { GoogleGenAI, ThinkingLevel, type Content, type Part } from '@google/genai';
import { FieldValue } from 'firebase-admin/firestore';
import { CALLABLE, GEMINI_API_KEY, GEMINI_LIVE_MODEL, GEMINI_FLASH_MODEL, GEMINI_VISION_MODEL, db, quota, requireAuth, str } from './common';
import { TOOLS, TOOL_BY_NAME } from './shared/tools';
import { toGeminiParameters, validateArgs } from './shared/validate';
import type { Action, AssistantTurnRequest, AssistantTurnResponse, ToolResult, VisionRequest, VisionResult } from './shared/assistantContract';

/**
 * Gemini runs ONLY here (key in Secret Manager). The model may request tools; it never acts.
 * The app validates and executes each action, then sends results back through this function.
 * Gemini 3 requires thought signatures to be returned during function calling, so the raw
 * model Content of an in-progress turn is kept server-side (conversation.pendingJson).
 */
const SYSTEM = (lang: string, ctx: AssistantTurnRequest['context'], userName: string) => `
You are "Saathi", the warm, perceptive, steady voice companion inside "AI Smart Stick", a smart white cane for a blind or low-vision person in India.
The product is called AI Smart Stick. Never call yourself by any other product name.

PERSONALITY & HOW TO ANSWER
- Sound like an attentive, reassuring human companion walking alongside ${userName || 'the user'} — warm, confident, practical, never stiff or robotic.
- Replies are spoken aloud. Keep everyday confirmations and walking alerts concise (1-2 clear sentences), and give rich, helpful spatial detail (2-4 natural sentences) when asked about surroundings, objects, signs, or plans. No lists, no markdown, no emojis.
- Language: ${lang === 'auto' ? 'reply naturally in the language the user used (English, Hindi, or Hinglish written in Latin script).' : lang === 'hi' ? 'reply in warm, simple everyday Hindi.' : 'reply in warm, clear Indian English.'}
- Use tools for anything about the stick, location, places, routes, camera, safety, calls, texts or settings. Never guess their results.

VISION (CRITICAL)
- When asked to open or start the camera preview, call open_camera.
- YOU HAVE A CAMERA. When asked what is in front of you, what the user is holding, or to read text/signs, you MUST call the appropriate vision tool (describe_scene, identify_object, read_text, read_sign, describe_environment).
- Call the tool before claiming camera access is unavailable. Use result.spoken naturally; preserve uncertainty or earlier-photo caveats when present. If it fails, explain briefly and offer to try again. Never invent visual details.

SAFETY RULES (strict)
- Never say it is safe to cross a road, walk ahead, or that a path is clear. Describe what was observed and how certain it is; remind the user to use their cane and hearing.
- If a vision result is uncertain or the image is poor, say so plainly.
- Camera left/right is image position only. Never infer metres, steps, side clearance or a navigable bypass from a monocular photo. A front ultrasonic reading does not identify a camera object.
- If a scene result is labelled as an earlier photo, preserve that timing; it is not a current obstacle clearance instruction.
- Never invent places, addresses, coordinates, distances or phone numbers. Places come only from search_place / find_nearest_place / set_destination.

NAVIGATION (CRITICAL)
- For remaining time, distance, progress or where to walk, call get_route_status every time and read its spoken summary. Preserve paused-GPS/obstacle warnings; do not estimate from conversation memory.
- On starting a route, say its distance and estimated minutes, plus the supplied first instruction. If directions are paused, explain why instead of telling the user to move.
- NEVER tell the user to open a map app or use another app to navigate. You MUST handle navigation yourself natively using the tools.
- NEVER ask the user for their current location. You already know it from the context below, or you can call get_current_location if needed.
- "Nearest X" -> find_nearest_place (or search_place for a name). Say the offered place's name (and distance when given) and ask if they want to go there; on yes call start_navigation with that placeId.
- When the user names one specific place or address to go to ("set destination to City Hospital", "take me to PCMC Metro Station"), IMMEDIATELY call set_destination with query set to that name: it sets the destination and starts directions.
- GPS is NOT needed to search or to set a destination. If a result says directions "waiting_for_gps", say the destination is set and directions start automatically once GPS finds their position. Never say location or maps are unavailable when the user asks to go somewhere.
- For a help or "where am I" text, use send_sms_to_guardian; the app adds the location link itself.
- trigger_sos only when the user clearly asks for help or says it is an emergency. cancel_sos only when they say they are okay.
- A text message counts as sent only if the tool result says "sent". If it says "composer_opened", tell the user to press send.
- If a tool fails, say briefly what failed and what still works (the stick keeps vibrating for obstacles offline).
- Do not give medical diagnoses.

CURRENT CONTEXT (from the phone, may change)
- User's name: ${userName || 'unknown'}; guardian: ${ctx.guardianName ?? 'none linked'}
- Stick connected: ${ctx.deviceConnected}; phone internet: ${ctx.internet}; GPS available: ${ctx.locationAvailable}${ctx.locationAvailable ? '' : ' (destinations can still be searched and set)'}
- Navigating: ${ctx.navigating}; SOS state: ${ctx.sosPhase}; local time: ${ctx.localTime}
`.trim();

const functionDeclarations = TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiParameters(t.params) }));

const KEY_COOLDOWN_MS = 60_000;
const keyCooldownUntil = new Map<string, number>();
let keyCursor = 0;

/** Parses one or multiple Gemini API keys (comma, semicolon, or whitespace separated). */
export function parseGeminiApiKeys(primary: string | undefined, extra?: string): string[] {
  const combined = [primary, extra].filter((v): v is string => typeof v === 'string' && v.trim().length > 0).join('\n');
  const seen = new Set<string>();
  for (const token of combined.split(/[\s,;]+/)) {
    const trimmed = token.trim();
    if (trimmed && !seen.has(trimmed)) seen.add(trimmed);
  }
  return [...seen];
}

function availableGeminiKeys(): string[] {
  const all = parseGeminiApiKeys(
    GEMINI_API_KEY.value(),
    [process.env.GEMINI_API_KEYS, process.env.GEMINI_BACKUP_API_KEY].filter(Boolean).join('\n'),
  );
  if (!all.length) throw new HttpsError('failed-precondition', 'Gemini is not configured on the server.');
  if (all.length === 1) return all;
  const now = Date.now();
  const ordered: string[] = [];
  for (let i = 0; i < all.length; i++) {
    ordered.push(all[(keyCursor + i) % all.length]);
  }
  keyCursor = (keyCursor + 1) % all.length;
  const healthy = ordered.filter((k) => (keyCooldownUntil.get(k) ?? 0) <= now);
  return healthy.length ? healthy : ordered;
}

function clientForKey(key: string, version?: 'v1beta' | 'v1alpha') {
  return new GoogleGenAI({ apiKey: key, httpOptions: version ? { apiVersion: version } : undefined });
}

function client(version?: 'v1beta' | 'v1alpha') {
  return clientForKey(availableGeminiKeys()[0], version);
}

function thinkingForModel(model: string): { thinkingLevel: ThinkingLevel } | undefined {
  if (/flash-lite/i.test(model)) return { thinkingLevel: ThinkingLevel.MINIMAL };
  if (/gemini-(3|4)/i.test(model)) return { thinkingLevel: ThinkingLevel.LOW };
  return undefined;
}

function isRetryableKeyError(err: unknown): boolean {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined;
  if (status === 429 || status === 503) return true;
  const msg = String((err as Error)?.message ?? err);
  return /\b(429|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(msg);
}

async function generate(ai: GoogleGenAI, req: Parameters<GoogleGenAI['models']['generateContent']>[0]) {
  const keys = availableGeminiKeys();
  const attempts: { ai: GoogleGenAI; key: string }[] = [{ ai, key: keys[0] }];
  for (let i = 1; i < keys.length; i++) {
    attempts.push({ ai: clientForKey(keys[i]), key: keys[i] });
  }
  let lastError: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      return await attempt.ai.models.generateContent(req);
    } catch (e) {
      lastError = e;
      if (!isRetryableKeyError(e)) throw e;
      if (keys.length > 1) keyCooldownUntil.set(attempt.key, Date.now() + KEY_COOLDOWN_MS);
      if (i + 1 < attempts.length) continue;
      // Single-key transient 429/503 recovery: brief jittered retry once.
      if (keys.length === 1) {
        await new Promise((r) => setTimeout(r, 800));
        return attempt.ai.models.generateContent(req);
      }
    }
  }
  throw lastError;
}

function validateRequest(d: unknown): AssistantTurnRequest {
  const r = d as AssistantTurnRequest;
  if (!r || typeof r !== 'object' || !r.input || !r.context) throw new HttpsError('invalid-argument', 'Malformed request.');
  if (r.input.kind === 'text') {
    if (!str(r.input.text, 2000)) throw new HttpsError('invalid-argument', 'Empty message.');
  } else if (r.input.kind === 'toolResults') {
    if (!Array.isArray(r.input.results) || r.input.results.length > 10) throw new HttpsError('invalid-argument', 'Bad tool results.');
  } else throw new HttpsError('invalid-argument', 'Unknown input kind.');
  if (r.conversationId !== undefined && !/^[A-Za-z0-9_-]{6,64}$/.test(r.conversationId)) throw new HttpsError('invalid-argument', 'Bad conversation id.');
  return r;
}

interface Pending {
  contents: Content[];
  calls: { name: string; args: Record<string, unknown> }[];
  results: { name: string; ok: boolean }[];
  userText: string;
  rounds: number;
}

export const assistantTurn = onCall({ ...CALLABLE, secrets: [GEMINI_API_KEY], timeoutSeconds: 60, memory: '512MiB' }, async (request): Promise<AssistantTurnResponse> => {
  const uid = requireAuth(request);
  const r = validateRequest(request.data);
  await quota(uid, 'assistant', 30, 1500);

  const convs = db.collection(`users/${uid}/aiConversations`);
  const convRef = r.conversationId ? convs.doc(r.conversationId) : convs.doc();
  const conv = await convRef.get();
  const userName = str((await db.doc(`users/${uid}`).get()).get('displayName'), 60);

  // History: final user/model text of this conversation (tool rounds are summarised, not replayed).
  const hist = conv.exists ? await convRef.collection('messages').orderBy('ts', 'desc').limit(16).get() : null;
  const history: Content[] = (hist?.docs ?? [])
    .reverse()
    .filter((m) => m.get('text'))
    .map((m) => ({ role: m.get('role') === 'model' ? 'model' : 'user', parts: [{ text: String(m.get('text')) }] }));

  let pending: Pending;
  if (r.input.kind === 'text') {
    const text = str(r.input.text, 2000);
    pending = { contents: [{ role: 'user', parts: [{ text }] }], calls: [], results: [], userText: text, rounds: 0 };
    await convRef.collection('messages').add({ role: 'user', text, ts: Date.now(), source: r.input.source, language: r.lang });
    if (!conv.exists) await convRef.set({ title: text.slice(0, 60), createdAt: Date.now(), updatedAt: Date.now(), pendingJson: null });
  } else {
    const raw = conv.get('pendingJson');
    if (!raw) throw new HttpsError('failed-precondition', 'No tool call is waiting for results.');
    pending = JSON.parse(raw) as Pending;
    const lastModel = pending.contents[pending.contents.length - 1];
    const expected = (lastModel?.parts ?? []).filter((p) => p.functionCall).map((p) => p.functionCall!);
    const parts: Part[] = expected.map((fc) => {
      const res = (r.input as { results: ToolResult[] }).results.find((x) => x.id === fc.id || (!fc.id && x.name === fc.name));
      const response = !res ? { error: 'The app did not return a result.' } : res.ok ? { result: res.data ?? {} } : { error: str(res.error, 500) || 'failed' };
      pending.results.push({ name: fc.name ?? '', ok: !!res?.ok });
      return { functionResponse: { id: fc.id, name: fc.name, response } };
    });
    pending.contents.push({ role: 'user', parts });
    pending.rounds++;
    if (pending.rounds > 4) throw new HttpsError('resource-exhausted', 'Too many tool steps for one request.');
  }

  const flashModel = GEMINI_FLASH_MODEL.value();
  const thinking = thinkingForModel(flashModel);
  const ai = client();
  const res = await generate(ai, {
    model: flashModel,
    contents: [...history.slice(-14), ...pending.contents],
    config: {
      systemInstruction: SYSTEM(r.lang, r.context, userName),
      tools: [{ functionDeclarations: functionDeclarations as never }],
      temperature: 0.4,
      maxOutputTokens: 600,
      ...(thinking ? { thinkingConfig: thinking } : {}),
    },
  });

  const content = res.candidates?.[0]?.content;
  const calls = res.functionCalls ?? [];
  const lang = r.lang === 'hi' ? 'hi' : r.lang === 'en' ? 'en' : /[\u0900-\u097F]/.test(res.text ?? '') ? 'hi' : 'en';

  if (calls.length && content) {
    pending.contents.push(content); // raw, including thought signatures
    const actions: Action[] = calls.map((c, i) => {
      const spec = TOOL_BY_NAME.get(c.name ?? '');
      // Server-side check too; the app validates again before executing.
      const ok = spec && validateArgs(spec.params, c.args ?? {}).ok;
      pending.calls.push({ name: c.name ?? '', args: (c.args ?? {}) as Record<string, unknown> });
      return { id: c.id ?? `call_${pending.rounds}_${i}`, name: c.name ?? 'unknown', type: ok ? spec!.type : 'invalid', arguments: (c.args ?? {}) as Record<string, unknown> };
    });
    // Keep ids aligned for the functionResponse round.
    content.parts?.forEach((p, i) => {
      if (p.functionCall && !p.functionCall.id) p.functionCall.id = actions[i]?.id;
    });
    await convRef.set({ pendingJson: JSON.stringify(pending), updatedAt: Date.now() }, { merge: true });
    const confirm = actions.some((a) => TOOL_BY_NAME.get(a.name)?.confirm);
    const sos = actions.some((a) => a.type === 'safety.triggerSOS');
    const text = res.text?.trim();
    return { conversationId: convRef.id, reply: confirm && text ? { text, language: lang } : null, actions, requiresConfirmation: confirm, priority: sos ? 'critical' : 'normal' };
  }

  const reply = (res.text ?? '').trim() || (lang === 'hi' ? 'माफ़ कीजिए, मैं समझ नहीं पाया।' : "Sorry, I didn't get that.");
  await convRef.collection('messages').add({
    role: 'model',
    text: reply,
    ts: Date.now(),
    language: lang,
    toolCalls: pending.calls.slice(0, 10),
    toolResults: pending.results.slice(0, 10),
  });
  await convRef.set({ pendingJson: null, updatedAt: Date.now(), lastMessage: reply.slice(0, 120), messageCount: FieldValue.increment(2) }, { merge: true });
  return { conversationId: convRef.id, reply: { text: reply, language: lang }, actions: [], requiresConfirmation: false, priority: 'normal' };
});

// ─── Vision ───────────────────────────────────────────────────

const VISION_SCHEMA = {
  type: 'object',
  properties: {
    spoken: { type: 'string', description: 'Two to three clear, descriptive, natural spoken sentences covering key hazards, spatial layout, and helpful details without markdown.' },
    hazards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['obstacle', 'person', 'vehicle', 'stairs', 'curb', 'doorway', 'pole', 'animal', 'other'] },
          position: { type: 'string', enum: ['left', 'center', 'right'] },
          distance: { type: 'string', enum: ['near', 'medium', 'far', 'unknown'] },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          note: { type: 'string' },
        },
        required: ['type', 'position', 'distance', 'confidence'],
      },
    },
    text: { type: 'string' },
    object: { type: 'string' },
    imageQuality: { type: 'string', enum: ['good', 'dark', 'blurry', 'blocked', 'unknown'] },
    uncertain: { type: 'boolean' },
  },
  required: ['spoken', 'hazards', 'imageQuality', 'uncertain'],
};

export const VISION_TASK_INSTRUCTIONS: Record<VisionRequest['task'], string> = {
  describe_scene: 'Give a rich, calm, practical description for a blind person holding a smart cane. Lead with immediate hazards or steps in the path, then describe key obstacles, people, vehicles, doorways, furniture, curbs, stairs, poles and animals with clear left/center/right placement relative to the image and whether space beside them looks open or tight. Use near/medium/far only as uncertain qualitative descriptions; these categories do not measure metres or steps. Set distance to unknown when unsure.',
  read_text: 'Read all visible printed or handwritten text accurately, most prominent and relevant first (names, timings, warnings, totals, expiry, dosage, or prices). Put the full text in "text". Spoken: a clear, natural reading of what it says.',
  identify_object: 'Identify the main object clearly with useful details (type, color, shape, brand/label if readable, and whether it is open/closed or facing up). For Indian banknotes, state the exact denomination cleanly. Put the short name in "object".',
  read_sign: 'Read the sign, signboard, notice, or shop front clearly, and note any arrow or entrance direction visible beside it. Put its text in "text".',
  describe_environment: 'Describe the overall place and atmosphere clearly in 2-3 helpful sentences (indoor/outdoor, lighting, type of room/shop/street/station, seating or landmarks nearby, plus any immediate hazards). Set distance relative to the image and unknown when unsure.',
};

const UNSAFE_CLAIM = /\b(safe to (cross|walk|go)|path is clear|all clear|no obstacles|you can (cross|go|walk) (now|safely))\b/i;

/** The phone reports fresh numeric sonar facts separately; the model cannot identify an echo. */
export function visionSensorEvidenceNote(sn: VisionRequest['sensors']): string {
  if (!sn) return '';
  const cm = sn.forwardDistanceCm;
  const ranged = sn.ultrasonicStatus === 'ok' && typeof cm === 'number' && Number.isFinite(cm) && cm >= 2 && cm <= 450;
  return ranged
    ? 'A separate narrow forward ultrasonic sensor sample reported an unidentified reflection. The photo and sensor sample have independent timestamps. It cannot be associated with any camera object. Do not state a numeric distance; the phone separately reports sensor ranges when they are still fresh.'
    : 'No measured forward range is available for this photo. This does not establish a clear path. Do not infer distances from the photo.';
}

/** Only safe categories leave this boundary. SDK errors can contain request/key details. */
export function visionModelFailure(error: unknown): HttpsError {
  const e = error as { status?: unknown; code?: unknown; name?: unknown; message?: unknown };
  const message = typeof e?.message === 'string' ? e.message : '';
  // ApiError.status is numeric. Some transports expose the API's JSON error as a message.
  let status = typeof e?.status === 'number' ? e.status : typeof e?.code === 'number' ? e.code : null;
  if (status == null) {
    try { const body = JSON.parse(message); if (typeof body?.error?.code === 'number') status = body.error.code; } catch { /* not API JSON */ }
  }
  const timeout = status === 408 || status === 504 || /TimeoutError|AbortError/.test(String(e?.name)) || /deadline|timed? ?out|timeout/i.test(message);
  if (timeout) return new HttpsError('deadline-exceeded', 'The AI picture service took too long to analyse the photo. Please try again.', { service: 'vision-model', reason: 'timeout' });
  if (status === 429) return new HttpsError('resource-exhausted', 'The AI picture service is busy. Please wait a minute and try again.', { service: 'vision-model', reason: 'quota' });
  if (status === 401 || status === 403 || status === 404) return new HttpsError('failed-precondition', 'The AI picture service configuration needs attention on the server.', { service: 'vision-model', reason: 'configuration' });
  if (status === 400 || status === 422) return new HttpsError('internal', 'The AI picture service could not process this request.', { service: 'vision-model', reason: 'request' });
  return new HttpsError('unavailable', 'The AI picture service is temporarily unavailable. Please try again.', { service: 'vision-model', reason: 'upstream' });
}

export const assistantVision = onCall({ ...CALLABLE, secrets: [GEMINI_API_KEY], timeoutSeconds: 60, memory: '512MiB' }, async (request): Promise<VisionResult> => {
  const startedAt = Date.now();
  const uid = requireAuth(request);
  const r = request.data as VisionRequest;
  if (!r || !(r.task in VISION_TASK_INSTRUCTIONS) || typeof r.imageBase64 !== 'string') throw new HttpsError('invalid-argument', 'Malformed vision request.');
  if (r.imageBase64.length > 2_800_000) throw new HttpsError('invalid-argument', 'Image too large.');
  const head = Buffer.from(r.imageBase64.slice(0, 8), 'base64');
  if (head[0] !== 0xff || head[1] !== 0xd8) throw new HttpsError('invalid-argument', 'Not a JPEG.');
  await quota(uid, 'vision', 12, 400);
  console.info('vision_stage', { stage: 'quota_ready', elapsedMs: Date.now() - startedAt });

  const lang = r.lang === 'hi' ? 'simple Hindi' : 'simple Indian English';
  const sensorNote = visionSensorEvidenceNote(r.sensors);
  const visionModel = GEMINI_VISION_MODEL.value();
  const thinking = thinkingForModel(visionModel);
  const keys = availableGeminiKeys();
  const promptText = `You help a blind person using the AI Smart Stick camera (compact wide lens mounted on a cane). ${VISION_TASK_INSTRUCTIONS[r.task]} ${r.hint ? `User hint: ${str(r.hint, 80)}.` : ''}
${sensorNote}
Rules: write "spoken" in ${lang}. Describe clearly what is visible in this photo without inventing anything unseen. Mention helpful context (surfaces, doorways, stairs, obstacles, signs, colors, people) and left/center/right image position; camera orientation and body-relative directions are not calibrated here. Never infer numeric metres/steps, side clearance, object speed, collision time or a navigable bypass from a photo. State uncertainty honestly and set "uncertain" true when unsure or the image is poor. NEVER say a path is clear or that it is safe to cross/walk; if nothing is visible, say nothing obvious is visible in this photo and to keep using the cane.`;

  const callVision = async (aiClient: GoogleGenAI) => aiClient.models.generateContent({
    model: visionModel,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: r.imageBase64 } },
          { text: promptText },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', responseJsonSchema: VISION_SCHEMA, temperature: 0.25,
      maxOutputTokens: 1500, ...(thinking ? { thinkingConfig: thinking } : {}),
      httpOptions: { timeout: 20000, retryOptions: { attempts: 1 } } },
  });

  // Single key stays one bounded request so slow upstream errors surface promptly;
  // multi-key setups fail over immediately when one key hits quota/availability limits.
  let res: Awaited<ReturnType<typeof callVision>> | undefined;
  let lastError: unknown;
  for (let i = 0; i < keys.length; i++) {
    try {
      res = await callVision(clientForKey(keys[i]));
      break;
    } catch (error: unknown) {
      lastError = error;
      if (keys.length > 1 && isRetryableKeyError(error)) {
        keyCooldownUntil.set(keys[i], Date.now() + KEY_COOLDOWN_MS);
        continue;
      }
      break;
    }
  }
  if (!res) {
    const failure = visionModelFailure(lastError);
    console.warn('vision_stage', { stage: 'model_failed', elapsedMs: Date.now() - startedAt, code: failure.code, reason: (failure.details as { reason: string }).reason });
    throw failure;
  }
  console.info('vision_stage', { stage: 'model_ready', elapsedMs: Date.now() - startedAt, finishReason: res.candidates?.[0]?.finishReason });

  let out: VisionResult;
  try {
    out = JSON.parse(res.text ?? '{}') as VisionResult;
  } catch {
    throw new HttpsError('internal', 'The vision model returned an unreadable answer.');
  }
  out.hazards = Array.isArray(out.hazards) ? out.hazards.slice(0, 8) : [];
  out.spoken = str(out.spoken, 750) || 'I could not make out the photo.';
  if (UNSAFE_CLAIM.test(out.spoken)) {
    out.spoken = `${out.spoken.replace(UNSAFE_CLAIM, 'I did not see anything obvious')}. The camera can miss things, so keep using your cane.`;
    out.uncertain = true;
  }
  if (out.imageQuality !== 'good' && !out.uncertain) out.uncertain = true;
  // The image is not stored or logged anywhere. Only metadata is recorded.
  await db.collection(`users/${uid}/private`).doc('visionStats').set({ lastTask: r.task, lastAt: Date.now(), count: FieldValue.increment(1) }, { merge: true });
  return out;
});

export const getLiveToken = onCall({ ...CALLABLE, secrets: [GEMINI_API_KEY] }, async (request) => {
  const uid = requireAuth(request);
  await quota(uid, 'live', 15, 300);
  const liveModel = GEMINI_LIVE_MODEL.value();
  const keys = availableGeminiKeys();
  const now = Date.now();
  let token = '';
  let lastError: unknown;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const ai = clientForKey(key, 'v1beta');
    try {
      // One-use ephemeral token: the long-lived API key never leaves the server. The model is locked
      // here, so a leaked token cannot be used with any other model.
      const res = await ai.authTokens.create({
        config: {
          uses: 1,
          expireTime: new Date(now + 30 * 60_000).toISOString(),
          newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
          liveConnectConstraints: { model: liveModel },
          // Omitting this locks ALL unspecified setup fields to empty defaults: the
          // client tools, system instruction and transcription settings are ignored.
          // Lock the supplied model only; let the app supply its existing tool surface.
          lockAdditionalFields: [],
          httpOptions: { apiVersion: 'v1beta' },
        },
      });
      token = res.name ?? '';
      if (token) break;
    } catch (e) {
      lastError = e;
      if (keys.length > 1 && isRetryableKeyError(e)) {
        keyCooldownUntil.set(key, Date.now() + KEY_COOLDOWN_MS);
        continue;
      }
      break;
    }
  }
  if (!token) {
    console.error('Failed to create ephemeral token:', lastError);
    throw new HttpsError('internal', 'Could not generate Live session token.');
  }
  return { token, liveModel, flashModel: GEMINI_FLASH_MODEL.value() };
});
