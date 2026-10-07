package in.aismartstick.app;

import android.Manifest;
import android.app.Activity;
import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * Phone GPS straight from android.location.LocationManager (see src/core/native/aissLocation.ts).
 *
 * Why not @capacitor/geolocation: it goes through Google Play Services' FusedLocationProvider and
 * its checkPermissions() REJECTS when the location switch is off and treats an "Approximate"
 * grant as not granted. Many phones (old/missing Play Services, Huawei, custom ROMs) then never
 * get a position. LocationManager is part of Android itself: GPS + network (+ the system "fused"
 * provider on Android 12+) + passive, with getLastKnownLocation for an instant first fix.
 *
 * Events: "location" {lat,lng,accuracy,altitude,speed,bearing,time,provider}
 *         "status"   {enabled,gps,network,providers}
 */
@CapacitorPlugin(
    name = "AissLocation",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION })
    }
)
public class AissLocationPlugin extends Plugin {
    private static final String FUSED = "fused";
    private static final long SWITCH_PROVIDER_AFTER_MS = 5000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private LocationManager lm;
    private final List<String> activeProviders = new ArrayList<>();
    private final LocationListener listener = new LocationListener() {
        @Override
        public void onLocationChanged(Location location) {
            deliver(location);
        }

        // Abstract before API 30: must be implemented or older phones crash (AbstractMethodError).
        @Override
        @SuppressWarnings("deprecation")
        public void onStatusChanged(String provider, int status, Bundle extras) {
        }

        @Override
        public void onProviderEnabled(String provider) {
            emitStatus();
        }

        @Override
        public void onProviderDisabled(String provider) {
            emitStatus();
        }
    };
    private BroadcastReceiver providersReceiver;
    private Application.ActivityLifecycleCallbacks lifecycle;
    /** JS asked for updates (start called, stop not called). */
    private volatile boolean wanted = false;
    /** Listener currently registered with LocationManager. */
    private volatile boolean registered = false;
    private long intervalMs = 1000;
    private volatile Location best;

    private LocationManager lm() {
        if (lm == null) lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        return lm;
    }

