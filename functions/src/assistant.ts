import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { GoogleGenAI, type Content, type Part } from '@google/genai';
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
You are the voice assistant inside "AI Smart Stick", a smart white cane for a blind or low-vision person in India.
The product is called AI Smart Stick. Never call yourself by any other product name.

HOW TO ANSWER
- Replies are spoken aloud. Keep them to one or two short sentences unless asked for more. No lists, no markdown, no emojis.
- Language: ${lang === 'auto' ? 'reply in the language the user used (English, Hindi, or Hinglish written in Latin script).' : lang === 'hi' ? 'reply in simple Hindi.' : 'reply in simple Indian English.'}
- Use tools for anything about the stick, location, places, routes, camera, safety, calls, texts or settings. Never guess their results.

SAFETY RULES (strict)
- Never say it is safe to cross a road, walk ahead, or that a path is clear. Describe what was observed and how certain it is; remind the user to use their cane and hearing.
- If a vision result is uncertain or the image is poor, say so plainly.
- Never invent places, addresses, coordinates, distances or phone numbers. Places come only from search_place / find_nearest_place / set_destination.

NAVIGATION
- "Nearest X" → find_nearest_place (or search_place for a name). Say the offered place's name (and distance when given) and ask if they want to go there; on yes call start_navigation with that placeId.
- When the user names one specific place or address to go to ("set destination to City Hospital"), call set_destination with query set to that name: it sets the destination and starts directions.
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

function client(version?: 'v1beta' | 'v1alpha') {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new HttpsError('failed-precondition', 'Gemini is not configured on the server.');
  return new GoogleGenAI({ apiKey: key, httpOptions: version ? { apiVersion: version } : undefined });
}

async function generate(ai: GoogleGenAI, req: Parameters<GoogleGenAI['models']['generateContent']>[0]) {
  try {
    return await ai.models.generateContent(req);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (/429|503|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 1200));
      return ai.models.generateContent(req);
    }
    throw e;
  }
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

  const ai = client();
  const res = await generate(ai, {
    model: GEMINI_FLASH_MODEL.value(),
    contents: [...history.slice(-14), ...pending.contents],
    config: {
      systemInstruction: SYSTEM(r.lang, r.context, userName),
      tools: [{ functionDeclarations: functionDeclarations as never }],
      temperature: 0.4,
      maxOutputTokens: 600,
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
    spoken: { type: 'string', description: 'One or two short spoken sentences.' },
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

const TASK: Record<VisionRequest['task'], string> = {
  describe_scene: 'Describe what is in front of the walker: obstacles, people, vehicles, stairs, curbs, doorways, poles, animals. Say left/center/right and rough distance (near <2 m, medium 2–5 m, far).',
  read_text: 'Read the printed text in the image exactly, most prominent first. Put it in "text". Spoken: the text itself, shortened if long.',
  identify_object: 'Identify the main object held or shown. For Indian banknotes, give the denomination. Put it in "object".',
  read_sign: 'Read the sign or signboard. Put its text in "text".',
  describe_environment: 'Describe the kind of place (indoor/outdoor, shop, street, station) in one sentence, plus any immediate hazards.',
};

const UNSAFE_CLAIM = /\b(safe to (cross|walk|go)|path is clear|all clear|no obstacles|you can (cross|go|walk) (now|safely))\b/i;

export const assistantVision = onCall({ ...CALLABLE, secrets: [GEMINI_API_KEY], timeoutSeconds: 60, memory: '512MiB' }, async (request): Promise<VisionResult> => {
  const uid = requireAuth(request);
  const r = request.data as VisionRequest;
  if (!r || !(r.task in TASK) || typeof r.imageBase64 !== 'string') throw new HttpsError('invalid-argument', 'Malformed vision request.');
  if (r.imageBase64.length > 2_800_000) throw new HttpsError('invalid-argument', 'Image too large.');
  const head = Buffer.from(r.imageBase64.slice(0, 8), 'base64');
  if (head[0] !== 0xff || head[1] !== 0xd8) throw new HttpsError('invalid-argument', 'Not a JPEG.');
  await quota(uid, 'vision', 12, 400);

  const lang = r.lang === 'hi' ? 'simple Hindi' : 'simple Indian English';
  // Measured context from the stick (validated numbers only). Vision says WHAT, ultrasonic says HOW FAR.
  const sn = r.sensors;
  const cm = typeof sn?.forwardDistanceCm === 'number' && Number.isFinite(sn.forwardDistanceCm) && sn.forwardDistanceCm > 0 && sn.forwardDistanceCm < 500 ? Math.round(sn.forwardDistanceCm) : null;
  const sensorNote = sn
    ? cm != null
      ? `The stick's ultrasonic sensor MEASURED an object about ${cm} cm straight ahead (centre only). Use it for distance of a centre object; do not invent other distances.`
      : `The stick's ultrasonic sensor reports "${String(sn.ultrasonicStatus).slice(0, 20)}" straight ahead (no measured distance). Do not treat that as a clear path.`
    : '';
  const ai = client();
  const res = await generate(ai, {
    model: GEMINI_VISION_MODEL.value(),
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: r.imageBase64 } },
          {
            text: `You help a blind person using the AI Smart Stick camera (low resolution, mounted on a cane). ${TASK[r.task]} ${r.hint ? `User hint: ${str(r.hint, 80)}.` : ''}
${sensorNote}
Rules: write "spoken" in ${lang}. State uncertainty honestly and set "uncertain" true when unsure or the image is poor. NEVER say a path is clear or that it is safe to cross/walk; if nothing is visible, say nothing obvious is visible in this photo and to keep using the cane.`,
          },
        ],
      },
    ],
    config: { responseMimeType: 'application/json', responseJsonSchema: VISION_SCHEMA, temperature: 0.2, maxOutputTokens: 700 },
  });

  let out: VisionResult;
  try {
    out = JSON.parse(res.text ?? '{}') as VisionResult;
  } catch {
    throw new HttpsError('internal', 'The vision model returned an unreadable answer.');
  }
  out.hazards = Array.isArray(out.hazards) ? out.hazards.slice(0, 8) : [];
  out.spoken = str(out.spoken, 500) || 'I could not make out the photo.';
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
  await quota(uid, 'live', 6, 300);
  const liveModel = GEMINI_LIVE_MODEL.value();
  const ai = client('v1alpha');
  const now = Date.now();
  let token = '';
  try {
    // One-use ephemeral token: the long-lived API key never leaves the server. The model is locked
    // here, so a leaked token cannot be used with any other model.
    const res = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(now + 2 * 60_000).toISOString(),
        liveConnectConstraints: { model: liveModel },
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });
    token = res.name ?? '';
  } catch (e) {
    console.error('Failed to create ephemeral token:', e);
    throw new HttpsError('internal', 'Could not generate Live session token.');
  }
  if (!token) throw new HttpsError('internal', 'Could not generate Live session token.');
  return { token, liveModel, flashModel: GEMINI_FLASH_MODEL.value() };
});
