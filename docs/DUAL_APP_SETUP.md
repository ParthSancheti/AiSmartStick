# Separate SmartStick and Guardian applications

Both apps use this repository and the same Firebase project. They have separate Android packages, accounts and app-private storage. The existing user package remains `in.aismartstick.app`; Guardian is `in.aismartstick.guardian`.

## Android builds

1. Keep the user's Firebase Android configuration at `android/app/google-services.json`.
2. Register Guardian as an Android app in the same Firebase project. Add the SHA-1/SHA-256 certificate fingerprints used to sign it. Download its refreshed Firebase configuration to `android/app/src/guardian/google-services.json`.
3. Run `npm run apk:user`, then `npm run apk:guardian`. The build checks TypeScript, builds the correct real-mode web bundle, syncs Capacitor and compiles Android. Run sequentially because both use the same asset staging directory.
4. Install `deliverables/AI-SmartStick-user-debug.apk` on the stick user's phone and `deliverables/AI-SmartStick-guardian-debug.apk` on the Guardian's phone. The packages can coexist on one phone for launch checks.

The local project already has the Guardian registration and debug certificate configured. Those local Firebase files and signing keys are excluded from source delivery. Another developer must supply their own project configuration and certificate registration.

`-PaissRole=guardian` selects the Guardian native package. The default is user. Gradle requires the staged web bundle's `build-role.json` to match the native role and real mode. After building Guardian, run `npm run apk:user` before a normal user build; changing only the Gradle property does not replace the web bundle.

## Accounts and pairing

Use separate Google accounts for user and Guardian. Existing accounts keep their backend role. Signing a user account into the Guardian package produces an explanation to use the user app; it does not convert the account. Complete the existing pairing-code flow between the two apps. Test Guardian push, remote camera and location from a second phone/network before release.

Guardian runs its feed and push listeners. It cannot register the user's native location plugin, start the stick foreground service or configure the native odometer. The user app owns GPS, stick communication, local obstacle guidance, Gemini Live, navigation and distance tracking.

## Web and demonstration builds

- `npm run build:user`: real user web bundle.
- `npm run build:guardian`: real Guardian web bundle.
- `node scripts/build-app.mjs combined`: combined demo web bundle for inspection.
- For an interactive combined dev server, set `VITE_APP_ROLE=combined` and `VITE_APP_MODE=demo` before `npm run dev`.

The in-app demo switch uses separate simulated storage. Real mode never substitutes simulated location, stick or route data when connectivity is missing.

## Release boundary

The generated APKs are debug-signed validation artifacts. A public release also needs the release signing certificate registered with Firebase/Google sign-in and Play Integrity, verified release configuration and physical acceptance. The local native odometer preserves measured totals; Android force-stop/reboot and missing GPS can still interrupt measurement. See [the verification record](VERIFICATION.md).
