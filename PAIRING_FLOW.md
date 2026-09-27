# Pairing flows

There are two separate pairings. Neither ever puts a permanent secret in a QR code.

## A. User ↔ Guardian (account relationship, 1 : 1)
1. **Guardian app:** `createPairingCode`. The server creates `pairingSessions/{6-digit code}` (10-minute
   expiry, TTL). The screen shows the code and a QR code containing `aiss://pair?v=1&code=NNNNNN`.
2. **User app:** scans the QR with the Google code scanner (no camera permission needed) or types the
   code, then calls `claimPairingCode`.
3. **Server** (in a transaction):
   * the code must exist, be unexpired and unclaimed, and not belong to the same account;
   * the user has no active guardian and the guardian has no active user (**1 → 1 enforced here and
     in the rules**);
   * brute force is limited to 5 wrong codes per hour;
   * it creates `relationships/{userUid_guardianUid}` and marks the code claimed (**one-time**);
   * it pushes "linked" to the Guardian.
4. The rules grant the Guardian read access only through that relationship document and its permission
   flags. Guessing a uid gives nothing.
5. **Revoke:** `revokeRelationship` (either side) sets `status: revoked`. Access ends immediately and
   the other side gets a push.

## B. Phone ↔ Stick (device identity)
1. The stick is unprovisioned. The user holds its button 5 s, the stick buzzes and raises
   `AISmartStick-XXXX` (WPA2).
2. The app scans for it and shows "Stick detected". The user types the **setup code** from the label.
   This is the proof of possession and is also the AP password.
3. The user types the hotspot name and password **once**. Android does not let apps read the hotspot
   password; this is stated in the UI.
4. Android shows one `WifiNetworkSpecifier` sheet (**Connect**). Mobile data stays the default route.
5. The app generates a 32-byte key and sends it with `POST /api/v1/provision`. The key is stored in
   Android Keystore storage (EncryptedSharedPreferences) and **never in Firestore** (the rules reject it).
6. The stick joins the hotspot. The app waits for a **signed** announcement and verifies the
   challenge–response proof. Only then does it write the device metadata and show
   "AI Smart Stick Connected".
7. Ownership: `devices/{deviceId}` records `ownerUid` (first owner wins). **Unpair** forgets the key and
   releases ownership. The stick must be factory-reset (hold while powering on) before it can be paired
   again.

The Guardian never receives the stick key, the setup code or the hotspot credentials.
