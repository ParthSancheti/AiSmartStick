package in.aismartstick.app;

/** Standalone regression harness: run with node scripts/test-walking-native.mjs. */
public final class WalkingAccumulatorTest {
    private static final long T = 1_760_000_000_000L;
    private static final String DAY = "2026-10-18";
    private static int passed;

    private static WalkingAccumulator.Point point(double metres, long seconds, double accuracy, double speed) {
        return new WalkingAccumulator.Point(18.52 + metres / 111_320, 73.85, accuracy, speed, T + seconds * 1000);
    }
    private static void fix(WalkingAccumulator count, double metres, long seconds) {
        count.accept(point(metres, seconds, 5, Double.NaN), DAY, T + seconds * 1000);
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    private static void near(double actual, double expected, double tolerance, String message) {
        check(Math.abs(actual - expected) <= tolerance, message + ": " + actual + " != " + expected);
    }
    private static void test(String name, Runnable body) {
        body.run(); passed++; System.out.println("PASS " + name);
    }

    public static void main(String[] args) {
        test("stationary jitter accumulates against a stable anchor", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 1, 10); fix(count, -1, 20); fix(count, 0.5, 30);
            near(count.distanceM, 0, 0, "Stationary drift became distance");
        });
        test("real movement and measurement duration accumulate once", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10); fix(count, 24, 20);
            near(count.distanceM, 24, 0.1, "Walking distance");
            near(count.durationS, 20, 0, "Active walking duration");
            check(count.sessionAccuracyN == 2 && count.sessionAccuracySum == 10, "Accuracy statistics missing");
        });
        test("slow walking is retained after enough displacement", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            for (int i = 0; i <= 12; i++) fix(count, i * 1.5, i * 5);
            near(count.distanceM, 18, 0.2, "Slow 0.3 m/s walking");
        });
        test("duplicate providers and out of order updates cannot add distance", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10);
            double before = count.distanceM;
            fix(count, 24, 10); fix(count, 100, 5);
            near(count.distanceM, before, 0, "Duplicate/outdated location was counted");
            fix(count, 24, 20);
            near(count.distanceM, 24, 0.1, "Outdated fix moved the anchor");
        });
        test("poor GPS, invalid coordinates, old cache and future cache are rejected", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0);
            count.accept(point(12, 10, 26, 1.2), DAY, T + 10_000);
            count.accept(new WalkingAccumulator.Point(Double.NaN, 73.85, 5, 1, T + 11_000), DAY, T + 11_000);
            count.accept(new WalkingAccumulator.Point(91, 73.85, 5, 1, T + 12_000), DAY, T + 12_000);
            count.accept(point(100, 13, 0, 1), DAY, T + 13_000);
            count.accept(point(100, 14, 5, 1), DAY, T + 60_000);
            count.accept(point(100, 80, 5, 1), DAY, T + 60_000);
            near(count.distanceM, 0, 0, "Unusable GPS was counted");
        });
        test("an unobserved interval is never bridged", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10);
            double before = count.distanceM;
            fix(count, 500, 60);
            near(count.distanceM, before, 0, "Signal loss became a straight-line walk");
            fix(count, 512, 70);
            near(count.distanceM, before + 12, 0.1, "Walking did not resume after gap");
        });
        test("a process restart restores totals without restoring a GPS anchor", () -> {
            WalkingAccumulator original = new WalkingAccumulator();
            fix(original, 0, 0); fix(original, 12, 10);
            WalkingAccumulator restored = new WalkingAccumulator();
            restored.day = original.day; restored.distanceM = original.distanceM; restored.durationS = original.durationS;
            restored.startedAt = original.startedAt; restored.lastMoveAt = original.lastMoveAt;
            restored.sessionDistanceM = original.sessionDistanceM; restored.sessionDurationS = original.sessionDurationS;
            fix(restored, 1000, 20);
            near(restored.distanceM, original.distanceM, 0, "Restart invented a GPS bridge");
            fix(restored, 1012, 30);
            near(restored.distanceM, original.distanceM + 12, 0.1, "Restored tracker did not continue");
        });
        test("vehicle speed and impossible GPS jumps do not count", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10);
            double before = count.distanceM;
            count.accept(point(24, 20, 5, 12), DAY, T + 20_000);
            fix(count, 1000, 30);
            near(count.distanceM, before, 0, "Vehicle/jump became distance");
            check(count.sessionRejected == 1, "Jump rejection statistics missing");
        });
        test("reported stationary speed suppresses larger GPS drift", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0);
            for (int i = 1; i <= 20; i++) count.accept(point(i * 5, i * 10, 5, 0), DAY, T + i * 10_000);
            near(count.distanceM, 0, 0, "Stationary reported speed was ignored");
        });
        test("pause preserves a session and excludes paused movement", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10);
            count.paused = true; count.resetAnchor();
            fix(count, 500, 600);
            check(count.startedAt != 0 && count.sessions == 0, "Paused session expired");
            count.paused = false; count.lastMoveAt = T + 600_000; count.resetAnchor();
            fix(count, 500, 600); fix(count, 512, 610);
            near(count.distanceM, 24, 0.1, "Paused interval was counted");
        });
        test("idle sessions end exactly once with totals unchanged", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10);
            check(!count.expire(T + 190_000), "Session expired before the three minute boundary");
            check(count.expire(T + 190_001), "Idle session did not end");
            check(!count.expire(T + 500_000) && count.sessions == 1, "Session ended twice");
            near(count.distanceM, 12, 0.1, "Ending lost total distance");
        });
        test("midnight resets daily totals and the pre-midnight anchor", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10);
            count.accept(point(500, 20, 5, 1), "2026-10-19", T + 20_000);
            near(count.distanceM, 0, 0, "Yesterday leaked into today");
            check(count.startedAt == 0 && count.sessions == 0, "Yesterday's session leaked into today");
            count.accept(point(512, 30, 5, 1), "2026-10-19", T + 30_000);
            near(count.distanceM, 12, 0.1, "New day did not start counting");
        });
        test("stopping and restarting listeners never bridges the disabled interval", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10);
            count.resetAnchor();
            fix(count, 500, 20); fix(count, 512, 30);
            near(count.distanceM, 24, 0.1, "Stopped listener bridged the disabled interval");
        });
        test("an ended walk cannot donate its anchor to the next session", () -> {
            WalkingAccumulator count = new WalkingAccumulator();
            fix(count, 0, 0); fix(count, 12, 10); count.finish(T + 10_000);
            fix(count, 100, 20);
            near(count.distanceM, 12, 0.1, "New session counted from an ended session");
            fix(count, 112, 30);
            near(count.distanceM, 24, 0.1, "New session failed to start");
            check(count.sessions == 1 && count.startedAt == T + 20_000, "Session identity is wrong");
        });
        System.out.println("Native walking regressions: " + passed + " passed");
    }
}
