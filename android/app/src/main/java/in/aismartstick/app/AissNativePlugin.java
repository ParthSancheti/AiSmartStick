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
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
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
    private final ExecutorService io = Executors.newCachedThreadPool();
    private ConnectivityManager.NetworkCallback setupCallback;
    private volatile Network setupNetwork;
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
            resolveConnect(call, true, null, "existing");
            return;
        }

        if (Build.VERSION.SDK_INT < 29) {
            // Android 9 and older have no WifiNetworkSpecifier: the user joins SmartStick_AI in Wi-Fi settings.
            resolveConnect(call, false, "UNSUPPORTED", null);
            return;
        }

        if (onlyIfVisible) {
            Boolean visible = ssidVisible(ssid);
            if (!Boolean.TRUE.equals(visible)) {
                resolveConnect(call, false, visible == null ? "RANGE_UNKNOWN" : "NOT_IN_RANGE", null);
                return;
            }
        }

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
                JSObject event = new JSObject();
                event.put("event", "WIFI_CONNECTED");
                event.put("ip", "192.168.4.1");
                notifyListeners("WIFI_STATE", event);
                settleConnect(true, null);
            }

            @Override
            public void onUnavailable() {
                if (setupCallback != this) return;
                settleConnect(false, "UNAVAILABLE");
            }

            @Override
            public void onLost(Network network) {
                if (setupCallback != this) return;
                if (network.equals(setupNetwork)) setupNetwork = null;
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
            for (ScanResult r : rs) {
                if (r.timestamp > newest) newest = r.timestamp;
                if (r.SSID != null && ssid.equals(r.SSID.replace("\"", ""))) return Boolean.TRUE;
            }
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
        r.put("locationEnabled", locationEnabled());
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
        final Network net;
        try {
            net = stickRoute();
        } catch (NotBound e) {
            call.reject("Setup request failed: " + e.getMessage());
            return;
        }
        final String method = call.getString("method", "GET");
        final String path = call.getString("path", "/");
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
                call.resolve(r);
            } catch (Exception e) {
                call.reject("Setup request failed: " + e.getMessage());
            } finally {
                if (c != null) c.disconnect();
            }
        });
    }

    @PluginMethod
    public void requestBinary(PluginCall call) {
        final Network net;
        try {
            net = stickRoute();
        } catch (NotBound e) {
            call.reject("requestBinary failed: " + e.getMessage());
            return;
        }
        final String path = call.getString("path", "/");
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
                call.resolve(r);
            } catch (Exception e) {
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
        releaseSetup();
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
        setupSsid = null;
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
        stopDiscoveryInternal();
        releaseSetup();
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
