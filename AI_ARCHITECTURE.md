# AI architecture

```
button / voice / typed text
  → recognition.ts (one mic) → realAssistant.ts (AIOrchestrator: turn loop, confirmation, watchdog)
  → Cloud Function assistantTurn (Auth + App Check + quota) → Gemini (function calling)
  → structured tool calls → executor.ts: whitelist · schema validation · requirement checks
    (stick / GPS / internet / guardian) · confirmation for sensitive actions · audit event
  → real services (device transport, Maps functions, GPS, native call/SMS, settings)
  → tool results → Gemini (≤ 4 rounds) → reply → UnifiedAudioOrchestrator (P2)
```
* **Keys:** `GEMINI_API_KEY` lives only in Secret Manager. There is no client call to Gemini.
* **Models:** configured in one place, `functions/src/common.ts`: `GEMINI_MODEL` and
  `GEMINI_VISION_MODEL`, both defaulting to `gemini-3.5-flash`, overridable per environment.
  **Not verified against the live API here** (no key).
* **Tools:** `shared/tools.ts` holds 35 tools. One spec produces both the Gemini schema and the
  validator. Unknown tools and malformed arguments are rejected.
* **Safety boundary:** Gemini has **no** raw hardware access. It cannot:
  * control obstacle haptics (ECU-local),
  * trigger unrestricted device commands (only named `haptic` patterns and `locate`),
  * change SOS or privacy settings (`change_setting` refuses those keys),
  * send SMS to arbitrary numbers (guardian only, with confirmation),
  * call arbitrary numbers,
  * read other users' data (it only sees what the executor returns), or
  * decide falls or obstacle danger.
* **Truthfulness:** tool results carry real status. Examples: `dialer_opened` vs `call_started`,
  `composer_opened` vs `sent`, battery `null` when unknown. The system prompt forbids claiming more.
  Tests: `tests/executor.test.ts`.
* **Vision:** `assistantVision` returns a JSON schema `VisionResult`
  (`spoken, hazards[], textFound[], imageQuality, uncertain`) plus an unsafe-claim filter.
  * The request carries a **SensorContext**: measured forward distance, zone, pitch, roll, heading and
    speed.
  * The phone then builds a **FusedScene** (`src/core/vision/fusion.ts`):
    - **vision** says what,
    - **ultrasonic** says how far (centre object only, fresh reading only),
    - **IMU** gives the stick's pose,
    - **GPS** gives motion.
  * A measured centre obstacle that the photo doesn't explain is still reported.
  * Images are never stored.
* **Object detection on-device:** **not implemented.** No benchmark on the target phone exists yet.
  The candidate is ML Kit object detection (Play services, offline). It must be benchmarked for
  latency and battery before adoption. Until then, detection is Gemini vision on demand only (button,
  voice, or Guardian scan request). There is no continuous streaming.
* **Mock brain:** `core/ai/brain.ts` runs in **demo mode only**. There is no real→mock fallback: when
  Gemini fails, real mode says so.
