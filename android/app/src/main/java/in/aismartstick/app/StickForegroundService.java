package in.aismartstick.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground service that keeps the AI Smart Stick app process (and its WebView JS runtime)
 * alive while the screen is off or another app is open, so that:
 *  - the stick link (telemetry polling, button → SOS) keeps running,
 *  - GPS location keeps updating (type "location", only when location permission is granted),
 *  - Firestore sync, SOS and guardian messages keep flowing.
 * Android shows a persistent notification while it runs; the user can stop it in Settings.
 * Service types: connectedDevice (stick over Wi-Fi) + location + microphone (each only when its
 * permission is granted). Android 11+ lets a foreground service use the mic/location while the
 * screen is locked only if it was started with those types while the app was visible, so the types
 * are acquired once from the foreground and the notification text is updated in place afterwards.
 */
public class StickForegroundService extends Service {
    private static final String TAG = "AissForeground";
    public static final String CHANNEL_ID = "background";
    public static final int NOTIFICATION_ID = 4210;
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    public static final String EXTRA_KEEP_AWAKE = "keepAwake";
    private static volatile StickForegroundService activeService;
    static volatile boolean running = false;
    /** Foreground service types actually granted at the last startForeground (0 before Android 10). */
    static volatile int activeTypes = 0;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean walkingOnly;
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        activeService = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Running in background", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps the stick connected and SOS ready while the screen is off");
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    private Notification build(String title, String body) {
        return buildFor(this, title, body);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "start: restart=" + (intent == null) + ", existingTypes=0x" + Integer.toHexString(activeTypes));
        if (intent == null) {
            // The native odometer can restart without a WebView. Guidance/AI cannot, so the
            // notification explicitly distinguishes distance tracking from active protection.
            if (startWalkingOnly()) return START_STICKY;
            Log.w(TAG, "restart: walking unavailable; stopping service");
            showPausedNotice();
            stopSelf();
            return START_NOT_STICKY;
        }
        String title = intent != null && intent.getStringExtra(EXTRA_TITLE) != null ? intent.getStringExtra(EXTRA_TITLE) : "AI Smart Stick";
        String body = intent != null && intent.getStringExtra(EXTRA_BODY) != null ? intent.getStringExtra(EXTRA_BODY) : "Running";
        Notification n = build(title, body);
        if (Build.VERSION.SDK_INT >= 29) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
            boolean loc = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            if (loc) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            boolean mic = Build.VERSION.SDK_INT >= 30 && ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            if (mic) types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            try {
                startForeground(NOTIFICATION_ID, n, types);
                activeTypes = types;
            } catch (RuntimeException e) {
                Log.w(TAG, "foreground types unavailable; retaining connected-device service", e);
                // Android 14+: while-in-use types (location/microphone) cannot be acquired from the
                // background. Keep the stick link alive; the types are re-acquired on the next resume.
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
                activeTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;
            }
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        walkingOnly = false;
        setKeepAwake(intent.getBooleanExtra(EXTRA_KEEP_AWAKE, true));
        running = true;
        NativeWalkingTracker tracker = NativeWalkingTracker.get(this);
        if (Build.VERSION.SDK_INT < 29 || (activeTypes & ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) != 0) tracker.start();
        return tracker.isEnabled() ? START_STICKY : START_NOT_STICKY;
    }

    /** Updates the ongoing notification text without restarting the service (safe from the background). */
    static void updateNotification(Context ctx, String title, String body, boolean keepAwake) {
        StickForegroundService service = activeService;
        // A removed/recreated UI must explicitly promote from the foreground before it
        // can claim guidance/SOS readiness or reacquire its CPU lock again.
        if (service == null) return;
        service.main.post(() -> {
            if (activeService != service || !running || service.walkingOnly) return;
            try {
                ((NotificationManager) service.getSystemService(Context.NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, buildFor(service, title, body));
            } catch (RuntimeException ignored) {}
            service.setKeepAwake(keepAwake);
        });
    }

    /** Native GPS callbacks need no permanent CPU lock; live stick/AI/SOS work does. */
    private void setKeepAwake(boolean keepAwake) {
        if (!keepAwake) {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
            wakeLock = null;
            return;
        }
        if (wakeLock == null) {
            PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (power == null) return;
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "aiss:stick");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire();
    }

    private static Notification buildFor(Context ctx, String title, String body) {
        Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(ctx, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pi)
            .build();
    }

    private void showPausedNotice() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AI Smart Stick stopped")
            .setContentText("The stick is not connected to the app. Tap to resume.")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID + 1, n);
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.i(TAG, "task removed: running=" + running + ", types=0x" + Integer.toHexString(activeTypes));
        uiClosed("task removed");
        super.onTaskRemoved(rootIntent);
    }

    /** Activity finish/Back can destroy Capacitor without removing its task. */
    static void onUiClosed(Context context) {
        StickForegroundService service = activeService;
        if (service == null) {
            Log.i(TAG, "activity finished: no running service to retain");
            // Never start a new background service here: the user's background setting
            // may be off, and while-in-use permissions must be acquired from a visible UI.
            if (!NativeWalkingTracker.get(context).isEnabled()) context.stopService(new Intent(context, StickForegroundService.class));
            return;
        }
        service.main.post(() -> {
            if (activeService == service) service.uiClosed("activity finished");
        });
    }

    private void uiClosed(String reason) {
        setKeepAwake(false);
        if (!NativeWalkingTracker.get(this).isEnabled()) {
            Log.i(TAG, reason + ": tracking disabled; stopping service");
            showPausedNotice();
            stopSelf();
            return;
        }
        // The service owns enabled walking tracking; destroying its WebView must not
        // terminate it. A transient permission/provider problem can recover on reopen.
        if (!startWalkingOnly()) {
            Log.w(TAG, reason + ": retaining service; location tracking needs attention");
            try {
                ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID,
                    build("Walking tracking paused", "Open the app to restore location tracking"));
            } catch (RuntimeException e) { Log.w(TAG, "could not update paused tracking notification", e); }
        }
    }

    private boolean startWalkingOnly() {
        walkingOnly = true;
        NativeWalkingTracker tracker = NativeWalkingTracker.get(this);
        if (!tracker.isEnabled()) { Log.w(TAG, "walking-only: tracking is disabled"); return false; }
        Notification notice = build("Walking distance tracking", "App guidance paused · Tap to reopen");
        try {
            boolean hasLocationService = running && (Build.VERSION.SDK_INT < 29
                || (activeTypes & ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) != 0);
            if (hasLocationService) {
                // The location service was acquired while the activity was visible. Keep
                // that grant when its task disappears; re-promoting from this background
                // callback can fail the while-in-use permission check on recent Android.
                try {
                    ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTIFICATION_ID, notice);
                } catch (RuntimeException e) { Log.w(TAG, "walking-only: could not update notification", e); }
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, notice, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
                activeTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            } else startForeground(NOTIFICATION_ID, notice);
            if (!tracker.start()) { Log.w(TAG, "walking-only: native location listener unavailable"); return false; }
            running = true;
            // Native GPS callbacks do not require the UI's permanent CPU wake lock.
            setKeepAwake(false);
            Log.i(TAG, "walking-only: tracking continues, retainedLocation=" + hasLocationService
                + ", types=0x" + Integer.toHexString(activeTypes));
            return true;
        } catch (RuntimeException e) {
            Log.w(TAG, "walking-only: could not acquire location foreground service", e);
            return false;
        }
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "destroy: walkingOnly=" + walkingOnly + ", types=0x" + Integer.toHexString(activeTypes));
        NativeWalkingTracker.get(this).stop();
        running = false;
        activeTypes = 0;
        walkingOnly = false;
        if (activeService == this) activeService = null;
        main.removeCallbacksAndMessages(null);
        setKeepAwake(false);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
