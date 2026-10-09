# AI SmartStick Doctor

The doctor is one command for your computer.
It checks your setup. It fixes common problems.
It builds the app, makes the APK and puts it on your phone.
It can also build the stick firmware.

At the end it writes a file called `doctor-report.txt`.
You can paste this file into your AI IDE when you need help.

---

## 1. Before you start

Install these programs (one time):

| Program | Why | Where |
|---|---|---|
| Node.js **22 LTS** or **24 LTS** | Runs the doctor and builds the app. The project needs Node.js 22.12 or newer. | https://nodejs.org (choose "LTS") |
| Android Studio | Gives you the Android SDK, `adb` and Java 21. Open it **once** after you install it. | https://developer.android.com/studio |
| Arduino IDE 2 | Only for the stick firmware. | https://www.arduino.cc/en/software |

Copy your 4 secret files into the project:

| File | Put it here |
|---|---|
| `.env` | the project folder (next to `package.json`) |
| `functions/.env` | the `functions` folder |
| `.firebaserc` | the project folder |
| `google-services.json` | `android/app/` |

Tip: Windows hides file endings.
Notepad may save `.env` as `.env.txt`.
A browser may save `google-services (1).json`.
The doctor finds these files and can rename them for you.

Open a terminal in the project folder:

* In File Explorer, open the project folder. Click the address bar. Type `cmd` and press Enter.
* Or in your AI IDE: Terminal > New Terminal.

---

## 2. The commands

| Command | What it does |
|---|---|
| `npm run doctor` | Checks everything. Then typecheck, tests, web build and Capacitor sync. It changes nothing. |
| `npm run doctor:fix` | The same, and it fixes what it can fix. |
| `npm run apk` | Fix + build + makes the APK file. |
| `npm run apk:install` | Fix + build + APK + installs it on your phone (USB cable). |
| `npm run logcat` | Shows the app's log from the phone. Ctrl+C stops it. |
| `npm run doctor -- --firmware` | Builds the stick firmware, or shows the Arduino IDE steps. |
| `npm run doctor -- --firmware --port COM5` | Builds and uploads the firmware. |
| `npm run doctor -- --checks-only` | Only the checks. No build. |
| `npm run doctor -- --help` | Shows all options. |

**Start like this:**

1. `npm run doctor:fix`
2. Fix every FAIL (read the `fix:` lines).
3. `npm run apk:install`

More options (put them after `--`):

* `--skip-tests` : do not run the tests (for example `npm run apk -- --skip-tests`).
* `--verbose` : show all the output of every step.
* `--dry-run` : show what the doctor would fix and run. It changes nothing.
* `--logcat` together with `--install` : install, then show the log.

The options go after `--`. Example: `npm run doctor -- --checks-only`.
If you forget the `--`, the doctor still understands most options.
Only `--help` needs the `--`.

---

## 3. How to read the result

Every check has one word:

* **PASS** : good.
* **WARN** : it works for now, but something is missing or not ideal. Read the line.
* **FAIL** : you must fix this. The app will not build or will not work.
* **SKIP** : not tested (for example no internet for the Maps key test).

Under each WARN and FAIL there is a `fix:` line. It tells you what to do.
A `fixed:` line means the doctor already fixed it.

Steps have PASS, FAIL or SKIP (not run).
When a step fails, the doctor stops there.
It shows the last 40 lines of that step and a `fix:` line.

The last line is `RESULT: OK` or `RESULT: FAILED`.

---

## 4. The checks

