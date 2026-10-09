# Google Cloud setup (maps, AI, App Check)

This guide is for the person who sets up the app. It explains every Google setting the app needs.

The app talks to Google in two ways:

* **The server** (Firebase Cloud Functions, region `asia-south1`). It does place search, walking
  routes, "where am I", the AI assistant and picture description. It uses the **server key** and the
  **Gemini key**.
* **The app itself** (Maps JavaScript API inside the app). It shows the map. It is also a second
  search path when the server is slow or down. It uses the **browser key**.

When both Google paths fail, search and walking routes come from **OpenStreetMap**. That needs no key.

---

## Your error: "Places API (New) has not been used in project 599970506387"

You saw this text under the search box:

> Server search: Could not reach the server ... In-app search: Places API (New) has not been used in
> project 599970506387 or it is disabled

It means: **Places API (New) is turned off** in the Google Cloud project with the number 599970506387.
The in-app search uses the browser key, so this is the browser key's project. The server key is most
likely in the same project, and then the server search fails for the same reason. (The old app said
"Could not reach the server" when Google refused the server key. The new app shows Google's own
reason.)

Fix:

1. Open https://console.cloud.google.com/apis/library/places.googleapis.com?project=599970506387
2. Check the project name at the top of the page. It must be your Firebase project.
3. Click **Enable**. (If the button says **Manage**, it is already on.)
4. Enable the other APIs too: section "2 Enable APIs".
5. Check the API restrictions of both keys: sections "3 Browser key" and "4 Server key".
6. Wait about 5 minutes. Google needs this time.
7. Run the Server & maps test again (next section).

---

## How to check

The app has a test page for everything in this guide.

1. Open the app. Turn on **mobile data** (the stick Wi-Fi has no internet).
2. On Home, tap the **stick picture** (the big stick in the first card). The page "Stick diagnostics" opens.
   If the stick is not set up yet, this opens the setup instead. Then use: profile picture (top right)
   → **Settings** → **Stick & hardware**.
3. Scroll down to **Diagnostics**. Tap **Server & maps test**.
4. The test starts by itself. Wait until it says "… passed, … failed". **Run again** repeats it.
5. Every step should say **PASS**. A failed step has an orange line. It says what to do and names a
   section of this file, for example `See docs/GOOGLE_CLOUD_SETUP.md, "2 Enable APIs".`
6. Tap **Copy report**. Paste it where you need help. The report has **no keys and no tokens**.
7. With the stick connected, also tap **Test AI vision**. It sends one camera photo to the AI (one AI
   request).

On the PC, `npm run doctor` also tests the browser key: its check **Maps key (Places API)** must be PASS.

What each step means:

| Step | PASS means | When it is not PASS, read |
|---|---|---|
| Internet | The phone reaches Google. | Turn on mobile data. |
| Firebase config | The app was built with the `VITE_FIREBASE_*` values from `.env`. | Fill `.env`, then build and install again. |
| Signed in | You are signed in to the app. | Sign in. |
| App Check token | The phone got an App Check token. | "6 App Check" |
| Server ping | The functions are deployed and set up. Its line shows `maps key set`, `Gemini key set` and `places ok · routes ok · geocode ok · gemini ok`. | "4 Server key", "5 Gemini key", "6 App Check", "7 Deploy functions" |
| Maps search via server | The server found a hospital. | "2 Enable APIs", "4 Server key" |
| In-app Google Places | The app found a place with the browser key. | "2 Enable APIs", "3 Browser key" |
| In-app Google route | The browser key can use the old Directions API. | The Directions note in "2 Enable APIs". A FAIL here is OK when "Server ping" shows `routes ok`. |
| OpenStreetMap fallback | OpenStreetMap search works (the last resort). | Check the internet. |
| Gemini Live token | Voice mode can start. | "5 Gemini key" |
| AI vision (button "Test AI vision") | One stick photo went to the AI, and the AI answered. | "5 Gemini key", "6 App Check" |

A step can also say **SKIP** (not tested, for example no GPS position yet) or **INFO** (a note, not an
error).

