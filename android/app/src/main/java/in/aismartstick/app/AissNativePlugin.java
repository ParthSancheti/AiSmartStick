package in.aismartstick.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.provider.Settings;
import android.telephony.SmsManager;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;
import android.database.Cursor;
import android.provider.ContactsContract;
import android.os.PowerManager;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Native capabilities the WebView doesn't have (see src/core/native/aissNative.ts):
 * stick setup Wi-Fi (WifiNetworkSpecifier), setup HTTP bound to that network, UDP discovery,
 * Keystore-backed secret storage, audio route, calls and SMS with truthful results.
 * NOT compiled in the authoring environment: build and test on a device (ANDROID_SETUP.md).
 */
@CapacitorPlugin(
    name = "AissNative",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "nearbyWifi", strings = { "android.permission.NEARBY_WIFI_DEVICES" }),
        @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE }),
        @Permission(alias = "sms", strings = { Manifest.permission.SEND_SMS })
    }
)
public class AissNativePlugin extends Plugin {
    private static final String SETUP_HOST = "http://192.168.4.1";
    private final ExecutorService io = Executors.newCachedThreadPool();
    private ConnectivityManager.NetworkCallback setupCallback;
    private Network setupNetwork;
    private DatagramSocket discoverySocket;
    private WifiManager.MulticastLock multicastLock;
    private SharedPreferences securePrefs;

    @PluginMethod
    public void scanForSetupNetworks(PluginCall call) {
        boolean locGranted = getPermissionState("location") == PermissionState.GRANTED;
        boolean nearbyGranted = Build.VERSION.SDK_INT < 33 || getPermissionState("nearbyWifi") == PermissionState.GRANTED;

        if (!locGranted || !nearbyGranted) {
            String[] aliases = Build.VERSION.SDK_INT >= 33 ? new String[]{"location", "nearbyWifi"} : new String[]{"location"};
            requestPermissionForAliases(aliases, call, "scanPermCallback");
            return;
        }
        doScan(call);
    }

    @PermissionCallback
    private void scanPermCallback(PluginCall call) {
        boolean locGranted = getPermissionState("location") == PermissionState.GRANTED;
        boolean nearbyGranted = Build.VERSION.SDK_INT < 33 || getPermissionState("nearbyWifi") == PermissionState.GRANTED;
        if (locGranted && nearbyGranted) {
            doScan(call);
        } else {
            call.reject("Wi-Fi scanning permission denied");
        }
    }