| Check | What it means | When it is not PASS |
|---|---|---|
| **Node.js** | Your Node.js version. This project needs 22.12 or newer. | Install Node.js 22 LTS or 24 LTS. Close the terminal and open a new one. |
| **npm** | npm comes with Node.js. | Install Node.js again. |
| **Project folder** (Windows) | The folder path. Problems: non-English letters, OneDrive, a very long path. | Move the project to a short folder, for example `C:\dev\aismartstick`. |
| **node_modules** | The JavaScript packages are installed, and they fit this computer. | `npm run doctor:fix` (it runs `npm install`). If `node_modules` came from another computer, the doctor deletes it and installs it again. |
| **functions/node_modules** | Packages for the Cloud Functions. Only needed to deploy them. | `npm run doctor:fix` |
| **capacitor.config.json** | App id `in.aismartstick.app`, `webDir` is `dist`, CapacitorHttp is off. | Take this file from the original ZIP. |
| **.env** | Your app settings. All six `VITE_FIREBASE_...` keys need a value. The doctor shows key **names** only, never the values. | Firebase console > Project settings > Your apps > Web app > Config. Copy each value into `.env`. If it says "UTF-16" or "BOM": `npm run doctor:fix`. |
| **Google Maps key** | `VITE_GOOGLE_MAPS_BROWSER_KEY` has a value. Without it the map does not load. | Make a key in Google Cloud console > APIs & Services > Credentials. In the key's **Website restrictions**, allow `https://localhost/*`. Do **not** use an "Android apps" restriction for this key. See `docs/GOOGLE_CLOUD_SETUP.md`, "3 Browser key". |
| **Maps key (Places API)** | The doctor asks Google one small question with your browser key: a Places API (New) search for "hospital", from the app's address `https://localhost/`. This is the same search the app makes. The key is never shown. | **FAIL "Places API (New) is not enabled in project ..."**: open the link in the `fix:` line, click **Enable**, wait about 5 minutes, run the doctor again (`docs/GOOGLE_CLOUD_SETUP.md`, "2 Enable APIs"). **FAIL "does not allow the app's address"** or **"Android apps" restriction**: set the key's Application restrictions to **Websites** and add `https://localhost/*`. **FAIL "API restrictions do not include Places API (New)"**: tick Maps JavaScript API and Places API (New) on the key. **FAIL "not valid"**: copy the key again into `.env`. **WARN "works from any other website"**: the key has no Website restriction; add one. **SKIP**: no internet (or a proxy blocks it); test on the phone instead. The map itself (Maps JavaScript API) cannot be tested from the PC: use Diagnostics > Server & maps test on the phone. |
| **functions/.env** | Settings for the Cloud Functions. Only needed to deploy them. | Copy the missing lines from `functions/.env.example`. `GEMINI_API_KEY` and `MAPS_SERVER_KEY` are not in this file: they are Firebase secrets. |
| **App Check (debug APK)** | An APK from your PC does not come from the Play Store. Google says "not trusted". Then maps and the assistant are refused. | See section 6, "App Check token". |
| **.firebaserc** | Your Firebase project id. Only needed for `firebase deploy`. | Copy your `.firebaserc` into the project folder. |
| **google-services.json** | The Firebase file for Android. It must be in `android/app/`. It must be for `in.aismartstick.app`. It must have a "Web client ID" (Google sign-in needs it). | Firebase console > Project settings > Your apps > Android app > download `google-services.json`. No Web client ID: Authentication > Sign-in method > turn on Google, then download the file again. |
| **Gradle Java setting** | `android/gradle.properties` can point to one Java folder (`org.gradle.java.home`). If that folder is not on your PC, every build stops. | `npm run doctor:fix` turns that line into a comment. Then Android Studio's Java (or JAVA_HOME) is used. |
| **Java (JDK 21)** | Building the APK needs Java 21. | Install Android Studio (it has Java 21). WARN is OK: the doctor then uses Android Studio's Java by itself. To use it everywhere, set `JAVA_HOME` to that folder, usually `C:\Program Files\Android\Android Studio\jbr`. |
| **Gradle wrapper** | The files `android/gradlew.bat` and `android/gradle/wrapper/...` are there. | Take the `android` folder from the ZIP. "Linux line endings": `npm run doctor:fix`. |
| **Android SDK** | Where the Android SDK is. Usually `C:\Users\YOU\AppData\Local\Android\Sdk`. | Open Android Studio once (it installs the SDK). Then `npm run doctor:fix`. It writes `android/local.properties`. |
| **adb (phone over USB)** | The tool that installs the app and reads the phone log. | Android Studio > Tools > SDK Manager > SDK Tools > tick "Android SDK Platform-Tools" > Apply. |
| **Google sign-in SHA-1** | Your PC signs debug APKs with its own key. Firebase must know this key, or Google sign-in fails. This check appears after your first APK build. | Copy the SHA-1 that the doctor shows. Firebase console > Project settings > Your apps > Android app > "Add fingerprint". Then download `google-services.json` again. |
| **Firmware sketch** | The folder `firmware/ai_smart_stick_v1` is there. It shows the firmware version (FW_VERSION). `partitions.csv` is there. | Take the `firmware` folder from the ZIP. |
| **arduino-cli (optional)** | A command-line tool for Arduino. You do not need it. Without it, use the Arduino IDE. | Nothing to do. |

