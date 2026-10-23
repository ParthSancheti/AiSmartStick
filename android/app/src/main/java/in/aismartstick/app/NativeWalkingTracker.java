package in.aismartstick.app;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArraySet;

/** Service-owned GPS accounting survives WebView destruction; never persists raw GPS coordinates. */
final class NativeWalkingTracker {
    private static NativeWalkingTracker instance;
    static synchronized NativeWalkingTracker get(Context context) {
        if (instance == null) instance = new NativeWalkingTracker(context.getApplicationContext());
        return instance;
    }
    private final Context context;
    private final SharedPreferences prefs;
    private final WalkingAccumulator count = new WalkingAccumulator();
    private String owner = "";
    private boolean enabled;
    private boolean listening;
    private String error;
    private long revision;
    interface Observer { void changed(JSObject state); }
    private final Set<Observer> observers = new CopyOnWriteArraySet<>();
    private final LocationListener listener = new LocationListener() {
        @Override public void onLocationChanged(Location l) { accept(l); }
        @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
        @Override public void onProviderEnabled(String provider) { publish(); }
        @Override public void onProviderDisabled(String provider) { publish(); }
    };

    private NativeWalkingTracker(Context context) {
        this.context = context;
        prefs = context.getSharedPreferences("aiss.walking.native.v1", Context.MODE_PRIVATE);
        try {
            JSONObject saved = new JSONObject(prefs.getString("state", "{}"));
            owner = saved.optString("owner", "");
            enabled = saved.optBoolean("enabled", false);
            count.day = saved.optString("day", "");
            count.distanceM = valid(saved.optDouble("distanceM", 0));
            count.durationS = valid(saved.optDouble("durationS", 0));
            count.sessions = (int) valid(saved.optInt("sessions", 0));
            count.paused = saved.optBoolean("paused", false);
            count.startedAt = saved.optLong("startedAt", 0);
            count.lastMoveAt = saved.optLong("lastMoveAt", 0);
            count.sessionDistanceM = valid(saved.optDouble("sessionDistanceM", 0));
            count.sessionDurationS = valid(saved.optDouble("sessionDurationS", 0));
            count.sessionAccuracySum = valid(saved.optDouble("sessionAccuracySum", 0));
            count.sessionAccuracyN = (int) valid(saved.optInt("sessionAccuracyN", 0));
            count.sessionRejected = (int) valid(saved.optInt("sessionRejected", 0));
            if (owner.isEmpty()) enabled = false;
            if (count.day(today()) | count.expire(System.currentTimeMillis())) save();
        } catch (Exception ignored) { count.day(today()); }
    }

