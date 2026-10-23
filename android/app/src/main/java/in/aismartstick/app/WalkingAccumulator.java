package in.aismartstick.app;

/** Pure walking odometer. No UI or Android lifecycle owns the distance. */
final class WalkingAccumulator {
    static final long MAX_GAP_MS = 30_000;
    static final long END_AFTER_MS = 180_000;
    String day = "";
    double distanceM;
    double durationS;
    int sessions;
    boolean paused;
    long startedAt;
    long lastMoveAt;
    double sessionDistanceM;
    double sessionDurationS;
    double sessionAccuracySum;
    int sessionAccuracyN;
    int sessionRejected;
    private Point anchor;
    private long seenAt;

    static final class Point {
        final double lat, lng, accuracy, speed;
        final long time;
        Point(double lat, double lng, double accuracy, double speed, long time) {
            this.lat = lat; this.lng = lng; this.accuracy = accuracy; this.speed = speed; this.time = time;
        }
    }

    boolean day(String today) {
        if (today.equals(day)) return false;
        day = today; distanceM = 0; durationS = 0; sessions = 0;
        startedAt = 0; lastMoveAt = 0; sessionDistanceM = 0; sessionDurationS = 0;
        sessionAccuracySum = 0; sessionAccuracyN = 0; sessionRejected = 0;
        resetAnchor();
        return true;
    }

    void resetAnchor() { anchor = null; seenAt = 0; }

    boolean finish(long now) {
        if (startedAt == 0) return false;
        sessions++;
        startedAt = 0; lastMoveAt = 0; sessionDistanceM = 0; sessionDurationS = 0;
        sessionAccuracySum = 0; sessionAccuracyN = 0; sessionRejected = 0;
        resetAnchor();
        return true;
    }

    boolean expire(long now) {
        return !paused && startedAt != 0 && lastMoveAt != 0 && now - lastMoveAt > END_AFTER_MS && finish(now);
    }

    boolean accept(Point p, String today, long now) {
        boolean changed = day(today) | expire(now);
        if (paused) return changed;
        if (!Double.isFinite(p.lat) || !Double.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180
                || !Double.isFinite(p.accuracy) || p.accuracy <= 0 || p.accuracy > 25
                || p.time > now + 2000 || now - p.time > MAX_GAP_MS || p.time <= 0 || p.time <= seenAt) return changed;
        boolean gap = seenAt != 0 && p.time - seenAt > MAX_GAP_MS;
        seenAt = p.time;
        if (gap || anchor == null) { anchor = p; return changed; }
        // A receiver reporting zero speed must not turn its stationary drift into walked metres.
        if (Double.isFinite(p.speed) && (p.speed < 0.2 || p.speed > 3.5)) { anchor = p; return changed; }
        double distance = metres(anchor, p);
        double seconds = (p.time - anchor.time) / 1000d;
        if (seconds <= 0 || seconds > MAX_GAP_MS / 1000d) { anchor = p; return changed; }
        if (distance < Math.max(3, Math.max(anchor.accuracy, p.accuracy) * 0.5)) return changed;
        double speed = distance / seconds;
        if (speed > 3.5 || speed < 0.2) {
            anchor = p;
            if (startedAt != 0) { sessionRejected++; return true; }
            return changed;
        }
        if (startedAt == 0) {
            startedAt = anchor.time; sessionDistanceM = 0; sessionDurationS = 0;
            sessionAccuracySum = 0; sessionAccuracyN = 0; sessionRejected = 0;
        }
        lastMoveAt = p.time;
        distanceM += distance; durationS += seconds;
        sessionDistanceM += distance; sessionDurationS += seconds;
        sessionAccuracySum += p.accuracy; sessionAccuracyN++;
        anchor = p;
        return true;
    }

    private static double metres(Point a, Point b) {
        double lat = Math.toRadians(b.lat - a.lat), lng = Math.toRadians(b.lng - a.lng);
        double h = Math.sin(lat / 2) * Math.sin(lat / 2)
                + Math.cos(Math.toRadians(a.lat)) * Math.cos(Math.toRadians(b.lat)) * Math.sin(lng / 2) * Math.sin(lng / 2);
        return 6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
    }
}