---

## 5. The steps

The doctor runs these steps, in this order:

| Step | Command | What it does |
|---|---|---|
| Typecheck | `npm run typecheck` | Finds mistakes in the code. |
| Unit tests | `npx vitest run` | Runs the tests. |
| Firmware tests | `npm run test:firmware` | Tests the stick's safety logic. Needs `g++`. Without `g++` this step is skipped. That is OK. |
| Web build | `npm run build` | Makes the `dist` folder. |
| Capacitor sync | `npx cap sync android` | Copies `dist` into the Android project. |
| APK build | `android\gradlew.bat assembleDebug` | Makes the APK (only with `npm run apk` or `npm run apk:install`). |
| Install on phone | `adb install -r ...` | Puts the APK on the phone (only with `npm run apk:install`). |

The first APK build is slow (10 to 30 minutes). Gradle downloads many files. The next builds are much faster.

The APK file is here:
`android\app\build\outputs\apk\debug\app-debug.apk`

You can also build in Android Studio: run `npm run doctor` first, then open the `android` folder in Android Studio and press Run.

---

## 6. The phone

### Turn on USB debugging (one time)

1. Open Settings > About phone. Tap **Build number** 7 times.
   (Xiaomi: tap "MIUI version" or "OS version". Samsung: it is inside "Software information".)
2. Open Settings and search for **Developer options**. Turn on **USB debugging**.
3. Connect the phone with a USB **data** cable. (Some cables can only charge.)
4. On the phone, tap **Allow** on "Allow USB debugging?".
5. Xiaomi, Redmi and POCO: in Developer options also turn on **Install via USB**.

Then run `npm run apk:install`.

