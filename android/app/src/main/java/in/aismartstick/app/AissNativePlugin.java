package in.aismartstick.app;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.location.LocationManager;
import android.os.Handler;
import android.os.Looper;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.net.Uri;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSpecifier;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
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

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import javax.net.SocketFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
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
    private static final String TAG = "AissNative";
    private final ExecutorService io = Executors.newCachedThreadPool();
    // Written on the plugin thread, read on the ConnectivityManager callback thread: volatile.
    private volatile ConnectivityManager.NetworkCallback setupCallback;
    private volatile Network setupNetwork;
    /** The network Android handed us for the "Connect to device" request (vs. one joined by hand). */
    private volatile Network requestedNetwork;
    /** "Use stick Wi-Fi for the whole app" (bindProcessToNetwork). Off unless the user turns it on. */
    private volatile boolean processBindWanted;
    private volatile Network processBoundTo;
    private volatile long lastRequestLogAt;
    private String setupSsid;
    private DatagramSocket discoverySocket;
    private WifiManager.MulticastLock multicastLock;
    private SharedPreferences securePrefs;
    /** Calls waiting for the in-flight stick network request (transport + setup may ask at once). */
    private final List<PluginCall> connectWaiters = new ArrayList<>();
    private boolean connecting;
    private final Handler main = new Handler(Looper.getMainLooper());
    private static final AtomicInteger SMS_SEQ = new AtomicInteger();
    private static final int MAX_TEXT_BYTES = 1 << 20;
    private static final int MAX_BINARY_BYTES = 4 << 20;

    /** Starts the first intent that resolves. Never throws (OEM ROMs lack some Settings screens). */
    private boolean launch(Intent... candidates) {
        for (Intent i : candidates) {
            try {
                getContext().startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                return true;
            } catch (Exception ignored) {
            }
        }
        return false;
    }

    /** "[SMARTSTICK] …" lines in logcat (tag AissNative; `npm run logcat` shows them). */
    private static void log(String msg) {
        try {
            Log.i(TAG, "[SMARTSTICK] " + msg);
        } catch (Throwable ignored) {
        }
    }

    private Intent appDetails() {
        return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
    }

    private boolean locationEnabled() {
        try {
            LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return true;
            if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
            return lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) {
            return true;
        }
    }

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
        final String prefix = call.getString("prefix", "AISmartStick-");
        final WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm == null || !wm.isWifiEnabled()) {
            call.reject("Wi-Fi is off");
            return;
        }
        final boolean locOn = locationEnabled();
        final AtomicBoolean finished = new AtomicBoolean(false);
        final BroadcastReceiver[] holder = { null };
        final Runnable finish = () -> {
            if (!finished.compareAndSet(false, true)) return;
            if (holder[0] != null) {
                try {
                    getContext().unregisterReceiver(holder[0]);
                } catch (Exception ignored) {
                }
            }
            JSArray arr = new JSArray();
            try {
                List<ScanResult> results = wm.getScanResults();
                if (results != null) {
                    for (ScanResult r : results) {
                        if (r.SSID == null) continue;
                        String ssid = r.SSID.replace("\"", "");
                        if (ssid.startsWith(prefix) && r.frequency < 3000) {
                            JSObject o = new JSObject();
                            o.put("ssid", ssid);
                            o.put("rssi", r.level);
                            arr.put(o);
                        }
                    }
                }
            } catch (SecurityException e) {
                call.reject("Wi-Fi scanning permission denied");
                return;
            }
            JSObject ret = new JSObject();
            ret.put("networks", arr);
            ret.put("locationEnabled", locOn);
            call.resolve(ret);
        };
        boolean started = false;
        try {
            holder[0] = new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent intent) {
                    finish.run();
                }
            };
            androidx.core.content.ContextCompat.registerReceiver(getContext(), holder[0], new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
            // Throttled by Android (4 scans / 2 min): false means only cached results are available.
            started = wm.startScan();
        } catch (Exception ignored) {
        }
        if (!started) finish.run();
        else main.postDelayed(finish, 6000);
    }

    /**
     * Makes the stick reachable, in this order:
     *  1. already bound to it (alive)                                → connected (via "bound")
     *  2. the phone is already on the stick's Wi-Fi (joined by hand
     *     in Android settings, or an earlier binding): a Wi-Fi
     *     network with a 192.168.4.x address exists                  → adopt it (via "existing")
     *  3. Android 10+: WifiNetworkSpecifier — ONE system "Connect to
     *     device" sheet (it scans by itself; no app scan needed)    → via "request"
     * Permissions are NOT required here (the system sheet does the scan); a missing one only makes
     * Android refuse, which is reported as a reason instead of being guessed up front.
     */
    @PluginMethod
    public void connectToSetupNetwork(PluginCall call) {
        int t = call.getInt("timeoutMs", 30000);
        final int timeout = t > 0 ? t : 30000;
        final boolean openPanel = !Boolean.FALSE.equals(call.getBoolean("openWifiPanelIfOff", true));
        // Reconnects: only ask Android when the last Wi-Fi scan saw the stick, so a switched-off stick
        // never makes the system "Connect to device" sheet pop up again and again.
        final boolean onlyIfVisible = Boolean.TRUE.equals(call.getBoolean("onlyIfVisible", false));
        final String ssid = call.getString("ssid", "SmartStick_AI");
        final String passphrase = call.getString("passphrase", "Stick@1234");

        WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null && !wm.isWifiEnabled()) {
            if (openPanel) launch(new Intent(Settings.Panel.ACTION_WIFI), new Intent(Settings.ACTION_WIFI_SETTINGS));
            resolveConnect(call, false, "WIFI_DISABLED", null);
            return;
        }

        synchronized (connectWaiters) {
            // Already bound to this stick network (telemetry reconnects call this every time): keep it.
            if (setupNetwork != null && alive(setupNetwork)) {
                if (setupSsid == null) setupSsid = ssid;
                resolveConnect(call, true, null, "bound");
                return;
            }
            if (connecting) log("connect: a request is already in flight, waiting for it");
            // A request for the same network is in flight: wait for it instead of cancelling it
            // (cancelling would leave the first caller's promise pending forever).
            if (connecting && ssid.equals(setupSsid)) {
                connectWaiters.add(call);
                return;
            }
        }

        Network existing = findStickWifi();
        if (existing != null) {
            // Joined by hand (or Android kept an earlier connection): use it directly, no dialog.
            setupNetwork = existing;
            setupSsid = ssid;
            log("connect: using the Wi-Fi already on 192.168.4.x (joined by hand)");
            applyProcessBinding();
            resolveConnect(call, true, null, "existing");
            return;
        }

        if (Build.VERSION.SDK_INT < 29) {
            // Android 9 and older have no WifiNetworkSpecifier: the user joins SmartStick_AI in Wi-Fi settings.
            log("connect: Android " + Build.VERSION.SDK_INT + " has no WifiNetworkSpecifier (join by hand)");
            resolveConnect(call, false, "UNSUPPORTED", null);
            return;
        }

        if (onlyIfVisible) {
            Boolean visible = ssidVisible(ssid);
            if (!Boolean.TRUE.equals(visible)) {
                log("connect: last scan " + (visible == null ? "unknown" : "does not show " + ssid) + ", not asking Android now");
                resolveConnect(call, false, visible == null ? "RANGE_UNKNOWN" : "NOT_IN_RANGE", null);
                return;
            }
        }
        log("connect: asking Android to join " + ssid + " (timeout " + timeout + " ms)");

        releaseSetup();

        final WifiNetworkSpecifier spec;
        try {
            // Dashcam topology: the stick is always its own AP. Android remembers the user's approval
            // for this SSID, so later requests (app restart, reconnect) connect without a dialog.
            spec = new WifiNetworkSpecifier.Builder().setSsid(ssid).setWpa2Passphrase(passphrase).build();
        } catch (Exception e) {
            call.reject("Invalid stick network settings: " + e.getMessage());
            return;
        }
        NetworkRequest req = new NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(spec)
            .build();
        final ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        final ConnectivityManager.NetworkCallback cb = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                if (setupCallback != this) return;
                setupNetwork = network;
                requestedNetwork = network;
                log("network available: stick Wi-Fi bound");
                applyProcessBinding();
                JSObject event = new JSObject();
                event.put("event", "WIFI_CONNECTED");
                event.put("ip", "192.168.4.1");
                notifyListeners("WIFI_STATE", event);
                settleConnect(true, null);
            }

            @Override
            public void onUnavailable() {
                if (setupCallback != this) return;
                log("network unavailable: Android did not join (not found, declined or timed out)");
                settleConnect(false, "UNAVAILABLE");
            }

            @Override
            public void onLost(Network network) {
                if (setupCallback != this) return;
                if (network.equals(setupNetwork)) setupNetwork = null;
                if (network.equals(requestedNetwork)) requestedNetwork = null;
                log("network lost: stick Wi-Fi gone (out of range / stick off)");
                applyProcessBinding();
                JSObject event = new JSObject();
                event.put("event", "WIFI_LOST");
                event.put("ip", "192.168.4.1");
                notifyListeners("WIFI_STATE", event);
            }
        };
        synchronized (connectWaiters) {
            setupSsid = ssid;
            setupCallback = cb;
            connecting = true;
            connectWaiters.add(call);
        }
        try {
            // Shows ONE system dialog ("Connect to device?"). Mobile data stays the default network.
            cm.requestNetwork(req, cb, timeout);
        } catch (Exception e) {
            // Take this call out first: releaseSetup() resolves every waiter, and a call settles once.
            synchronized (connectWaiters) {
                connectWaiters.remove(call);
            }
            releaseSetup();
            log("connect: requestNetwork failed: " + e);
            if (e instanceof SecurityException) resolveConnect(call, false, "PERMISSION_DENIED", null);
            else call.reject("Could not request the stick network: " + e.getMessage());
        }
    }

    private static void resolveConnect(PluginCall call, boolean connected, String reason, String via) {
        JSObject r = new JSObject();
        r.put("connected", connected);
        if (reason != null) r.put("reason", reason);
        if (via != null) r.put("via", via);
        call.resolve(r);
    }

    /** True while Android still knows the network (a lost network has no capabilities). */
    private boolean alive(Network n) {
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            return cm != null && cm.getNetworkCapabilities(n) != null;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * A Wi-Fi network on the stick's subnet (192.168.4.x, the ESP32 soft-AP default), e.g. joined by
     * hand in Android settings. Needs no location permission (unlike reading the SSID).
     */
    @SuppressWarnings("deprecation")
    private Network findStickWifi() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return null;
            for (Network n : cm.getAllNetworks()) {
                NetworkCapabilities nc = cm.getNetworkCapabilities(n);
                if (nc == null || !nc.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
                LinkProperties lp = cm.getLinkProperties(n);
                if (lp == null) continue;
                for (LinkAddress la : lp.getLinkAddresses()) {
                    InetAddress a = la.getAddress();
                    if (!(a instanceof Inet4Address)) continue;
                    byte[] q = a.getAddress();
                    if ((q[0] & 0xff) == 192 && (q[1] & 0xff) == 168 && (q[2] & 0xff) == 4) return n;
                }
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    /**
     * Whether the last Wi-Fi scan saw this SSID. null = Android will not say (no location permission,
     * location off, no or stale results). Also kicks a new scan (Android throttles it; harmless).
     */
    @SuppressWarnings("deprecation")
    private Boolean ssidVisible(String ssid) {
        try {
            WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm == null || ssid == null) return null;
            if (getPermissionState("location") != PermissionState.GRANTED || !locationEnabled()) return null;
            try {
                wm.startScan();
            } catch (Exception ignored) {
            }
            List<ScanResult> rs = wm.getScanResults();
            if (rs == null || rs.isEmpty()) return null;
            long nowUs = android.os.SystemClock.elapsedRealtime() * 1000L;
            long newest = 0;
            boolean staleMatch = false;
            for (ScanResult r : rs) {
                if (r.timestamp > newest) newest = r.timestamp;
                if (r.SSID != null && ssid.equals(r.SSID.replace("\"", ""))) {
                    // Only a recent sighting counts: Android throttles scans, so the cache can list a
                    // stick that was switched off minutes ago.
                    if (nowUs - r.timestamp <= 45_000_000L) return Boolean.TRUE;
                    staleMatch = true;
                }
            }
            if (staleMatch) return null;
            // Results older than 45 s say nothing about a stick that was just switched on.
            if (nowUs - newest > 45_000_000L) return null;
            return Boolean.FALSE;
        } catch (Exception e) {
            return null;
        }
    }

    /** Thrown when a binding was requested but the stick network is gone (the app re-binds at once). */
    private static final class NotBound extends Exception {
        private static final long serialVersionUID = 1L;

        NotBound() {
            super("not bound to the stick network (connection lost)");
        }
    }

    /**
     * The network stick HTTP goes over: the bound/adopted stick network; else a Wi-Fi network on the
     * stick subnet; else (nothing ever requested) the default route. Never mobile data while a
     * binding was requested but lost: that would only time out.
     */
    private Network stickRoute() throws NotBound {
        // A hand-joined network has no callback: release a binding to a network that is gone at once,
        // or the whole app would keep pointing at a dead network (no internet).
        Network pb = processBoundTo;
        if (pb != null && !alive(pb)) applyProcessBinding();
        Network net = setupNetwork;
        if (net != null && alive(net)) return net;
        Network found = findStickWifi();
        if (found != null) {
            setupNetwork = found;
            return found;
        }
        if (net != null) setupNetwork = null;
        if (setupCallback != null || net != null) throw new NotBound();
        return null;
    }

    /** The stick network right now (bound or joined by hand), or null. */
    private Network currentStickNetwork() {
        Network n = setupNetwork;
        if (n != null && alive(n)) return n;
        return findStickWifi();
    }

    /** Keeps bindProcessToNetwork in step with the wish and the current stick network. */
    private synchronized void applyProcessBinding() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return;
            Network target = processBindWanted ? currentStickNetwork() : null;
            Network cur = processBoundTo;
            if (target == null && cur == null) return;
            if (target != null && target.equals(cur)) return;
            cm.bindProcessToNetwork(target);
            processBoundTo = target;
            log(target != null ? "whole app now runs over the stick Wi-Fi" : "whole app back on the normal network");
        } catch (Exception e) {
            log("process binding failed: " + e);
        }
    }

    /**
     * LAST-RESORT fallback (off by default): ALL app traffic, the WebView included, goes over the
     * stick Wi-Fi. Maps, the assistant and Firebase stop while it is on (the stick has no internet).
     */
    @PluginMethod
    public void setProcessBinding(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        processBindWanted = on;
        applyProcessBinding();
        JSObject r = new JSObject();
        boolean bound = processBoundTo != null;
        // A failed attempt leaves no pending wish: otherwise the whole app would silently move to the
        // stick Wi-Fi (no internet) the next time it appears while the switch shows OFF.
        if (on && !bound) processBindWanted = false;
        r.put("bound", bound);
        if (on && !bound) r.put("reason", "NO_STICK_NETWORK");
        call.resolve(r);
    }

    /** bound = the "Connect to device" network, wifi = joined by hand, process / default = default route. */
    private String viaOf(Network net) {
        if (net == null) return processBoundTo != null ? "process" : "default";
        return net.equals(requestedNetwork) ? "bound" : "wifi";
    }

    /** Telemetry is polled twice a second: log its failures at most every 5 s, everything else always. */
    private void logRequest(String what, String path) {
        long now = System.currentTimeMillis();
        boolean noisy = path != null && path.startsWith("/api/v1/telemetry");
        if (noisy && now - lastRequestLogAt < 5000) return;
        if (noisy) lastRequestLogAt = now;
        log(what);
    }

    /** Status bar icon colour: dark icons on the light theme, light icons on the dark theme. */
    @PluginMethod
    public void setStatusBarIcons(PluginCall call) {
        final boolean darkIcons = Boolean.TRUE.equals(call.getBoolean("dark", false));
        try {
            getActivity().runOnUiThread(() -> {
                try {
                    android.view.Window w = getActivity().getWindow();
                    androidx.core.view.WindowInsetsControllerCompat c = androidx.core.view.WindowCompat.getInsetsController(w, w.getDecorView());
                    if (c != null) {
                        c.setAppearanceLightStatusBars(darkIcons);
                        c.setAppearanceLightNavigationBars(darkIcons);
                    }
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    /** Android's font size setting. The WebView is pinned to 100 % (MainActivity); the app scales text itself from this. */
    @PluginMethod
    public void getFontScale(PluginCall call) {
        float scale = 1f;
        try {
            scale = getContext().getResources().getConfiguration().fontScale;
        } catch (Exception ignored) {
        }
        JSObject r = new JSObject();
        r.put("fontScale", (Object) Double.valueOf(scale));
        call.resolve(r);
    }

    /** Wi-Fi state for the setup screen: on/off, current SSID (needs location), stick network present. */
    @PluginMethod
    @SuppressWarnings("deprecation")
    public void getCurrentWifiSsid(PluginCall call) {
        WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        boolean enabled = wm != null && wm.isWifiEnabled();
        String ssid = null;
        try {
            WifiInfo info = enabled ? wm.getConnectionInfo() : null;
            String s = info != null ? info.getSSID() : null;
            if (s != null) {
                s = s.replace("\"", "");
                if (!s.isEmpty() && !"<unknown ssid>".equals(s)) ssid = s;
            }
        } catch (Exception ignored) {
        }
        JSObject r = new JSObject();
        r.put("wifiEnabled", enabled);
        if (ssid != null) r.put("ssid", ssid);
        r.put("stickNetwork", findStickWifi() != null);
        r.put("bound", setupNetwork != null);
        r.put("requested", setupCallback != null);
        r.put("connecting", connecting);
        r.put("processBound", processBoundTo != null);
        r.put("locationEnabled", locationEnabled());
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    /** Resolves every caller waiting for the current request. */
    private void settleConnect(boolean connected, String reason) {
        List<PluginCall> waiting;
        synchronized (connectWaiters) {
            connecting = false;
            waiting = new ArrayList<>(connectWaiters);
            connectWaiters.clear();
        }
        for (PluginCall c : waiting) resolveConnect(c, connected, reason, connected ? "request" : null);
    }

    @PluginMethod
    public void setupRequest(PluginCall call) {
        final String path = call.getString("path", "/");
        // route "default": skip the stick binding and use the process default network (fallback path:
        // the phone's Wi-Fi IS the stick and mobile data is off, or the whole app is bound to it).
        final boolean defaultRoute = "default".equals(call.getString("route", "auto"));
        final Network net;
        try {
            net = defaultRoute ? null : stickRoute();
        } catch (NotBound e) {
            logRequest("GET " + path + ": not bound (stick Wi-Fi lost)", path);
            call.reject("Setup request failed: " + e.getMessage());
            return;
        }
        final String via = viaOf(net);
        final String method = call.getString("method", "GET");
        final String body = call.getString("body");
        final String bodyBase64 = call.getString("bodyBase64");
        final JSObject headers = call.getObject("headers", new JSObject());
        final int timeout = call.getInt("timeoutMs", 8000);
        io.execute(() -> {
            HttpURLConnection c = null;
            try {
                // Bound to the stick network specifically, regardless of the default route.
                // net is null only when no binding was requested and no stick Wi-Fi is up (default route).
                URL url = new URL(SETUP_HOST + path);
                c = (HttpURLConnection) (net != null ? net.openConnection(url) : url.openConnection());
                c.setRequestMethod(method);
                c.setConnectTimeout(timeout);
                c.setReadTimeout(timeout);
                c.setUseCaches(false);
                // The stick purges idle sockets (LRU, 5 max): never reuse a pooled keep-alive socket.
                c.setRequestProperty("Connection", "close");
                applyHeaders(c, headers);
                if (bodyBase64 != null) {
                    byte[] bytes = Base64.decode(bodyBase64, Base64.DEFAULT);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(bytes.length);
                    c.setRequestProperty("content-type", "application/octet-stream");
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(bytes);
                    }
                } else if (body != null) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(bytes.length);
                    c.setRequestProperty("content-type", "application/json");
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(bytes);
                    }
                }
                int status = c.getResponseCode();
                InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = is.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        if (out.size() > MAX_TEXT_BYTES) throw new java.io.IOException("response too large");
                    }
                }
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", out.toString("UTF-8"));
                r.put("via", via);
                if (!path.startsWith("/api/v1/telemetry") || status != 200) logRequest(method + " " + path + " " + status + " " + out.size() + "B via " + via, path);
                call.resolve(r);
            } catch (Exception e) {
                logRequest(method + " " + path + " failed via " + via + ": " + e, path);
                call.reject("Setup request failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    @PluginMethod
    public void requestBinary(PluginCall call) {
        final String path = call.getString("path", "/");
        final boolean defaultRoute = "default".equals(call.getString("route", "auto"));
        final Network net;
        try {
            net = defaultRoute ? null : stickRoute();
        } catch (NotBound e) {
            call.reject("requestBinary failed: " + e.getMessage());
            return;
        }
        final String via = viaOf(net);
        final JSObject headers = call.getObject("headers", new JSObject());
        final int timeout = call.getInt("timeoutMs", 8000);
        io.execute(() -> {
            HttpURLConnection c = null;
            try {
                URL url = new URL(SETUP_HOST + path);
                c = (HttpURLConnection) (net != null ? net.openConnection(url) : url.openConnection());
                c.setRequestMethod("GET");
                c.setConnectTimeout(timeout);
                c.setReadTimeout(timeout);
                c.setUseCaches(false);
                // The stick purges idle sockets (LRU, 5 max): never reuse a pooled keep-alive socket.
                c.setRequestProperty("Connection", "close");
                applyHeaders(c, headers);

                int status = c.getResponseCode();
                if (status >= 400) {
                    JSObject r = new JSObject();
                    r.put("status", status);
                    r.put("body", "");
                    r.put("via", via);
                    log("GET " + path + " " + status + " via " + via);
                    call.resolve(r);
                    return;
                }
                
                InputStream is = c.getInputStream();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                if (is != null) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = is.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        if (out.size() > MAX_BINARY_BYTES) throw new java.io.IOException("image too large");
                    }
                }
                String base64Image = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
                
                JSObject r = new JSObject();
                r.put("status", status);
                r.put("body", base64Image);
                r.put("contentType", c.getContentType());
                r.put("via", via);
                call.resolve(r);
            } catch (Exception e) {
                log("GET " + path + " failed via " + via + ": " + e);
                call.reject("requestBinary failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    /** Extra request headers from JS (none for the v1 simple link). */
    private static void applyHeaders(HttpURLConnection c, JSObject headers) {
        if (headers == null) return;
        java.util.Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            String v = headers.getString(k);
            if (v != null) c.setRequestProperty(k, v);
        }
    }

    @PluginMethod
    public void releaseSetupNetwork(PluginCall call) {
        log("release: stick Wi-Fi released by the app");
        processBindWanted = false;
        releaseSetup();
        applyProcessBinding();
        call.resolve();
    }

    private void releaseSetup() {
        settleConnect(false, "CANCELLED");
        if (setupCallback != null) {
            try {
                ((ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE)).unregisterNetworkCallback(setupCallback);
            } catch (Exception ignored) {
            }
        }
        setupCallback = null;
        setupNetwork = null;
        requestedNetwork = null;
        setupSsid = null;
    }

    // ── Live camera: MJPEG stream reader (stick port 81) ─────────
    //
    // GET http://192.168.4.1:81/stream answers multipart/x-mixed-replace, one JPEG per part:
    //   "\r\n--BOUNDARY\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n\r\n<N bytes>"
    // sent in HTTP/1.1 chunks. The stick serves ONE viewer: a second connection is accepted but never
    // answered, so "no answer to the request" means another phone or browser is watching.
    // A raw socket on the stick network (same choice as requestBinary) lets stopStream close it at
    // once, from any thread, so the stick frees its only stream slot right away.

    private static final int STREAM_CONNECT_TIMEOUT_MS = 4000;
    private static final int STREAM_READ_TIMEOUT_MS = 5000;
    private static final int STREAM_MAX_PART = 512 * 1024;
    private static final int[] STREAM_BACKOFF_MS = { 1000, 2000, 4000, 8000 };
    /**
     * Nobody listens to "streamFrame" for this long (the WebView reloaded and Capacitor dropped all
     * listeners): the reader stops by itself, so the stick's only stream slot is not held for nobody.
     */
    private static final long STREAM_ORPHAN_MS = 5000;
    private final Object streamLock = new Object();
    /** Since when no JS listener exists (0 = there is one). Reader thread only. */
    private long streamOrphanSince;
    /** The reader thread. A stopped one may still be closing its socket. Guarded by streamLock. */
    private Thread streamThread;
    /** Bumped by every new reader and every stop: an older reader ends at its next check. */
    private volatile int streamGen;
    private volatile boolean streamWanted;
    private volatile Socket streamSocket;
    private volatile int streamPort = 81;
    private volatile String streamPath = "/stream";
    private volatile int streamMaxFps = 8;
    /** Last state sent to JS (only changes are sent). Guarded by streamLock. */
    private String streamLastState;
    private String streamLastError;

    /** Thrown when the stick accepted the connection but did not answer: another viewer holds the stream. */
    private static final class StreamBusy extends IOException {
        private static final long serialVersionUID = 1L;

        StreamBusy() {
            super("busy: the stick did not answer (another viewer is watching the camera)");
        }
    }

    @PluginMethod
    public void startStream(PluginCall call) {
        int port = call.getInt("port", 81);
        String path = call.getString("path", "/stream");
        int fps = call.getInt("maxFps", 8);
        if (port <= 0 || port > 65535) port = 81;
        if (path == null || !path.startsWith("/")) path = "/stream";
        fps = Math.max(1, Math.min(30, fps));
        boolean started = false;
        synchronized (streamLock) {
            streamPort = port;
            streamPath = path;
            streamMaxFps = fps;
            if (!(streamWanted && streamThread != null && streamThread.isAlive())) {
                streamWanted = true;
                streamLastState = null;
                streamLastError = null;
                final int gen = ++streamGen;
                final Thread previous = streamThread;
                Thread t = new Thread(() -> streamLoop(gen, previous), "aiss-mjpeg");
                t.setDaemon(true);
                streamThread = t;
                t.start();
                started = true;
            }
        }
        log("stream: " + (started ? "start" : "already running, options updated") + " http://192.168.4.1:" + port + path + " (max " + fps + " fps)");
        JSObject r = new JSObject();
        r.put("running", true);
        call.resolve(r);
    }

    @PluginMethod
    public void stopStream(PluginCall call) {
        stopStreamInternal();
        call.resolve();
    }

    private void stopStreamInternal() {
        boolean was;
        synchronized (streamLock) {
            was = streamWanted;
            streamWanted = false;
            streamGen++;
            Thread t = streamThread;
            if (t != null) t.interrupt();
        }
        // Outside the lock: closing unblocks the reader's connect()/read() at once.
        closeQuietly(streamSocket);
        if (was) emitStreamState(-1, "stopped", null, null);
    }

    private boolean streamAlive(int gen) {
        return streamWanted && gen == streamGen;
    }

    /**
     * True when no JS listener for "streamFrame" existed for STREAM_ORPHAN_MS; the reader is then
     * stopped (a page reload drops every listener). Reader thread only.
     */
    private boolean streamOrphaned(int gen) {
        if (hasListeners("streamFrame")) {
            streamOrphanSince = 0;
            return false;
        }
        long now = System.currentTimeMillis();
        if (streamOrphanSince == 0) streamOrphanSince = now;
        if (now - streamOrphanSince < STREAM_ORPHAN_MS) return false;
        synchronized (streamLock) {
            if (!streamAlive(gen)) return true;
            streamWanted = false;
            streamGen++;
        }
        log("stream: stopped, nobody is listening (the page was reloaded?)");
        return true;
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (Exception ignored) {
        }
    }

    /** Sends a state change to JS. gen -1 = always (stop); otherwise only for the current reader. */
    private void emitStreamState(int gen, String state, String error, String via) {
        synchronized (streamLock) {
            if (gen >= 0 && !streamAlive(gen)) return;
            boolean sameError = error == null ? streamLastError == null : error.equals(streamLastError);
            if (state.equals(streamLastState) && sameError) return;
            streamLastState = state;
            streamLastError = error;
        }
        log("stream: " + state + (error != null ? " (" + error + ")" : "") + (via != null ? " via " + via : ""));
        JSObject ev = new JSObject();
        ev.put("state", state);
        if (error != null) ev.put("error", error);
        if (via != null) ev.put("via", via);
        notifyListeners("streamState", ev);
    }

    /** One reader thread: connect, read frames, reconnect with backoff (1, 2, 4, 8 s) while wanted. */
    private void streamLoop(int gen, Thread previous) {
        // The stick serves one viewer: let a stopped reader finish closing its socket first.
        if (previous != null && previous != Thread.currentThread()) {
            try {
                previous.join(2000);
            } catch (InterruptedException e) {
                if (!streamAlive(gen)) return;
            }
        }
        int failures = 0;
        streamOrphanSince = 0;
        while (streamAlive(gen) && !streamOrphaned(gen)) {
            int[] frames = { 0 };
            String error;
            try {
                streamOnce(gen, frames);
                error = frames[0] > 0 ? "stream ended" : "stream ended before the first frame";
            } catch (SocketTimeoutException e) {
                error = frames[0] > 0 ? "no frames for 5 s" : "no camera frames (timed out)";
            } catch (Exception e) {
                error = e.getMessage() != null && !e.getMessage().isEmpty() ? e.getMessage() : e.getClass().getSimpleName();
            }
            if (!streamAlive(gen)) break;
            emitStreamState(gen, "error", error, null);
            failures = frames[0] > 0 ? 1 : failures + 1;
            long wait = STREAM_BACKOFF_MS[Math.min(failures, STREAM_BACKOFF_MS.length) - 1];
            try {
                Thread.sleep(wait);
            } catch (InterruptedException e) {
                if (!streamAlive(gen)) break;
            }
        }
    }

    /** One connection. Returns when the stick ends the stream; throws on errors. frames[0] counts JPEGs read. */
    private void streamOnce(int gen, int[] frames) throws IOException {
        Network net;
        try {
            net = stickRoute();
        } catch (NotBound e) {
            net = null; // stick binding lost: try the process default network (whole app on the stick)
        }
        final String via = net != null ? "stick" : "default";
        final int port = streamPort;
        final String path = streamPath;
        emitStreamState(gen, "connecting", null, via);
        SocketFactory factory = net != null ? net.getSocketFactory() : SocketFactory.getDefault();
        Socket s = factory.createSocket();
        streamSocket = s;
        try {
            // A stop between createSocket and here closed nothing: check after publishing the socket.
            if (!streamAlive(gen)) return;
            try {
                s.connect(new InetSocketAddress("192.168.4.1", port), STREAM_CONNECT_TIMEOUT_MS);
            } catch (SocketTimeoutException e) {
                throw new IOException("stick camera not reachable (connect timed out via " + via + ")");
            }
            s.setSoTimeout(STREAM_READ_TIMEOUT_MS);
            s.setTcpNoDelay(true);
            OutputStream os = s.getOutputStream();
            String req = "GET " + path + " HTTP/1.1\r\nHost: 192.168.4.1:" + port + "\r\nAccept: multipart/x-mixed-replace, image/jpeg\r\nConnection: close\r\n\r\n";
            os.write(req.getBytes(StandardCharsets.US_ASCII));
            os.flush();
            InputStream raw = new BufferedInputStream(s.getInputStream(), 16384);
            String statusLine;
            try {
                statusLine = readAsciiLine(raw, 256);
            } catch (SocketTimeoutException e) {
                throw new StreamBusy();
            }
            if (statusLine == null) throw new IOException("the stick closed the stream at once");
            String[] sp = statusLine.split(" ");
            int code;
            try {
                code = sp.length > 1 && sp[0].startsWith("HTTP/") ? Integer.parseInt(sp[1].trim()) : -1;
            } catch (NumberFormatException e) {
                code = -1;
            }
            if (code < 0) throw new IOException("not an HTTP answer");
            String contentType = null;
            boolean chunked = false;
            for (int i = 0; ; i++) {
                String h = readAsciiLine(raw, 1024);
                if (h == null) throw new IOException("stream ended in the headers");
                if (h.isEmpty()) break;
                if (i > 64) throw new IOException("too many headers");
                int c = h.indexOf(':');
                if (c <= 0) continue;
                String k = h.substring(0, c).trim().toLowerCase(Locale.ROOT);
                String v = h.substring(c + 1).trim();
                if (k.equals("content-type")) contentType = v;
                else if (k.equals("transfer-encoding") && v.toLowerCase(Locale.ROOT).contains("chunked")) chunked = true;
            }
            if (code == 503) throw new IOException("camera unavailable (HTTP 503)");
            if (code != 200) throw new IOException("HTTP " + code);
            if (contentType == null || !contentType.toLowerCase(Locale.ROOT).contains("multipart")) throw new IOException("not a camera stream (" + contentType + ")");
            InputStream in = chunked ? new ChunkedInputStream(raw) : raw;
            readStreamParts(gen, in, boundaryOf(contentType), frames, via);
        } finally {
            if (streamSocket == s) streamSocket = null;
            closeQuietly(s);
        }
    }

    /** Reads parts until the stream ends. Skips garbage, drops parts over 512 KB, throttles to maxFps. */
    private void readStreamParts(int gen, InputStream in, String boundary, int[] frames, String via) throws IOException {
        long nextEmitAt = 0;
        int seq = 0;
        boolean live = false;
        while (streamAlive(gen)) {
            // 1. The boundary line (anything else is garbage).
            String line = readAsciiLine(in, 256);
            if (line == null) return;
            if (!line.startsWith("--") || (boundary != null && !line.contains(boundary))) continue;
            // 2. Part headers.
            int length = -1;
            boolean headersOk = true;
            for (int i = 0; ; i++) {
                String h = readAsciiLine(in, 256);
                if (h == null) return;
                if (h.isEmpty()) break;
                if (i > 32) {
                    headersOk = false;
                    break;
                }
                int c = h.indexOf(':');
                if (c > 0 && h.substring(0, c).trim().equalsIgnoreCase("content-length")) {
                    try {
                        length = Integer.parseInt(h.substring(c + 1).trim());
                    } catch (NumberFormatException e) {
                        length = -1;
                    }
                }
            }
            if (!headersOk || length == 0) continue;
            // 3. The JPEG: by Content-Length, else SOI (FFD8) .. EOI (FFD9).
            byte[] jpeg;
            if (length > STREAM_MAX_PART) {
                log("stream: dropped a " + length + " B part (too large)");
                continue; // resync at the next boundary
            } else if (length > 0) {
                jpeg = new byte[length];
                readFully(in, jpeg);
            } else {
                jpeg = scanJpeg(in);
                if (jpeg == null) continue;
            }
            int soi = -1;
            for (int k = 0; k + 1 < Math.min(jpeg.length, 64); k++) {
                if ((jpeg[k] & 0xff) == 0xff && (jpeg[k + 1] & 0xff) == 0xd8) {
                    soi = k;
                    break;
                }
            }
            if (soi < 0) continue;
            if (soi > 0) jpeg = java.util.Arrays.copyOfRange(jpeg, soi, jpeg.length);
            frames[0]++;
            if (!live) {
                live = true;
                emitStreamState(gen, "live", null, via);
            }
            if (streamOrphaned(gen)) return;
            // Throttle: on average at most maxFps (half a frame of slack for Wi-Fi jitter, so a stick
            // sending exactly maxFps is not halved). Extra frames are dropped, never queued.
            long now = System.currentTimeMillis();
            long interval = 1000L / Math.max(1, streamMaxFps);
            if (now < nextEmitAt - interval / 2) continue;
            nextEmitAt = Math.max(nextEmitAt, now) + interval;
            JSObject ev = new JSObject();
            ev.put("data", Base64.encodeToString(jpeg, Base64.NO_WRAP));
            ev.put("seq", ++seq);
            ev.put("at", (Object) Long.valueOf(now));
            ev.put("bytes", jpeg.length);
            if (streamAlive(gen)) notifyListeners("streamFrame", ev);
        }
    }

    /** boundary=… from the Content-Type (quotes removed), or null. */
    private static String boundaryOf(String contentType) {
        int i = contentType.toLowerCase(Locale.ROOT).indexOf("boundary=");
        if (i < 0) return null;
        String b = contentType.substring(i + 9).trim();
        int semi = b.indexOf(';');
        if (semi >= 0) b = b.substring(0, semi).trim();
        if (b.length() >= 2 && b.startsWith("\"") && b.endsWith("\"")) b = b.substring(1, b.length() - 1);
        return b.isEmpty() ? null : b;
    }

    /** One line without CR/LF (cut to cap chars; the rest of the line is skipped), or null at the end. */
    private static String readAsciiLine(InputStream in, int cap) throws IOException {
        StringBuilder sb = new StringBuilder();
        boolean any = false;
        int b;
        while ((b = in.read()) >= 0) {
            any = true;
            if (b == '\n') break;
            if (b != '\r' && sb.length() < cap) sb.append((char) b);
        }
        return any ? sb.toString() : null;
    }

    private static void readFully(InputStream in, byte[] buf) throws IOException {
        int off = 0;
        while (off < buf.length) {
            int n = in.read(buf, off, buf.length - off);
            if (n < 0) throw new EOFException("stream ended inside a frame");
            off += n;
        }
    }

    /** A part without Content-Length: the bytes from SOI to EOI. null when over 512 KB (resync). */
    private static byte[] scanJpeg(InputStream in) throws IOException {
        int prev = -1;
        int skipped = 0;
        int b;
        while (true) {
            b = in.read();
            if (b < 0) throw new EOFException("stream ended inside a frame");
            if (prev == 0xff && b == 0xd8) break;
            prev = b;
            if (++skipped > STREAM_MAX_PART) return null;
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(16384);
        out.write(0xff);
        out.write(0xd8);
        prev = -1;
        while (true) {
            b = in.read();
            if (b < 0) throw new EOFException("stream ended inside a frame");
            out.write(b);
            if (prev == 0xff && b == 0xd9) return out.toByteArray();
            prev = b;
            if (out.size() > STREAM_MAX_PART) return null;
        }
    }

    /** HTTP/1.1 chunked body (the stick's web server sends the stream in chunks). */
    private static final class ChunkedInputStream extends InputStream {
        private final InputStream in;
        private int left;
        private boolean done;

        ChunkedInputStream(InputStream in) {
            this.in = in;
        }

        private boolean ready() throws IOException {
            if (done) return false;
            if (left > 0) return true;
            String line = readAsciiLine(in, 64);
            while (line != null && line.trim().isEmpty()) line = readAsciiLine(in, 64); // CRLF after a chunk
            if (line == null) {
                done = true;
                return false;
            }
            int semi = line.indexOf(';');
            String hex = (semi >= 0 ? line.substring(0, semi) : line).trim();
            int n;
            try {
                n = Integer.parseInt(hex, 16);
            } catch (NumberFormatException e) {
                throw new IOException("broken chunked stream");
            }
            if (n <= 0) {
                done = true;
                return false;
            }
            left = n;
            return true;
        }

        @Override
        public int read() throws IOException {
            if (!ready()) return -1;
            int b = in.read();
            if (b < 0) {
                done = true;
                return -1;
            }
            left--;
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (len == 0) return 0;
            if (!ready()) return -1;
            int n = in.read(buf, off, Math.min(len, left));
            if (n < 0) {
                done = true;
                return -1;
            }
            left -= n;
            return n;
        }
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
            stopDiscoveryInternal();
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
        launch(new Intent(Intent.ACTION_MAIN).setClassName("com.android.settings", "com.android.settings.TetherSettings"), new Intent(Settings.ACTION_WIRELESS_SETTINGS), new Intent(Settings.ACTION_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void openBluetoothSettings(PluginCall call) {
        launch(new Intent(Settings.ACTION_BLUETOOTH_SETTINGS), new Intent(Settings.ACTION_SETTINGS));
        call.resolve();
    }

    // ── Secure storage (Android Keystore) ────────────────────────

    private SharedPreferences openSecurePrefs() throws Exception {
        MasterKey key = new MasterKey.Builder(getContext()).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
        return EncryptedSharedPreferences.create(getContext(), "aiss_secure", key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    /**
     * The encrypted store. If it can't be decrypted (a file restored from a backup or another phone
     * without its Keystore key), it is unrecoverable by design: wipe it and start empty, so the app
     * simply re-pairs instead of failing every secure read forever.
     */
    private synchronized SharedPreferences prefs() throws Exception {
        if (securePrefs != null) return securePrefs;
        try {
            securePrefs = openSecurePrefs();
        } catch (Exception first) {
            getContext().deleteSharedPreferences("aiss_secure");
            securePrefs = openSecurePrefs();
        }
        return securePrefs;
    }

    /** A single entry that fails to decrypt is dropped rather than failing the read. */
    private String secureRead(String key) throws Exception {
        try {
            return prefs().getString(key, null);
        } catch (SecurityException e) {
            prefs().edit().remove(key).apply();
            return null;
        }
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
            r.put("value", secureRead(call.getString("key")));
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
        if (direct && getPermissionState("phone") == PermissionState.GRANTED && launch(new Intent(Intent.ACTION_CALL, uri))) {
            r.put("result", "call_started");
        } else if (launch(new Intent(Intent.ACTION_DIAL, uri))) {
            r.put("result", "dialer_opened");
        } else {
            call.reject("This phone can't place calls");
            return;
        }
        call.resolve(r);
    }

    @PluginMethod
    public void sendSms(PluginCall call) {
        String number = call.getString("number");
        final String body = call.getString("body", "");
        boolean direct = Boolean.TRUE.equals(call.getBoolean("direct", false));
        if (number == null || number.trim().isEmpty()) {
            call.reject("No number");
            return;
        }
        final String clean = number.replaceAll("[^0-9+]", "");
        if (direct && getPermissionState("sms") == PermissionState.GRANTED && sendDirect(call, clean, body)) return;
        openComposer(call, clean, body);
    }

    private void openComposer(PluginCall call, String clean, String body) {
        JSObject r = new JSObject();
        if (launch(new Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + clean)).putExtra("sms_body", body))) {
            r.put("result", "composer_opened");
            call.resolve(r);
        } else {
            r.put("result", "failed");
            r.put("error", "No messaging app");
            call.resolve(r);
        }
    }

    /**
     * Sends with SmsManager and reports the radio's answer: "sent" only when every part was accepted
     * by the network (RESULT_OK), "failed" otherwise (no service, airplane mode, no SIM credit…).
     * No answer within 30 s → "queued" (handed to Android, outcome unknown).
     */
    private boolean sendDirect(final PluginCall call, String clean, String body) {
        try {
            SmsManager sms = Build.VERSION.SDK_INT >= 31 ? getContext().getSystemService(SmsManager.class) : SmsManager.getDefault();
            if (sms == null) return false;
            final ArrayList<String> parts = sms.divideMessage(body);
            final String action = getContext().getPackageName() + ".SMS_SENT." + SMS_SEQ.incrementAndGet();
            final AtomicInteger remaining = new AtomicInteger(parts.size());
            final AtomicBoolean settled = new AtomicBoolean(false);
            final BroadcastReceiver[] holder = { null };
            final java.util.function.BiConsumer<String, String> settle = (result, error) -> {
                if (!settled.compareAndSet(false, true)) return;
                try {
                    getContext().unregisterReceiver(holder[0]);
                } catch (Exception ignored) {
                }
                JSObject r = new JSObject();
                r.put("result", result);
                if (error != null) r.put("error", error);
                call.resolve(r);
            };
            holder[0] = new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent intent) {
                    int code = getResultCode();
                    if (code != Activity.RESULT_OK) settle.accept("failed", smsError(code));
                    else if (remaining.decrementAndGet() <= 0) settle.accept("sent", null);
                }
            };
            androidx.core.content.ContextCompat.registerReceiver(getContext(), holder[0], new IntentFilter(action), androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED);
            ArrayList<PendingIntent> sent = new ArrayList<>();
            for (int k = 0; k < parts.size(); k++) {
                Intent i = new Intent(action).setPackage(getContext().getPackageName());
                sent.add(PendingIntent.getBroadcast(getContext(), k, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT));
            }
            try {
                sms.sendMultipartTextMessage(clean, null, parts, sent, null);
            } catch (Exception e) {
                try {
                    getContext().unregisterReceiver(holder[0]);
                } catch (Exception ignored) {
                }
                return false; // → composer
            }
            main.postDelayed(() -> settle.accept("queued", null), 30000);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static String smsError(int code) {
        switch (code) {
            case SmsManager.RESULT_ERROR_NO_SERVICE:
                return "No mobile network";
            case SmsManager.RESULT_ERROR_RADIO_OFF:
                return "Mobile radio is off (airplane mode?)";
            case SmsManager.RESULT_ERROR_NULL_PDU:
                return "Message could not be encoded";
            case SmsManager.RESULT_ERROR_GENERIC_FAILURE:
                return "The network rejected the message (check SIM balance)";
            default:
                return "SMS failed (code " + code + ")";
        }
    }

    // ── Background execution (foreground service) ────────────────

    /**
     * Starts the foreground service, or — when it already runs — only updates its notification.
     * `promote: true` (sent when the app comes back to the foreground) re-runs startForeground so
     * permissions granted since (location, microphone) are added to the service types.
     */
    @PluginMethod
    public void startBackgroundService(PluginCall call) {
        String title = call.getString("title", "AI Smart Stick");
        String body = call.getString("body", "Running");
        boolean promote = Boolean.TRUE.equals(call.getBoolean("promote", false));
        if (StickForegroundService.running && !promote) {
            try {
                StickForegroundService.updateNotification(getContext(), title, body);
            } catch (Exception ignored) {
            }
            JSObject r = new JSObject();
            r.put("running", true);
            r.put("types", StickForegroundService.activeTypes);
            call.resolve(r);
            return;
        }
        Intent i = new Intent(getContext(), StickForegroundService.class)
            .putExtra(StickForegroundService.EXTRA_TITLE, title)
            .putExtra(StickForegroundService.EXTRA_BODY, body);
        try {
            androidx.core.content.ContextCompat.startForegroundService(getContext(), i);
            JSObject r = new JSObject();
            r.put("running", true);
            r.put("types", StickForegroundService.activeTypes);
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
        launch(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), appDetails());
        call.resolve();
    }

    /** Android's location switch (GPS off is the most common reason the map shows no position). */
    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        launch(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS), new Intent(Settings.ACTION_SETTINGS));
        call.resolve();
    }

    /** This app's settings page: where a permanently denied permission can be turned back on. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        launch(appDetails(), new Intent(Settings.ACTION_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void openWifiSettings(PluginCall call) {
        launch(new Intent(Settings.Panel.ACTION_WIFI), new Intent(Settings.ACTION_WIFI_SETTINGS));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopStreamInternal();
        stopDiscoveryInternal();
        processBindWanted = false;
        releaseSetup();
        applyProcessBinding();
        main.removeCallbacksAndMessages(null);
        io.shutdownNow();
        // User closed the app (swiped away / back out): don't leave an orphaned foreground service.
        try {
            if (getActivity() != null && getActivity().isFinishing()) {
                getContext().stopService(new Intent(getContext(), StickForegroundService.class));
            }
        } catch (Exception ignored) {
        }
    }
}
