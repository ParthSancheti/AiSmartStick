# Camera privacy

* The camera runs **only on request**: the user's triple press or voice request, or a Guardian
  request. There is no continuous stream. On the ECU the lifecycle is
  IDLE → CAPTURE → SEND → RELEASE; in sleep the sensor is powered down.
* **Assistant vision:** the JPEG goes phone → `assistantVision` → Gemini and is discarded. Nothing is
  written to Storage (`storage.rules` deny everything) or Firestore.
* **Guardian photo** (`cameraSessions`, Firestore signalling only):
  1. The Guardian requests. The rules require an active relationship with the `camera` permission, and
     `expireAt` must be under 10 minutes (TTL-deleted).
  2. The user's phone either **announces and allows**, or **asks first** (the user's setting). The user
     always hears "asked to see your camera", "camera active" and "camera ended".
  3. The frame travels peer-to-peer over a WebRTC data channel and is never stored by the backend.
  4. States: requesting, waiting, connecting, active, reconnecting, ended, failed. The session fails
     honestly after 25 s.
  5. **No "Live" label**: these are photos.
* **Guardian AI scan** (`sendRemoteCommand{scan}`): the user hears the request first, and only the
  **text** summary goes back.
* Camera frames and audio are never logged (`core/log.ts` redaction).
