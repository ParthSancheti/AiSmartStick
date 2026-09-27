# OTA Architecture

This document describes the Over-The-Air (OTA) firmware update mechanism for the AI Smart Stick.

## Workflow Overview

1. **Check for Updates**:
   - The user triggers an update check from the `HardwareSubpage` in the app settings.
   - The app calls the Cloud Function `getLatestFirmwareRelease`.
   - The Cloud Function queries the GitHub Releases API for the latest release in the repository (e.g. `project-owner/ai-smart-stick`).
   - The Cloud Function fetches the `firmware-manifest.json` from the release assets and caches it.
   - It returns the manifest to the app.

2. **Validate Version**:
   - The app compares the returned `version` in the manifest against the currently connected stick's firmware version.
   - If a newer version is available, the app proceeds to download the binary.

3. **Download Firmware**:
   - The app uses the `binaryUrl` from the manifest to download the firmware binary blob.

4. **Secure Push to Device**:
   - The app uses `HttpTransport.pushOTA()` to push the firmware to the ESP32.
   - The request is sent to `POST /api/v1/ota`.
   - The request is authenticated identically to standard device commands:
     - `x-aiss-device`: Device ID.
     - `x-aiss-ts`: Current timestamp.
     - `x-aiss-nonce`: Cryptographic nonce.
     - `x-aiss-sig`: HMAC-SHA256 signature calculated over the HTTP method, path, timestamp, nonce, and the SHA256 hash of the binary body.
     - The shared `deviceKey` (established during provisioning) is used for the HMAC key.
   - The ESP32 verifies the signature, checking that the app is authorized and the payload has not been tampered with.

5. **Device Reboot**:
   - Upon successful verification and flashing of the new firmware to the OTA partition, the ESP32 restarts.
   - The app will automatically reconnect to the stick once it re-announces itself on the network via UDP discovery.

## Security Considerations

- **No Secrets in App**: The app does not contain any GitHub tokens. The Cloud Function proxies the request to the public GitHub API or uses backend-only secrets if the repo is private.
- **Authenticity**: The firmware binary is signed using the established `deviceKey`, ensuring that only the authorized paired phone can push an update.
- **Integrity**: The SHA256 of the binary is included in the signed envelope, preventing tampering over the local network.
- **Rollback**: The ESP32's native OTA mechanism supports partition rollback if the new firmware fails to boot properly.