### Which project?

A key belongs to one Google Cloud project. An API must be enabled in **the key's own project**.
Google's error text names that project by its number, for example "project 599970506387".

* Your Firebase project number: Firebase console → ⚙ **Project settings** → **General** → "Project number".
* In Google Cloud console, pick the project at the top. **Dashboard** → "Project info" shows its number.

If the numbers differ, you are changing the wrong project. Make **both Maps keys** in the Firebase
project. The Gemini key may come from another project (Google AI Studio can make one).

---

## 1 Billing

Google Maps needs a billing account. Cloud Functions and secrets need the Firebase **Blaze** plan.
Google gives a free monthly amount for Maps, so testing costs little.

1. Firebase console → your project → **Upgrade** (bottom of the left menu) → choose **Blaze**. This
   links a billing account.
2. Google Cloud console → **Billing**. Check that your project shows this billing account.
3. Recommended: Billing → **Budgets & alerts** → **Create budget** with a small amount. Google sends you
   an e-mail when the costs reach it.

Test: no error text says `BILLING_DISABLED` or "billing". The app's words for this problem are
"Turn on billing for the Google Cloud project." and "Map unavailable: Google Maps billing or quota
problem."

## 2 Enable APIs

Every API the app uses must be **enabled** in the project.

1. Open each link below.
2. Check the project name at the top of the page.
3. Click **Enable**. (**Manage** means it is already on.)

The links are for your project **599970506387**. For another project, change the number at the end of
the link. Or use Google Cloud console → **APIs & Services** → **Library** and search for the name.

| API | Enable link | Used for | Key |
|---|---|---|---|
| Places API (New) | https://console.cloud.google.com/apis/library/places.googleapis.com?project=599970506387 | search, on the server and in the app | server and browser |
| Maps JavaScript API | https://console.cloud.google.com/apis/library/maps-backend.googleapis.com?project=599970506387 | the map in the app | browser |
| Routes API | https://console.cloud.google.com/apis/library/routes.googleapis.com?project=599970506387 | walking routes on the server | server |
| Geocoding API | https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com?project=599970506387 | "where am I" and the saved home address | server |
| Generative Language API | https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com?project=599970506387 | the AI assistant and picture description. **Only if the Gemini key is made in this project.** | Gemini |

Notes:

