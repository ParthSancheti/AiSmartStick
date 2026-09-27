# Audio architecture — one speech path

`src/core/audio/audioManager.ts` is the **UnifiedAudioOrchestrator**. Everything spoken goes through
`say()`: assistant replies, vision results, navigation, safety and SOS, camera-access notices, Guardian
messages and system messages. It uses **one TTS engine** (native Android TTS, or the browser's
speechSynthesis on web/PWA), **one queue**, and **one mono logical output**, which Android routes to
the speaker, earpiece or Bluetooth. No feature calls a TTS engine directly (`voiceOut.ts` →
`audioManager.ts` → `tts.ts`). Earcons are short tones from the same module and follow the same volume.

| Level | Name | Used for | Interrupts |
|---|---|---|---|
| P0 | critical | SOS, obstacle **danger** (from the ECU zone), battery critical | everything below |
| P1 | high | reroute, arrival, stick disconnected, low battery, Guardian messages, camera access | P2–P6 |
| P2 | user | reply to the user's own request | P3–P6 |
| P3 | vision | AI vision answers | — (queues) |
| P4 | nav | turn-by-turn pre-announcements | — |
| P5 | normal | informational | — |
| P6 | background | hints (dropped if anything else is queued) | — |

Rules:
* A new item interrupts only if it is P2 or higher and strictly higher than what is playing.
* An interrupted P2/P3/P5 item is replayed once if it was queued less than 20 s ago.
* Interrupted **navigation is discarded**, because stale directions are worse than none.
* A `dedupeKey` replaces a queued twin, for example repeated "turn left in 30 m".
* Speaking a P0/P1 item also stops an active microphone session (`abortRecognition`).

The assistant orb shows `interrupted` when its reply is cut.

**Voice input:** there is one microphone path (`core/ai/recognition.ts`: native speech recognition, or
Web Speech). It is started by the button (single press) or the orb.

The voice state machine is idle → listening (with live partial transcripts) → thinking or vision →
speaking → idle. Failures lead to error (spoken) → idle:
* permission denied, no speech, timeout
* offline, AI unavailable
* tool failure, TTS failure

A 60 s watchdog ends any stuck thinking/vision state.

**Gemini Live:** not used, by design. Its native audio output would be a second speech path, and every
action must pass the validated executor. If adopted later, it must run in text-output mode and feed
`say()` like everything else. Tests: `tests/audio.test.ts` (P0 interrupts, P2 over P4 discard, P5
never over P0, dedupe, background drop).