    @SuppressWarnings("deprecation")
    private void doScan(PluginCall call) {
        String prefix = call.getString("prefix", "AISmartStick-");
        WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm == null || !wm.isWifiEnabled()) {
            call.reject("Wi-Fi is off");
            return;
        }
        wm.startScan(); // throttled by Android (4 scans / 2 min); cached results are still returned
        JSArray arr = new JSArray();
        List<ScanResult> results = wm.getScanResults();
        for (ScanResult r : results) {
            if (r.SSID != null) {
                String ssid = r.SSID.replace("\"", "");
                if (ssid.startsWith(prefix) && r.frequency < 3000) {
                    JSObject o = new JSObject();
                    o.put("ssid", ssid);
                    o.put("rssi", r.level);
                    arr.put(o);
                }
            }
        }
        JSObject ret = new JSObject();
        ret.put("networks", arr);
        call.resolve(ret);
    }

    @PluginMethod
    public void connectToSetupNetwork(PluginCall call) {
        String ssid = call.getString("ssid");
        String pass = call.getString("passphrase");
        int timeout = call.getInt("timeoutMs", 30000);
        if (ssid == null || pass == null || pass.length() < 8) {
            call.reject("ssid and an 8+ character passphrase are required");
            return;
        }
        if (Build.VERSION.SDK_INT < 29) {
            call.reject("Stick setup needs Android 10 or newer");
            return;
        }
        releaseSetup();
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        WifiNetworkSpecifier spec = new WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(pass).build();
        NetworkRequest req = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(spec)
            .build();
        final boolean[] done = { false };
        setupCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                setupNetwork = network;
                if (!done[0]) {
                    done[0] = true;
                    JSObject r = new JSObject();
                    r.put("connected", true);
                    call.resolve(r);
                }
            }

            @Override
            public void onUnavailable() {
                if (!done[0]) {
                    done[0] = true;
                    JSObject r = new JSObject();
                    r.put("connected", false);
                    call.resolve(r);
                }
            }

            @Override
            public void onLost(Network network) {
                if (network.equals(setupNetwork)) setupNetwork = null;
            }
        };
        // Shows ONE system dialog ("Connect to device?"). Mobile data stays the default network.
        cm.requestNetwork(req, setupCallback, timeout);
    }

    @PluginMethod
    public void setupRequest(PluginCall call) {
        final Network net = setupNetwork;
        if (net == null) {
            call.reject("Not connected to the stick setup network");
            return;
        }
        final String method = call.getString("method", "GET");
        final String path = call.getString("path", "/");
        final String body = call.getString("body");
        final int timeout = call.getInt("timeoutMs", 8000);
        io.execute(() -> {
            HttpURLConnection c = null;
            try {
                // Bound to the setup network specifically, regardless of the default route.
                c = (HttpURLConnection) net.openConnection(new URL(SETUP_HOST + path));
                c.setRequestMethod(method);
                c.setConnectTimeout(timeout);
                c.setReadTimeout(timeout);
                if (body != null) {
                    c.setDoOutput(true);
                    c.setRequestProperty("content-type", "application/json");
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                int status = c.getResponseCode();
                InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
                }
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", out.toString("UTF-8"));
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Setup request failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    @PluginMethod
    public void releaseSetupNetwork(PluginCall call) {
        releaseSetup();
        call.resolve();
    }

    private void releaseSetup() {
        if (setupCallback != null) {
            try {
                ((ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE)).unregisterNetworkCallback(setupCallback);
            } catch (Exception ignored) {
            }
        }
        setupCallback = null;
        setupNetwork = null;
    }

    // ── Discovery (UDP broadcast on the hotspot) ─────────────────

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        stopDiscoveryInternal();
        final int port = call.getInt("port", 4210);
        WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            multicastLock = wm.createMulticastLock("aiss-discovery");
            multicastLock.setReferenceCounted(false);
            multicastLock.acquire();
        }
        try {
            discoverySocket = new DatagramSocket(null);
            discoverySocket.setReuseAddress(true);
            discoverySocket.setBroadcast(true);
            discoverySocket.bind(new InetSocketAddress(port));
        } catch (Exception e) {
            call.reject("Could not listen for the stick: " + e.getMessage());
            return;
        }
        final DatagramSocket sock = discoverySocket;
        io.execute(() -> {
            byte[] buf = new byte[1024];
            while (!sock.isClosed()) {
                try {
                    DatagramPacket p = new DatagramPacket(buf, buf.length);
                    sock.receive(p);
                    JSObject ev = new JSObject();
                    ev.put("json", new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    ev.put("fromIp", p.getAddress().getHostAddress());
                    notifyListeners("announcement", ev);
                } catch (Exception e) {
                    if (sock.isClosed()) break;
                }
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        stopDiscoveryInternal();
        call.resolve();
    }

    private void stopDiscoveryInternal() {
        if (discoverySocket != null) discoverySocket.close();
        discoverySocket = null;
        if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        multicastLock = null;
    }

    // ── Settings shortcuts ───────────────────────────────────────

    @PluginMethod
    public void openHotspotSettings(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_MAIN).setClassName("com.android.settings", "com.android.settings.TetherSettings");
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
        } catch (Exception e) {
            Intent w = new Intent(Settings.ACTION_WIRELESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(w);
        }
        call.resolve();
    }

    @PluginMethod
    public void openBluetoothSettings(PluginCall call) {
        getContext().startActivity(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        call.resolve();
    }

    // ── Secure storage (Android Keystore) ────────────────────────

    private SharedPreferences prefs() throws Exception {
        if (securePrefs == null) {
            MasterKey key = new MasterKey.Builder(getContext()).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
            securePrefs = EncryptedSharedPreferences.create(getContext(), "aiss_secure", key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
        }
        return securePrefs;
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        try {
            prefs().edit().putString(call.getString("key"), call.getString("value")).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Secure storage unavailable: " + e.getMessage());
        }
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        try {
            JSObject r = new JSObject();
            r.put("value", prefs().getString(call.getString("key"), null));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Secure storage unavailable: " + e.getMessage());
        }
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        try {
            prefs().edit().remove(call.getString("key")).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("Secure storage unavailable: " + e.getMessage());
        }
    }

    // ── Audio route ──────────────────────────────────────────────

    @PluginMethod
    public void getAudioRoute(PluginCall call) {
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        String route = "speaker";
        String name = null;
        // Android routes media to the most recently connected external device; report that one.
        for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int t = d.getType();
            boolean bt = t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || (Build.VERSION.SDK_INT >= 31 && (t == 26 /* TYPE_BLE_HEADSET */ || t == 27 /* TYPE_BLE_SPEAKER */));
            boolean wired = t == AudioDeviceInfo.TYPE_WIRED_HEADSET || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES || t == AudioDeviceInfo.TYPE_USB_HEADSET;
            if (bt) {
                route = "bluetooth";
                name = d.getProductName() != null ? d.getProductName().toString() : null;
                break;
            }
            if (wired) route = "wired";
        }
        JSObject r = new JSObject();
        r.put("route", route);
        r.put("name", name);
        call.resolve(r);
    }

    // ── Calls & SMS (truthful results) ───────────────────────────

    @PluginMethod
    public void placeCall(PluginCall call) {
        String number = call.getString("number");
        boolean direct = Boolean.TRUE.equals(call.getBoolean("direct", false));
        if (number == null || number.trim().isEmpty()) {
            call.reject("No number");
            return;
        }
        Uri uri = Uri.parse("tel:" + number.replaceAll("[^0-9+]", ""));
        JSObject r = new JSObject();
        if (direct && getPermissionState("phone") == PermissionState.GRANTED) {
            getContext().startActivity(new Intent(Intent.ACTION_CALL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            r.put("result", "call_started");
        } else {
            getContext().startActivity(new Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            r.put("result", "dialer_opened");
        }
        call.resolve(r);
    }

    @PluginMethod
    public void sendSms(PluginCall call) {
        String number = call.getString("number");
        String body = call.getString("body", "");
        boolean direct = Boolean.TRUE.equals(call.getBoolean("direct", false));
        if (number == null || number.trim().isEmpty()) {
            call.reject("No number");
            return;
        }
        String clean = number.replaceAll("[^0-9+]", "");
        JSObject r = new JSObject();
        if (direct && getPermissionState("sms") == PermissionState.GRANTED) {
            try {
                SmsManager sms = Build.VERSION.SDK_INT >= 31 ? getContext().getSystemService(SmsManager.class) : SmsManager.getDefault();
                ArrayList<String> parts = sms.divideMessage(body);
                sms.sendMultipartTextMessage(clean, null, parts, null, null);
                // "sent" = handed to the Android telephony stack; delivery reports are not tracked yet.
                r.put("result", "sent");
                call.resolve(r);
                return;
            } catch (Exception e) {
                // fall through to composer
            }
        }
        Intent i = new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + clean)).putExtra("sms_body", body).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        r.put("result", "composer_opened");
        call.resolve(r);
    }

    // ── Background execution (foreground service) ────────────────

    @PluginMethod
    public void startBackgroundService(PluginCall call) {
        Intent i = new Intent(getContext(), StickForegroundService.class)
            .putExtra(StickForegroundService.EXTRA_TITLE, call.getString("title", "AI Smart Stick"))
            .putExtra(StickForegroundService.EXTRA_BODY, call.getString("body", "Running"));
        try {
            androidx.core.content.ContextCompat.startForegroundService(getContext(), i);
            JSObject r = new JSObject();
            r.put("running", true);
            call.resolve(r);
        } catch (Exception e) {
            // e.g. ForegroundServiceStartNotAllowedException when started from the background (Android 12+)
            call.reject("Could not start background mode: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopBackgroundService(PluginCall call) {
        getContext().stopService(new Intent(getContext(), StickForegroundService.class));
        JSObject r = new JSObject();
        r.put("running", false);
        call.resolve(r);
    }

    @PluginMethod
    public void isBackgroundServiceRunning(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", StickForegroundService.running);
        call.resolve(r);
    }

    /** Pocket mode: keep the screen on while the touch shield is shown (FLAG_KEEP_SCREEN_ON). */
    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            if (on) getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    // ── Contact picker (system UI; no READ_CONTACTS permission needed for the picked entry) ──

    @PluginMethod
    public void pickContact(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_PICK, ContactsContract.CommonDataKinds.Phone.CONTENT_URI);
        startActivityForResult(call, i, "pickContactResult");
    }

    @ActivityCallback
    private void pickContactResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject r = new JSObject();
            r.put("cancelled", true);
            call.resolve(r);
            return;
        }
        Uri uri = result.getData().getData();
        String[] cols = { ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER };
        try (Cursor c = getContext().getContentResolver().query(uri, cols, null, null, null)) {
            if (c == null || !c.moveToFirst()) {
                call.reject("Could not read the selected contact");
                return;
            }
            JSObject r = new JSObject();
            r.put("cancelled", false);
            r.put("name", c.getString(0));
            r.put("phone", c.getString(1));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Could not read the selected contact: " + e.getMessage());
        }
    }

    // ── Battery optimisation (OEM background killers) ────────────

    @PluginMethod
    public void getBatteryOptimization(PluginCall call) {
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        JSObject r = new JSObject();
        r.put("ignoring", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        r.put("manufacturer", Build.MANUFACTURER);
        call.resolve(r);
    }

    /** Opens the system list; the user chooses "Don't optimise". No restricted permission needed. */
    @PluginMethod
    public void openBatteryOptimizationSettings(PluginCall call) {
        try {
            getContext().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception e) {
            getContext().startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopDiscoveryInternal();
        releaseSetup();
        io.shutdownNow();
    }
}