* Choose **Places API (New)**. The old "Places API" is a different API. The app uses the new one.
* The old **Directions API** is a "legacy" API. Projects made after March 2025 usually cannot enable it.
  That is fine: the app then takes walking routes from the server (Routes API) or from OpenStreetMap.
  In the Server & maps test, "In-app Google route" then fails; you can ignore it when "Server ping"
  shows `routes ok`. If your project can still enable it
  (https://console.cloud.google.com/apis/library/directions-backend.googleapis.com?project=599970506387),
  enable it and tick it on the browser key too.
* After you enable an API, **wait about 5 minutes**. Then run the test again.

Test: "Server ping" shows `places ok · routes ok · geocode ok`, and "In-app Google Places" is PASS.

## 3 Browser key

The `.env` line is `VITE_GOOGLE_MAPS_BROWSER_KEY=...`. This key is built into the app. Anyone can read
it from the APK, so it **must be restricted**.

1. Google Cloud console → **APIs & Services** → **Credentials**. Open the browser key, or make one with
   **Create credentials** → **API key**.
2. **Application restrictions: Websites.** Add these addresses (one per line):
   * `https://localhost/*` (the Android app: inside Android the app's address is https://localhost)
   * `http://localhost/*` and `http://localhost:5173/*` (only for `npm run dev` on the PC)
   * only if you use the Guardian web app: `https://YOUR-PROJECT-ID.web.app/*` and
     `https://YOUR-PROJECT-ID.firebaseapp.com/*`

   Do **not** choose "Android apps" for this key. The map runs in a web page inside the app. Google
   checks the website address, not the Android app.
3. **API restrictions: Restrict key.** Tick **Maps JavaScript API** and **Places API (New)**. (Also
   Directions API, if your project could enable it.)
4. Click **Save**. The change can take 5 minutes.
5. Put the key in `.env`: `VITE_GOOGLE_MAPS_BROWSER_KEY=...` (no quotes, no spaces).
6. The key is built into the app. After every change in `.env`, build and install again:
   `npm run apk:install`.

Test:

* PC: `npm run doctor`. The check **Maps key (Places API)** must be PASS. (The map itself cannot be
  tested from the PC.)
* Phone: the map shows, and "In-app Google Places" is PASS.

## 4 Server key

A second key, used only by the Cloud Functions. It is a Firebase **secret**, not a line in a file.

1. Google Cloud console → **Credentials** → **Create credentials** → **API key**. Give it a name, for
   example "Server key".
2. **Application restrictions: None.** (Cloud Functions have no fixed address. A website or Android
   restriction would block them.)
3. **API restrictions: Restrict key.** Tick **Places API (New)**, **Routes API** and **Geocoding API**.
   Click **Save**.
4. In a terminal in the project folder, run:

   ```
   firebase functions:secrets:set MAPS_SERVER_KEY
   ```

   Paste the key when it asks (in `cmd`, a right-click pastes) and press Enter. You do not see the key.
   That is normal.
5. Deploy the functions again (section "7 Deploy functions"). A new secret is used only after a deploy.

Never put this key in `.env` or in `functions/.env`.

Test: "Server ping" shows `maps key set` and `places ok · routes ok · geocode ok`. When a check shows
an error such as `403 PERMISSION_DENIED: …`, the words after it are Google's reason:

* "… has not been used in project … or it is disabled" → section "2 Enable APIs".
* "Requests to this API … are blocked" → step 3 of this section (tick that API on the server key).
* "API key not valid" → make the secret again (step 4), then deploy.

## 5 Gemini key

1. Make a key in Google AI Studio: https://aistudio.google.com/apikey → **Create API key**. You can
   choose your Firebase project there.
   Or make it in Google Cloud console → **Credentials** in this project, and restrict it to
   **Generative Language API** (enable that API first, section "2 Enable APIs").
2. In a terminal in the project folder, run:

   ```
   firebase functions:secrets:set GEMINI_API_KEY
   ```

3. Deploy the functions again (section "7 Deploy functions").

Never put this key in `.env` or in `functions/.env`.

Test: "Server ping" shows `Gemini key set` and `gemini ok`. "Gemini Live token" is PASS. With the stick
connected, "Test AI vision" describes one camera photo.

If `gemini` shows `404 NOT_FOUND`, the AI model name in `functions/.env` is wrong. Copy the model lines
from `functions/.env.example` into `functions/.env`, then deploy again.

## 6 App Check

App Check proves to the server that the call comes from **your real app**. The functions accept calls
only with a valid App Check token (`ENFORCE_APPCHECK=true` in `functions/.env`, the default). Only
`serverPing` (used by the Server & maps test) skips this check, so the test can tell you what is wrong.

On Android the app gets its token from **Play Integrity**. An APK installed from your PC (USB, not from
the Play Store) **fails Play Integrity**. Then the server refuses maps and the AI, and the app says
"Server refused the request (sign-in or App Check)".

The app never waits for App Check longer than 8 seconds. Without a token the call still goes out, and
the server answers "unauthenticated" at once. After a failure the app does not wait again for a while
(15 seconds at first, up to 5 minutes).

For a test APK, choose **A** or **B**. For the Play Store, use **C**.

### Option A: debug token (best for test phones)

1. In `.env` set `VITE_APPCHECK_DEBUG=true`.
2. Phone on USB. Run `npm run apk:install -- --logcat` (build, install, then show the phone log).
3. Open the app on the phone. In the log, find the green `>>` line from `DebugAppCheckProvider`:

   ```
   Enter this debug secret into the allow list in the Firebase Console for your project: 1a2b3c4d-...
   ```

   (Newer Firebase versions print `Firebase App Check debug token: 1a2b3c4d-...` instead.)
   Copy the long code. It looks like `1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d` (36 letters and dashes).
   In Android Studio you can also open **Logcat** and search for `debug secret`.
4. Firebase console → **App Check** → **Apps** tab → your Android app (`in.aismartstick.app`) → menu ⋮
   → **Manage debug tokens** → **Add debug token**. Give it a name ("my phone"), paste the code,
   **Save**.
5. Close the app fully and open it again.

Notes:

* One code per phone. If you uninstall the app (or clear its data), the phone makes a new code. Add it
  again. `npm run apk:install` keeps the app data, so the code stays the same.
* The code is a secret. Do not share it. Delete it in Firebase when you do not need it any more.
* If the menu ⋮ has no "Manage debug tokens", register the app with Play Integrity first (option C,
  steps 2 and 3). For a test APK, use the SHA-256 of your PC's debug key. `npm run doctor` shows
  its SHA-1; for the SHA-256 run this in `cmd` (keytool is in Android Studio's `jbr\bin` folder):
  `keytool -list -v -keystore "%USERPROFILE%\.android\debug.keystore" -alias androiddebugkey -storepass android`
* For a Play Store build, set `VITE_APPCHECK_DEBUG=false` again.

Test: "App Check token" is PASS, and "Server ping" shows `App Check valid yes`.

### Option B: turn the check off for a short test

1. In `functions/.env` set `ENFORCE_APPCHECK=false`.
2. Deploy the functions (section "7 Deploy functions").

Sign-in is still needed. In the Server & maps test, "Server ping" now shows `(required no)`. If the
phone has no valid token, "App Check token" shows INFO ("Not needed now …") instead of FAIL.

**Turn it back on** before other people use the app: set `ENFORCE_APPCHECK=true` and deploy again.

### Option C: Play Integrity (real users, Google Play)

1. Find the SHA-256 of the key that signs the Play version: Play Console → your app → **App integrity**
   → **App signing** → "App signing key certificate" → SHA-256.
2. Firebase console → ⚙ **Project settings** → **General** → **Your apps** → the Android app →
   **Add fingerprint** → paste the SHA-256 → **Save**.
3. Firebase console → **App Check** → **Apps** → the Android app → **Play Integrity** → **Register**.
4. Play Console → **App integrity** → Play Integrity API → link your Google Cloud project (the Firebase
   project).
5. Build with `VITE_APPCHECK_DEBUG=false`. Upload the app to Google Play (internal testing is enough).
   **Install it from Google Play.**

An APK installed over USB never passes Play Integrity. For that, use option A.

## 7 Deploy functions

The app calls the functions in region **`asia-south1`** (Mumbai). This is set in
`functions/src/common.ts`. The `.env` line `VITE_FIREBASE_FUNCTIONS_REGION=asia-south1` must be the
same. If you change `.env`, build and install the app again.

One time on the PC:

1. Install the Firebase CLI: `npm install -g firebase-tools`
2. `firebase login`
3. `.firebaserc` must name your Firebase project (or run `firebase use --add`).

Deploy (in the project folder):

```
cd functions
npm install
npm run build
firebase deploy --only functions
```

(`npm install` is needed only the first time and after package changes.)

If the CLI asks to enable an API (for example Cloud Functions, Cloud Build, Artifact Registry or
Secret Manager), answer **Yes**.

Deploy again after **every** change of: a secret (sections 4 and 5), `functions/.env`, or the code in
`functions/` or `shared/`.

After the deploy, Firebase console → **Functions** lists them, for example `serverPing`, `mapsSearch`,
`mapsRoute`, `assistantVision`, all in `asia-south1`. Their logs: Firebase console → Functions →
**Logs**, or `firebase functions:log`.

The first call after a deploy, or after a quiet time, can take 5 to 15 seconds (a "cold start"). The
app waits up to 20 seconds for the server search. After 3.5 seconds it also starts the in-app search,
and after 5 seconds it says "Still searching… the server is slow to start.". So search keeps working
while the server wakes up.

Test: "Server ping" is PASS. `not-found` means the function is not deployed, or it is deployed in
another region.

---

## Message in the app → what to do

Search messages can have several parts, for example
`Search unavailable. Server search: … Also: In-app search: … Also: OpenStreetMap: …`.
Fix each part on its own.

### Search and routes through the server (server key)

| Message in the app | What to do |
|---|---|
| No internet connection. | Turn on mobile data. |
| Google Maps refused the server's request (HTTP 403: Places API (New) has not been used in project … before or it is disabled). Check MAPS_SERVER_KEY and the enabled APIs. | Enable that API in that project: "2 Enable APIs". Wait 5 minutes. |
| Google Maps refused the server's request (HTTP 403: Requests to this API … are blocked). Check MAPS_SERVER_KEY and the enabled APIs. | Tick that API in the server key's API restrictions: "4 Server key". |
| Could not reach the server. Check the internet connection. | Check mobile data. If the internet works, run the Server & maps test: "Server ping" shows the real reason. |
| The server did not answer in time (slow first start, App Check, or functions not deployed). | Try again (cold start). Then "7 Deploy functions" and "6 App Check". |
| The server did not answer in … s (slow first start, App Check, or functions not deployed). | The same as above. |
| Server refused the request (sign-in or App Check). See docs/GOOGLE_CLOUD_SETUP.md, "6 App Check". | Sign in. Then "6 App Check" (debug token, or ENFORCE_APPCHECK=false for a test). |
| Maps is not set up on the server (MAPS_SERVER_KEY). See docs/GOOGLE_CLOUD_SETUP.md, "4 Server key". | "4 Server key", then "7 Deploy functions". |
| Server refused the request (App Check or Maps key). See docs/GOOGLE_CLOUD_SETUP.md. | "6 App Check" and "4 Server key". |
| Maps service is not deployed (firebase deploy --only functions). | "7 Deploy functions". |
| Google Maps quota reached. Try again later. | Wait a few minutes. Check billing: "1 Billing". |
| The server could not be reached or failed (no internet, functions not deployed, or a server error). | Check the internet. Then "7 Deploy functions" and the function logs. |
| Google Maps server error (check MAPS_SERVER_KEY and enabled APIs). | "4 Server key" and "2 Enable APIs". |

### Search, route and map in the app (browser key)

| Message in the app | What to do |
|---|---|
| Google Maps in the app refused the search (Places API (New) is not enabled in project …). Fix: Google Cloud → APIs & Services → enable Places API (New), … | "2 Enable APIs", then "3 Browser key" step 3. |
| Google Maps in the app refused the search (the browser key is not allowed to use this API). … | "3 Browser key" step 3: tick Places API (New). |
| Google Maps in the app refused the search (the browser key does not allow this app). … | "3 Browser key" step 2: add `https://localhost/*`. |
| In-app walking directions are not available for this Google project (the old Directions API cannot be turned on). | Nothing to do. Routes come from the server or OpenStreetMap. |
| Map blocked: the Google Maps key does not allow this app. | "3 Browser key" step 2: add `https://localhost/*`. |
| Map unavailable: Maps JavaScript API is not enabled for this key. | "2 Enable APIs" (Maps JavaScript API), then "3 Browser key" step 3. |
| Map unavailable: Google Maps billing or quota problem. | "1 Billing". |
| Map unavailable: the Google Maps key is not valid. | Copy the key again into `.env` ("3 Browser key" step 5), build and install again. |
| Google Maps is not set up in this build. Set VITE_GOOGLE_MAPS_BROWSER_KEY in .env and rebuild. | "3 Browser key". |
| Google Maps in the app could not load (no internet, or Google is blocked). | Check the internet. |
| Google Maps in the app did not answer in 15 s. | Check the internet. Try again. |

### OpenStreetMap (last resort)

| Message in the app | What to do |
|---|---|
| Type 3 or more letters to search OpenStreetMap. | Type a longer name. |
| OpenStreetMap search did not answer in 8 s. / OpenStreetMap search could not be reached (…). | Check the internet. Try again. |
| OpenStreetMap search failed (HTTP …). / OpenStreetMap route failed (…). | The free service is busy. Wait a minute. Fix the Google parts of the message. |

### Server & maps test ("TO DO" lines)

| TO DO line | What to do |
|---|---|
| Turn on mobile data (the stick Wi-Fi has no internet), then run again. | Mobile data on. |
| Fill the VITE_FIREBASE_* values in .env and build the app again. | Firebase console → Project settings → Your apps → Web app → Config. |
| Sign in to the app first. The server and maps need it. | Sign in. |
| Find the debug token in logcat ("debug secret") and add it in Firebase console → App Check → Manage debug tokens. | "6 App Check", option A. |
| Play Integrity fails on a sideloaded APK. Build with VITE_APPCHECK_DEBUG=true and register the debug token, or set ENFORCE_APPCHECK=false for testing. | "6 App Check", option A or B. |
| The server requires App Check and this phone's token was not valid. … | "6 App Check", option A or B. |
| Not needed now: the server does not check App Check (ENFORCE_APPCHECK=false). Turn it back on before you share the app. | Only a reminder. "6 App Check", option B. |
| serverPing is not on the server yet. Deploy the functions. | "7 Deploy functions". |
| Set the MAPS_SERVER_KEY secret, then deploy the functions. | "4 Server key". |
| Set the GEMINI_API_KEY secret, then deploy the functions. | "5 Gemini key". |
| Enable "Places API (New)" in the Google Cloud project and allow it on the browser key. | "2 Enable APIs", then "3 Browser key" step 3. |
| Enable "…" in the Google Cloud project. (any API name: Places API (New), Routes API, Geocoding API, Generative Language API) | "2 Enable APIs" (in the project of the key that failed). |
| Add https://localhost/* to the website restrictions of the browser key. | "3 Browser key" step 2. |
| The server key (MAPS_SERVER_KEY) does not allow "…": add it to the key's API restrictions. | "4 Server key" step 3. |
| Check the browser key (VITE_GOOGLE_MAPS_BROWSER_KEY): it is missing or not valid. | "3 Browser key". |
| Turn on billing for the Google Cloud project. | "1 Billing". |
| The browser key cannot use "Directions API" (a legacy API). … | OK to ignore when "Server ping" shows `routes ok` (see "2 Enable APIs"). |
| No answer in time. Run the test again (the first start is slow). … | Run again. Then "7 Deploy functions". |
| OpenStreetMap did not answer. Check the internet, then run again. | Check the internet. |
| Too many tests in a short time. Wait a minute, then run again. | Wait a minute. |
| The camera is busy (live video). Wait a moment and try again. | Close other camera viewers (a Chrome tab with `:81/stream`). Try again. |
| The stick camera gave no photo. Run the Connection test. | Diagnostics → Connection test. |
| Connect the stick first. | Connect the stick. |

### Camera and AI (Camera page, assistant)

| Message | What to do |
|---|---|
| The server did not accept this app. Try again later. | "6 App Check". |
| Picture description is not set up on the server yet. | "5 Gemini key", then "7 Deploy functions". |
| It took too long. Check the internet and try again. | Check the internet. Try again (cold start). |
| Could not reach the server. Check the internet and try again. | Check the internet. Then the Server & maps test. |
| The stick camera did not answer. Try again. | Come closer to the stick. Run the Connection test. |
| The assistant says: "The server refused this app (App Check). …" | "6 App Check". |
| The assistant says: "The AI picture service is not set up on the server (Gemini key missing). …" | "5 Gemini key". |
| The assistant says: "The AI picture service has a key problem on the server (Gemini key). …" | "5 Gemini key" (check the key and `gemini` in "Server ping"). |
| The assistant says: "The picture service is not installed on the server yet." | "7 Deploy functions". |
| The assistant says: "The stick camera is busy right now (the live video is using it). …" | Close other camera viewers. Try again. |
| The assistant says: "The phone could not reach the server. …" | Check the internet. |