    private static double valid(double value) { return Double.isFinite(value) && value >= 0 ? value : 0; }
    private static String today() { return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date()); }

    synchronized JSObject configure(String uid, JSObject seed) {
        if (!owner.equals(uid)) {
            owner = uid; count.day = ""; count.day(today()); count.paused = false;
            // Upgrade existing JS totals once. Native persisted totals win on every subsequent launch.
            if (seed != null && uid.equals(seed.optString("owner")) && today().equals(seed.optString("day"))) {
                count.distanceM = valid(seed.optDouble("distanceM", 0));
                count.durationS = valid(seed.optDouble("durationS", 0));
                count.sessions = (int) valid(seed.optInt("sessions", 0));
            }
        }
        enabled = !uid.isEmpty();
        save();
        return snapshot();
    }

    synchronized JSObject control(String command, String expectedOwner) {
        // A delayed command from an old account cannot stop or erase a newly signed-in one.
        if (expectedOwner != null && !owner.equals(expectedOwner)) return snapshot();
        long now = System.currentTimeMillis();
        count.day(today());
        if ("pause".equals(command)) { count.paused = true; count.resetAnchor(); }
        if ("resume".equals(command)) {
            count.paused = false; count.resetAnchor();
            if (count.startedAt != 0) count.lastMoveAt = now;
        }
        if ("start".equals(command)) {
            count.paused = false;
            if (count.startedAt == 0) { count.startedAt = now; count.lastMoveAt = now; count.resetAnchor(); }
        }
        if ("end".equals(command)) { count.finish(now); count.paused = false; }
        if ("clear".equals(command)) {
            stop(); enabled = false; owner = ""; count.day = ""; count.day(today()); count.paused = false;
        }
        if ("stop".equals(command)) { stop(); enabled = false; count.resetAnchor(); }
        save();
        publish();
        return snapshot();
    }

    synchronized void accept(Location location) {
        if (!enabled) return;
        long now = System.currentTimeMillis();
        long age = Math.max(0, (SystemClock.elapsedRealtimeNanos() - location.getElapsedRealtimeNanos()) / 1_000_000);
        WalkingAccumulator.Point p = new WalkingAccumulator.Point(location.getLatitude(), location.getLongitude(),
                location.hasAccuracy() ? location.getAccuracy() : 999, location.hasSpeed() ? location.getSpeed() : Double.NaN, now - age);
        if (count.accept(p, today(), now)) { save(); publish(); }
    }

    /** Only called after a location-typed foreground service has successfully started. */
    synchronized boolean start() {
        if (!enabled) return false;
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            stop();
            error = "Precise location is needed to measure walking distance.";
            publish();
            return false;
        }
        if (listening) return true;
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) { error = "Location is unavailable on this phone."; publish(); return false; }
        boolean any = false;
        // The same system GPS source is shared with navigation. No independent network polling or wake lock.
        for (String provider : new String[] { LocationManager.GPS_PROVIDER, "fused" }) {
            try {
                if (lm.getAllProviders().contains(provider)) {
                    lm.requestLocationUpdates(provider, 2000, 0, listener, Looper.getMainLooper());
                    any = true;
                }
            } catch (RuntimeException e) { error = e.getClass().getSimpleName(); }
        }
        listening = any;
        error = any ? null : "No location provider is available for walking distance.";
        publish();
        return listening;
    }

    synchronized void stop() {
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (lm != null) try { lm.removeUpdates(listener); } catch (RuntimeException ignored) {}
        listening = false;
        count.resetAnchor();
        publish();
    }

    synchronized boolean isEnabled() { return enabled; }
    void addObserver(Observer observer) { observers.add(observer); }
    void removeObserver(Observer observer) { observers.remove(observer); }

    private synchronized void publish() {
        if (observers.isEmpty()) return;
        JSObject state = snapshot();
        for (Observer observer : observers) {
            try { observer.changed(state); } catch (RuntimeException ignored) {}
        }
    }

    private boolean providerEnabled() {
        LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return false;
        for (String provider : new String[] { LocationManager.GPS_PROVIDER, "fused" }) {
            try { if (lm.isProviderEnabled(provider)) return true; } catch (RuntimeException ignored) {}
        }
        return false;
    }

    synchronized JSObject snapshot() {
        if (count.day(today()) | count.expire(System.currentTimeMillis())) save();
        JSObject state = new JSObject();
        state.put("revision", ++revision);
        boolean available = !listening || providerEnabled();
        String statusError = !available ? "Location is switched off. Turn it on to measure walking distance." : error;
        state.put("owner", owner); state.put("enabled", enabled); state.put("tracking", listening && available);
        state.put("paused", count.paused); state.put("error", statusError == null ? JSONObject.NULL : statusError);
        JSObject totals = new JSObject();
        totals.put("day", count.day); totals.put("distanceM", count.distanceM);
        totals.put("durationS", count.durationS); totals.put("sessions", count.sessions);
        state.put("today", totals);
        if (count.startedAt != 0) {
            JSObject session = new JSObject();
            session.put("id", "walk_" + count.startedAt); session.put("startTime", count.startedAt);
            session.put("endTime", JSONObject.NULL); session.put("distanceM", count.sessionDistanceM);
            session.put("durationS", count.sessionDurationS); session.put("accSum", count.sessionAccuracySum);
            session.put("accN", count.sessionAccuracyN); session.put("rejected", count.sessionRejected);
            state.put("current", session);
        } else state.put("current", JSONObject.NULL);
        return state;
    }

    private void save() {
        JSObject state = new JSObject();
        state.put("owner", owner); state.put("enabled", enabled); state.put("day", count.day);
        state.put("distanceM", count.distanceM); state.put("durationS", count.durationS); state.put("sessions", count.sessions);
        state.put("paused", count.paused); state.put("startedAt", count.startedAt); state.put("lastMoveAt", count.lastMoveAt);
        state.put("sessionDistanceM", count.sessionDistanceM); state.put("sessionDurationS", count.sessionDurationS);
        state.put("sessionAccuracySum", count.sessionAccuracySum); state.put("sessionAccuracyN", count.sessionAccuracyN);
        state.put("sessionRejected", count.sessionRejected);
        prefs.edit().putString("state", state.toString()).apply();
    }
}
