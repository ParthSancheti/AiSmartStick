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
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Foreground service that keeps the AI Smart Stick app process (and its WebView JS runtime)
 * alive while the screen is off or another app is open, so that:
 *  - the stick link (telemetry polling, button → SOS) keeps running,
 *  - GPS location keeps updating (type "location", only when location permission is granted),
 *  - Firestore sync, SOS and guardian messages keep flowing.
 * Android shows a persistent notification while it runs; the user can stop it in Settings.
 * Service types: connectedDevice (stick over Wi-Fi) + location (when permitted). Android 14+ rules apply.
 */
public class StickForegroundService extends Service {
    public static final String CHANNEL_ID = "background";
    public static final int NOTIFICATION_ID = 4210;
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";
    static volatile boolean running = false;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Running in background", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Keeps the stick connected and SOS ready while the screen is off");
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
    }

    private Notification build(String title, String body) {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(pi)
            .build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // Restarted by Android after the app process died: the stick link lives in the app's
            // JS runtime, which is NOT running now. Be truthful: tell the user protection is paused.
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
            startForeground(NOTIFICATION_ID, n, types);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        if (wakeLock == null) {
            // Partial wake lock: CPU stays on for stick polling; the screen may turn off.
            wakeLock = ((PowerManager) getSystemService(Context.POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "aiss:stick");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire();
        }
        running = true;
        // NOT_STICKY: never let Android revive a notification that claims protection without the app.
        return START_NOT_STICKY;
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
        // User swiped the app away: the JS runtime goes with it, so stop claiming to run.
        showPausedNotice();
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