    private boolean has(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean fine() {
        return has(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private boolean coarse() {
        return has(Manifest.permission.ACCESS_COARSE_LOCATION);
    }

    private JSObject permissionResult() {
        JSObject r = new JSObject();
        boolean f = fine();
        boolean c = f || coarse();
        String state;
        if (c) {
            state = "granted";
        } else {
            PermissionState ps = null;
            try {
                ps = getPermissionState("location");
            } catch (Exception ignored) {
            }
            // DENIED = asked before and Android will no longer show the dialog ("Don't ask again"):
            // only the app's settings page can fix it. Everything else can still be asked.
            state = ps == PermissionState.DENIED ? "denied" : "prompt";
        }
        r.put("state", state);
        r.put("precise", f);
        r.put("coarse", c);
        return r;
    }

    private boolean providerOn(String p) {
        try {
            LocationManager m = lm();
            return m != null && m.getAllProviders().contains(p) && m.isProviderEnabled(p);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean locationEnabled() {
        LocationManager m = lm();
        if (m == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= 28) return m.isLocationEnabled();
        } catch (Exception ignored) {
        }
        return providerOn(LocationManager.GPS_PROVIDER) || providerOn(LocationManager.NETWORK_PROVIDER);
    }

    private JSObject statusObject() {
        JSObject s = new JSObject();
        s.put("enabled", locationEnabled());
        s.put("gps", providerOn(LocationManager.GPS_PROVIDER));
        s.put("network", providerOn(LocationManager.NETWORK_PROVIDER));
        JSArray arr = new JSArray();
        synchronized (activeProviders) {
            for (String p : activeProviders) arr.put(p);
        }
        s.put("providers", arr);
        s.put("running", registered);
        return s;
    }

    private void emitStatus() {
        try {
            notifyListeners("status", statusObject());
        } catch (Exception ignored) {
        }
    }

    /** Age from the monotonic clock: immune to phones whose GPS/wall clock is wrong. */
    private static long ageMs(Location l) {
        if (l.getElapsedRealtimeNanos() > 0) {
            return Math.max(0, (SystemClock.elapsedRealtimeNanos() - l.getElapsedRealtimeNanos()) / 1_000_000L);
        }
        return Math.max(0, System.currentTimeMillis() - l.getTime());
    }

    private static float acc(Location l) {
        return l.hasAccuracy() && l.getAccuracy() > 0 ? l.getAccuracy() : 999f;
    }

    /** Keeps GPS from being replaced by a coarse network fix every second, but switches when GPS goes quiet (indoors). */
    static boolean isBetter(Location next, Location cur) {
        if (cur == null) return true;
        long nextAge = ageMs(next);
        long curAge = ageMs(cur);
        if (nextAge > curAge + 1000) return false; // older than what we have
        if (acc(next) <= acc(cur)) return true;
        String np = next.getProvider();
        if (np != null && np.equals(cur.getProvider())) return true; // same source, newer
        return curAge > SWITCH_PROVIDER_AFTER_MS; // the better source has gone quiet
    }

    /** Boxed values: JSObject.put(String, Object) never throws (the primitive JSONObject overloads do). */
    private static JSObject toJs(Location l) {
        JSObject o = new JSObject();
        o.put("lat", (Object) Double.valueOf(l.getLatitude()));
        o.put("lng", (Object) Double.valueOf(l.getLongitude()));
        o.put("accuracy", (Object) Double.valueOf(acc(l)));
        if (l.hasAltitude()) o.put("altitude", (Object) Double.valueOf(l.getAltitude()));
        else o.put("altitude", JSObject.NULL);
        if (l.hasSpeed()) o.put("speed", (Object) Double.valueOf(l.getSpeed()));
        else o.put("speed", JSObject.NULL);
        if (l.hasBearing()) o.put("bearing", (Object) Double.valueOf(l.getBearing()));
        else o.put("bearing", JSObject.NULL);
        o.put("time", (Object) Long.valueOf(System.currentTimeMillis() - ageMs(l)));
        o.put("provider", l.getProvider() == null ? "unknown" : l.getProvider());
        return o;
    }

    private void deliver(Location l) {
        if (l == null) return;
        if (!isBetter(l, best)) return;
        best = l;
        try {
            notifyListeners("location", toJs(l));
        } catch (Exception ignored) {
        }
    }

    /** Freshest usable cached fix across all providers (null when none or no permission). */
    private Location lastKnown() {
        LocationManager m = lm();
        if (m == null || !(fine() || coarse())) return null;
        Location pick = null;
        List<String> all;
        try {
            all = m.getAllProviders();
        } catch (Exception e) {
            return null;
        }
        for (String p : all) {
            try {
                Location l = m.getLastKnownLocation(p);
                if (l == null) continue;
                if (pick == null || ageMs(l) < ageMs(pick) - 2000 || (ageMs(l) <= ageMs(pick) + 2000 && acc(l) < acc(pick))) pick = l;
            } catch (SecurityException | IllegalArgumentException ignored) {
                // GPS needs FINE; with an "Approximate" grant it throws. Skip it.
            }
        }
        return pick;
    }

    /** Registers every provider this permission level allows (GPS only with a precise grant). */
    private void register() {
        unregister();
        LocationManager m = lm();
        if (m == null || !(fine() || coarse())) return;
        List<String> all;
        try {
            all = m.getAllProviders();
        } catch (Exception e) {
            return;
        }
        List<String> want = new ArrayList<>();
        if (fine() && all.contains(LocationManager.GPS_PROVIDER)) want.add(LocationManager.GPS_PROVIDER);
        if (all.contains(LocationManager.NETWORK_PROVIDER)) want.add(LocationManager.NETWORK_PROVIDER);
        // System fused provider (Android 12+, no Play Services needed).
        if (Build.VERSION.SDK_INT >= 31 && all.contains(FUSED)) want.add(FUSED);
        if (all.contains(LocationManager.PASSIVE_PROVIDER)) want.add(LocationManager.PASSIVE_PROVIDER);
        synchronized (activeProviders) {
            activeProviders.clear();
            for (String p : want) {
                try {
                    // Registering a disabled provider is allowed: it starts delivering when switched on.
                    long every = LocationManager.PASSIVE_PROVIDER.equals(p) ? 0 : intervalMs;
                    m.requestLocationUpdates(p, every, 0f, listener, Looper.getMainLooper());
                    activeProviders.add(p);
                } catch (SecurityException | IllegalArgumentException ignored) {
                    // Provider needs a permission level we don't have, or does not exist on this phone.
                }
            }
            registered = !activeProviders.isEmpty();
        }
    }

    private void unregister() {
        try {
            LocationManager m = lm();
            if (m != null) m.removeUpdates(listener);
        } catch (Exception ignored) {
        }
        synchronized (activeProviders) {
            activeProviders.clear();
        }
        registered = false;
    }

    private void hookSystem() {
        if (providersReceiver == null) {
            providersReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    // Location switch flipped: re-register (a provider may have appeared) and tell JS.
                    if (wanted && locationEnabled()) register();
                    emitStatus();
                }
            };
            try {
                IntentFilter f = new IntentFilter(LocationManager.PROVIDERS_CHANGED_ACTION);
                f.addAction("android.location.MODE_CHANGED");
                ContextCompat.registerReceiver(getContext(), providersReceiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
            } catch (Exception e) {
                providersReceiver = null;
            }
        }
        if (lifecycle == null && getActivity() != null) {
            final Activity mine = getActivity();
            lifecycle = new Application.ActivityLifecycleCallbacks() {
                @Override
                public void onActivityStarted(Activity a) {
                    if (a == mine && wanted && !registered) {
                        register();
                        deliver(lastKnown());
                        emitStatus();
                    }
                }

                @Override
                public void onActivityStopped(Activity a) {
                    // In the background Android only allows "while in use" location to a foreground
                    // service of type location. Without one, stop the radios (battery); resume on return.
                    if (a == mine && wanted && !backgroundAllowed()) unregister();
                }

                @Override
                public void onActivityCreated(Activity a, Bundle b) {
                }

                @Override
                public void onActivityResumed(Activity a) {
                }

                @Override
                public void onActivityPaused(Activity a) {
                }

                @Override
                public void onActivitySaveInstanceState(Activity a, Bundle b) {
                }

                @Override
                public void onActivityDestroyed(Activity a) {
                }
            };
            try {
                mine.getApplication().registerActivityLifecycleCallbacks(lifecycle);
            } catch (Exception e) {
                lifecycle = null;
            }
        }
    }

    private static boolean backgroundAllowed() {
        if (!StickForegroundService.running) return false;
        if (Build.VERSION.SDK_INT < 29) return true;
        return (StickForegroundService.activeTypes & android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) != 0;
    }

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

    // ---------------------------------------------------------------- plugin methods

    @PluginMethod
    public void checkPermission(PluginCall call) {
        call.resolve(permissionResult());
    }

    /**
     * Asks for FINE + COARSE together (Android 12+ shows "Precise / Approximate"). Either answer is
     * accepted. When COARSE is already granted it resolves without a dialog unless upgrade=true.
     */
    @PluginMethod
    public void requestPermission(PluginCall call) {
        boolean upgrade = Boolean.TRUE.equals(call.getBoolean("upgrade", false));
        if (fine() || (coarse() && !upgrade)) {
            call.resolve(permissionResult());
            return;
        }
        requestPermissionForAlias("location", call, "permissionCallback");
    }

    @PermissionCallback
    private void permissionCallback(PluginCall call) {
        JSObject r = permissionResult();
        if (wanted && (fine() || coarse())) {
            main.post(() -> {
                register();
                deliver(lastKnown());
                emitStatus();
            });
        }
        call.resolve(r);
    }

    @PluginMethod
    public void isLocationEnabled(PluginCall call) {
        call.resolve(statusObject());
    }

    @PluginMethod
    public void openLocationSettings(PluginCall call) {
        launch(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS), new Intent(Settings.ACTION_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        launch(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName())), new Intent(Settings.ACTION_SETTINGS));
        call.resolve();
    }

    @PluginMethod
    public void getLastKnown(PluginCall call) {
        Location l = lastKnown();
        JSObject r = new JSObject();
        r.put("fix", l == null ? JSObject.NULL : toJs(l));
        call.resolve(r);
    }

    @PluginMethod
    public void start(PluginCall call) {
        Integer iv = call.getInt("intervalMs", 1000);
        intervalMs = Math.max(500, iv == null ? 1000 : iv);
        if (!(fine() || coarse())) {
            JSObject r = statusObject();
            r.put("started", false);
            r.put("reason", "permission");
            call.resolve(r);
            return;
        }
        main.post(() -> {
            wanted = true;
            hookSystem();
            register();
            JSObject r = statusObject();
            r.put("started", registered);
            if (!registered) r.put("reason", "no_provider");
            call.resolve(r);
            // Instant first position from the cache (JS shows its real age; never presented as live).
            deliver(lastKnown());
            emitStatus();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            wanted = false;
            unregister();
            best = null;
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        wanted = false;
        unregister();
        main.removeCallbacksAndMessages(null);
        if (providersReceiver != null) {
            try {
                getContext().unregisterReceiver(providersReceiver);
            } catch (Exception ignored) {
            }
            providersReceiver = null;
        }
        if (lifecycle != null) {
            try {
                if (getActivity() != null) getActivity().getApplication().unregisterActivityLifecycleCallbacks(lifecycle);
            } catch (Exception ignored) {
            }
            lifecycle = null;
        }
    }
}