If you see `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: another build of the app is on the phone (for example from another PC).
Uninstall the app on the phone first. This deletes the app's data on the phone (you must pair the stick again).

### See the log

Run `npm run logcat`. It clears the old log and then shows the app's lines:

* red `!!` : the app crashed (FATAL EXCEPTION)
* red `!` : an error (also JavaScript errors)
* green `>>` : the App Check debug token

Press **Ctrl+C** to stop.
Windows may ask "Terminate batch job (Y/N)?". Type `Y` and press Enter.

To install and then see the log in one go: `npm run apk:install -- --logcat`

Useful lines for the server, the camera and maps:

* `[SERVER] mapsSearch ok 850ms` or `[SERVER] mapsSearch unauthenticated 120ms` : one line per server call, with its result.
* `[SMARTSTICK] server test: ...` : every step of the Server & maps test.
* `[SMARTSTICK] stream: ...` (tag `AissNative`) and `[SMARTSTICK] camera stream: ...` : the live camera video.
* `[app-check] ...` and `[VISION] ...` : App Check and AI picture problems.

### App Check token

A test APK from your PC needs an App Check **debug token**:

1. In `.env` set `VITE_APPCHECK_DEBUG=true`.
2. Run `npm run apk:install -- --logcat`.
3. Open the app. In the log, find the green `>>` line from `DebugAppCheckProvider`:
   "Enter this debug secret into the allow list in the Firebase Console for your project: ..."
   (newer Firebase versions: "Firebase App Check debug token: ..."). Copy the long code (like `1a2b3c4d-5e6f-...`, 36 letters and dashes).
4. Firebase console > App Check > Apps > your Android app > menu (three dots) > Manage debug tokens > add the code.
5. For a Play Store build, set `VITE_APPCHECK_DEBUG=false` again.

All the details (and the other choices): `docs/GOOGLE_CLOUD_SETUP.md`, "6 App Check".

---

## 7. The stick firmware (ESP32-CAM)

Run `npm run doctor -- --firmware`.

* **With arduino-cli:** the doctor builds the firmware.
  To upload it too: `npm run doctor -- --firmware --port COM5`.
  Find the COM number in Device Manager > Ports (COM & LPT).
* **Without arduino-cli:** the doctor shows these Arduino IDE steps:

1. File > Preferences > "Additional boards manager URLs": add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. Tools > Board > Boards Manager: search **esp32** (by Espressif Systems). Choose version **2.0.17** (a 2.0.x version, **not** 3.x). Install.
3. File > Open: `firmware\ai_smart_stick_v1\ai_smart_stick_v1.ino`
4. Tools > Board > esp32 > **AI Thinker ESP32-CAM**.
5. Put the ESP32-CAM on its **ESP32-CAM-MB** USB board and plug it in. Tools > Port: choose its COM port.
   No port? Install the CH340 USB driver.
6. Keep `partitions.csv` next to the `.ino` file. The IDE uses it by itself (ignore the "Partition Scheme" menu).
7. Click Verify (the tick).
8. Hold the **IO0** (BOOT) button on the MB board. Click Upload. Keep holding IO0 until you see "Writing at 0x...". Then let go.
9. When it says "Hard resetting", press **RST** once.
   Serial Monitor at 115200 baud shows a line that starts with `[boot]` and the firmware version.
10. Take the ESP32-CAM **off** the MB board before you use the stick.
    The MB board holds the button pin (GPIO3) high. The stick button does not work while the MB board is attached.

Do not press the stick button while you upload.
If the upload fails, try another USB cable or a lower "Upload Speed" in the Tools menu.

---

## 8. doctor-report.txt

Every run writes `doctor-report.txt` in the project folder (next to `package.json`).

It has: the date, your Windows version, the versions of your tools, every check, every step,
and the last lines of a failed step.
It has **no secret values**. Keys are shown by name only. Values in tool output are hidden.

Apart from `npm install` (only with `--fix`), the only network call of the checks is the Maps key test
(one small Places search with the browser key). It never prints the key.

Need help? Open `doctor-report.txt`, copy all of it, paste it into your AI IDE and ask:
"Please help me fix this."

The file is not added to git (it is in `.gitignore`).

---

## 9. What `--fix` changes

`--fix` (also in `npm run doctor:fix`, `npm run apk` and `npm run apk:install`) only does these things:

* runs `npm install` (in the project folder and in `functions`)
* deletes `node_modules` first, if it came from another computer
* renames `.env.txt` to `.env`, `google-services (1).json` to `google-services.json`, and similar
* moves `google-services.json` into `android/app/` if it is in the wrong folder
* saves `.env` again as plain UTF-8, if it was saved as UTF-16 or "UTF-8 with BOM"
* turns a wrong `org.gradle.java.home` line in `android/gradle.properties` into a comment
* creates `android/local.properties` (or fixes the `sdk.dir` line in it)
* changes `android/gradlew.bat` to Windows line endings
* with `--firmware`: installs the ESP32 core 2.0.17 for arduino-cli

It never changes the values in your `.env`.
To see what it would do, without changes: `npm run doctor -- --fix --dry-run`

---

## 10. Common problems

| Problem | What to do |
|---|---|
| `'npm' is not recognized` | Node.js is not installed, or the terminal was open while you installed it. Install Node.js. Open a new terminal. |
| PowerShell says `running scripts is disabled on this system` | Use `cmd` instead of PowerShell. Or run this once in PowerShell: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| The first APK build takes very long | This is normal. Gradle downloads many files the first time. |
| `SDK location not found` | `npm run doctor:fix` |
| Errors that talk about Java | Read the "Java (JDK 21)" check. |
| `EPERM` or `EBUSY` (a file is locked) | Close Android Studio and other terminals. Try again. |
| Errors about long paths or strange letters in the path | Move the project to `C:\dev\aismartstick`. |
| Unit tests fail, but you need an APK now | `npm run apk -- --skip-tests` (fix the tests later). |
| Google sign-in fails on the phone | Read the "Google sign-in SHA-1" and "google-services.json" checks. |
| Map is grey or says "not allowed" | Read the "Google Maps key" and "Maps key (Places API)" checks: allow `https://localhost/*`. |
| Search says "Places API (New) has not been used in project ... or it is disabled" | Read the "Maps key (Places API)" check. Open the link in its `fix:` line and click Enable. Full guide: `docs/GOOGLE_CLOUD_SETUP.md`. |
| Maps or assistant say "App Check" | Section 6, "App Check token". |
| Anything about the server, Maps keys or the AI | On the phone: Diagnostics > Server & maps test > Copy report. Then `docs/GOOGLE_CLOUD_SETUP.md`. |
