import { describe, test, expect, beforeEach, vi } from "vitest";

type Perm = {
  state: "granted" | "denied" | "prompt";
  precise: boolean;
  coarse: boolean;
};
const { platform, resumeCbs, native, status, plugin, geo } = vi.hoisted(() => {
  const native = {
    perm: { state: "prompt", precise: false, coarse: false } as Perm,
    /** what the next permission dialog answers */
    answer: { state: "granted", precise: true, coarse: true } as Perm,
    enabled: true,
    lastKnown: null as any,
    listeners: new Map<string, Set<(d: any) => void>>(),
    emit(ev: string, d: any) {
      this.listeners.get(ev)?.forEach((cb) => cb(d));
    },
  };
  const status = () => ({
    enabled: native.enabled,
    gps: native.enabled,
    network: native.enabled,
    providers: ["gps", "network"],
    running: true,
  });
  const plugin = {
    checkPermission: vi.fn(async () => ({ ...native.perm })),
    requestPermission: vi.fn(async () => {
      native.perm = { ...native.answer };
      return { ...native.perm };
    }),
    isLocationEnabled: vi.fn(async () => status()),
    openLocationSettings: vi.fn(async () => undefined),
    openAppSettings: vi.fn(async () => undefined),
    start: vi.fn(async () => ({
      ...status(),
      started: native.perm.state === "granted",
      reason: native.perm.state === "granted" ? undefined : "permission",
    })),
    stop: vi.fn(async () => undefined),
    getLastKnown: vi.fn(async () => ({ fix: native.lastKnown })),
    getCurrent: vi.fn(async () => ({ fix: native.lastKnown, fresh: false, reason: "timeout" })),
    getDiagnostics: vi.fn(async () => ({})),
    addListener: vi.fn(async (ev: string, cb: (d: any) => void) => {
      if (!native.listeners.has(ev)) native.listeners.set(ev, new Set());
      native.listeners.get(ev)!.add(cb);
      return { remove: async () => void native.listeners.get(ev)?.delete(cb) };
    }),
  };
  const geo = {
    watchCb: null as null | ((p: any, err?: any) => void),
    checkPermissions: vi.fn(async () => ({
      location: "prompt",
      coarseLocation: "prompt",
    })),
    requestPermissions: vi.fn(async () => ({
      location: "denied",
      coarseLocation: "granted",
    })),
    watchPosition: vi.fn(async (_o: any, cb: (p: any, err?: any) => void) => {
      geo.watchCb = cb;
      return "w1";
    }),
    clearWatch: vi.fn(async () => undefined),
    getCurrentPosition: vi.fn(async (): Promise<any> => {
      throw new Error("no fix");
    }),
  };
  return {
    platform: { name: "android", hasPlugin: true },
    resumeCbs: [] as (() => void)[],
    native,
    status,
    plugin,
    geo,
  };
});

// ---- Capacitor platform: Android with the AissLocation plugin (toggled per test) ----
vi.mock("@capacitor/core", async (orig) => {
  const actual = await orig<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      getPlatform: () => platform.name,
      isNativePlatform: () => platform.name !== "web",
      isPluginAvailable: (n: string) =>
        n === "AissLocation" && platform.hasPlugin,
    },
  };
});

vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(
      async (_e: string, cb: () => void) => (
        resumeCbs.push(cb), { remove: async () => undefined }
      )
    ),
  },
}));

// ---- Fake native plugin ----
vi.mock("../src/core/native/aissLocation", () => ({ AissLocation: plugin }));

// ---- Capacitor Geolocation (web / fallback) ----
vi.mock("@capacitor/geolocation", () => ({ Geolocation: geo }));

import {
  useLocation,
  startLocation,
  ensureLocation,
  stopLocation,
  onFix,
  locationProblem,
  requestLocationPermission,
  __resetLocationForTests,
  LOCATION_STALE_MS,
  FALLBACK_AFTER_MS,
  WATCHDOG_MS,
  MSG,
  acquireFix,
  acceptFix,
  useLocationDiag,
} from "../src/core/location/locationService";

const nfix = (
  over: Partial<{
    lat: number;
    lng: number;
    accuracy: number;
    time: number;
    provider: string;
  }> = {}
) => ({
  lat: 20.01,
  lng: 73.79,
  accuracy: 8,
  altitude: null,
  speed: 1.1,
  bearing: null,
  time: Date.now(),
  provider: "gps",
  ...over,
});

beforeEach(async () => {
  await __resetLocationForTests();
  platform.name = "android";
  platform.hasPlugin = true;
  native.perm = { state: "prompt", precise: false, coarse: false };
  native.answer = { state: "granted", precise: true, coarse: true };
  native.enabled = true;
  native.lastKnown = null;
  native.listeners.clear();
  resumeCbs.length = 0;
  vi.clearAllMocks();
  plugin.requestPermission.mockImplementation(async () => {
    native.perm = { ...native.answer };
    return { ...native.perm };
  });
  geo.watchCb = null;
  geo.checkPermissions.mockImplementation(async () => ({ location: "prompt", coarseLocation: "prompt" }));
  geo.getCurrentPosition.mockImplementation(async (): Promise<any> => {
    throw new Error("no fix");
  });
});

describe("Android native location (AissLocation)", () => {
  test("asks once, starts LocationManager updates and goes live on the first fix", async () => {
    await startLocation();
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.start).toHaveBeenCalledWith({ intervalMs: 1000 });
    expect(useLocation.getState()).toMatchObject({
      permission: "granted",
      precise: true,
      status: "acquiring",
      source: "android",
    });
    // Google Play Services path is never used on Android.
    expect(geo.watchPosition).not.toHaveBeenCalled();

    const got: any[] = [];
    onFix((f) => got.push(f));
    native.emit("location", nfix());
    expect(useLocation.getState().status).toBe("ok");
    expect(useLocation.getState().fix).toMatchObject({
      lat: 20.01,
      lng: 73.79,
      accuracyM: 8,
    });
    expect(got).toHaveLength(1);
    expect(locationProblem(useLocation.getState())).toBeNull();
  });

  test('"Approximate" (coarse-only) grant counts as granted; poor accuracy, flagged not precise', async () => {
    native.answer = { state: "granted", precise: false, coarse: true };
    await startLocation();
    expect(useLocation.getState()).toMatchObject({
      permission: "granted",
      precise: false,
    });
    expect(plugin.start).toHaveBeenCalled();
    native.emit("location", nfix({ accuracy: 1800, provider: "network" }));
    const s = useLocation.getState();
    expect(s.status).toBe("poor");
    expect(locationProblem(s)).toBeNull();
    expect(locationProblem(s, { wantPrecise: true })?.action).toBe("upgrade");
  });

  test("already-granted permission: no dialog at all", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    await startLocation();
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(plugin.start).toHaveBeenCalled();
  });

  test('"Don\'t ask again" → denied with an Open settings action; no watch started', async () => {
    native.answer = { state: "denied", precise: false, coarse: false };
    await startLocation();
    const s = useLocation.getState();
    expect(s).toMatchObject({
      permission: "denied",
      status: "error",
      reason: "denied",
    });
    expect(plugin.start).not.toHaveBeenCalled();
    expect(locationProblem(s)?.action).toBe("app_settings");
  });

  test("a cancelled dialog (another permission prompt was open) is retried once", async () => {
    let calls = 0;
    plugin.requestPermission.mockImplementation(async () => {
      calls++;
      native.perm =
        calls === 1
          ? { state: "prompt", precise: false, coarse: false }
          : { state: "granted", precise: true, coarse: true };
      return { ...native.perm };
    });
    vi.useFakeTimers();
    const p = startLocation();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();
    expect(calls).toBe(2);
    expect(useLocation.getState().permission).toBe("granted");
    expect(plugin.start).toHaveBeenCalled();
  });

  test('Location switch off → "Turn on" (not "permission denied"); switching on resumes', async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    native.enabled = false;
    await startLocation();
    let s = useLocation.getState();
    expect(s).toMatchObject({
      status: "unavailable",
      reason: "off",
      permission: "granted",
      servicesOn: false,
    });
    expect(locationProblem(s)?.action).toBe("location_settings");
    expect(s.error).toBe(MSG.off);

    native.enabled = true;
    native.emit("status", status());
    s = useLocation.getState();
    expect(s).toMatchObject({
      status: "acquiring",
      reason: null,
      servicesOn: true,
    });
    native.emit("location", nfix());
    expect(useLocation.getState().status).toBe("ok");
  });

  test("provider disabled while walking → off; old cached fix is kept but not live", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    await startLocation();
    native.emit("location", nfix());
    native.enabled = false;
    native.emit("status", status());
    const s = useLocation.getState();
    expect(s.reason).toBe("off");
    expect(s.status).toBe("unavailable");
    expect(s.fix).not.toBeNull();
  });

  test("a cached last-known fix is shown as stale and never fed to navigation", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    await startLocation();
    const got: any[] = [];
    onFix((f) => got.push(f));
    native.emit(
      "location",
      nfix({ time: Date.now() - LOCATION_STALE_MS - 60_000 })
    );
    expect(useLocation.getState().status).toBe("stale");
    expect(useLocation.getState().fix).not.toBeNull();
    expect(got).toHaveLength(0);
  });

  test("concurrent starts (boot + screen + onboarding) start one watch", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    await Promise.all([startLocation(), startLocation(), ensureLocation()]);
    expect(plugin.start).toHaveBeenCalledTimes(1);
  });

  test("permission granted later in Settings is picked up on resume without a new dialog", async () => {
    native.answer = { state: "denied", precise: false, coarse: false };
    await startLocation();
    expect(useLocation.getState().reason).toBe("denied");
    plugin.requestPermission.mockClear();
    // user flips it in app settings and comes back
    native.perm = { state: "granted", precise: true, coarse: true };
    resumeCbs.forEach((cb) => cb());
    await vi.waitFor(() => expect(plugin.start).toHaveBeenCalled());
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(useLocation.getState().permission).toBe("granted");
  });

  test("resume never re-prompts after a dismissed dialog", async () => {
    native.answer = { state: "prompt", precise: false, coarse: false };
    vi.useFakeTimers();
    const p = startLocation();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();
    const asked = plugin.requestPermission.mock.calls.length;
    resumeCbs.forEach((cb) => cb());
    await new Promise((r) => setTimeout(r, 10));
    expect(plugin.requestPermission.mock.calls.length).toBe(asked);
    expect(locationProblem(useLocation.getState())?.action).toBe("request");
  });

  test('explicit "Allow" asks again and starts', async () => {
    native.answer = { state: "prompt", precise: false, coarse: false };
    vi.useFakeTimers();
    const p = startLocation();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    vi.useRealTimers();
    native.answer = { state: "granted", precise: false, coarse: true };
    const r = await requestLocationPermission();
    expect(r).toBe("granted");
    expect(plugin.start).toHaveBeenCalled();
  });

  test("stopLocation (sign-out) stops native updates and forgets the position", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    await startLocation();
    native.emit("location", nfix());
    await stopLocation();
    expect(plugin.stop).toHaveBeenCalled();
    expect(useLocation.getState().fix).toBeNull();
    expect(useLocation.getState().status).toBe("idle");
  });

  test("ignores impossible coordinates (0,0) and out-of-order fixes", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    await startLocation();
    native.emit("location", nfix({ lat: 0, lng: 0 }));
    expect(useLocation.getState().fix).toBeNull();
    const t = Date.now();
    native.emit("location", nfix({ time: t, lat: 1 }));
    native.emit("location", nfix({ time: t - 5000, lat: 2 }));
    expect(useLocation.getState().fix?.lat).toBe(1);
  });
});

describe("fallbacks", () => {
  test("old APK without AissLocation: Capacitor Geolocation, coarse grant accepted", async () => {
    platform.hasPlugin = false;
    await startLocation();
    expect(geo.requestPermissions).toHaveBeenCalled();
    expect(geo.watchPosition).toHaveBeenCalled();
    expect(useLocation.getState().permission).toBe("granted");
    geo.watchCb!({
      coords: {
        latitude: 19,
        longitude: 73,
        accuracy: 12,
        altitude: null,
        speed: null,
        heading: null,
      },
      timestamp: Date.now(),
    });
    expect(useLocation.getState().status).toBe("ok");
  });

  test('old APK, Location switch off: checkPermissions rejects → "off", not "denied"', async () => {
    platform.hasPlugin = false;
    geo.checkPermissions.mockRejectedValueOnce(
      Object.assign(new Error("Location services are not enabled."), {
        code: "OS-PLUG-GLOC-0007",
      })
    );
    await startLocation();
    expect(useLocation.getState()).toMatchObject({
      reason: "off",
      status: "unavailable",
    });
    expect(useLocation.getState().permission).not.toBe("denied");
  });

  test("web: never calls the unimplemented requestPermissions; browser denial → denied", async () => {
    platform.name = "web";
    platform.hasPlugin = false;
    (globalThis as any).navigator ??= {};
    (globalThis as any).navigator.geolocation ??= {};
    await startLocation();
    expect(geo.requestPermissions).not.toHaveBeenCalled();
    expect(geo.watchPosition).toHaveBeenCalled();
    geo.watchCb!(null, { code: 1, message: "User denied Geolocation" });
    expect(useLocation.getState().reason).toBe("denied");
  });
});

describe("robustness: a phone that allows location but delivers nothing", () => {
  const pos = (over: Partial<{ lat: number; acc: number; ts: number }> = {}) => ({
    coords: { latitude: over.lat ?? 19.5, longitude: 73.5, accuracy: over.acc ?? 10, altitude: null, speed: null, heading: null },
    timestamp: over.ts ?? Date.now(),
  });
  beforeEach(() => {
    geo.checkPermissions.mockImplementation(async () => ({ location: "granted", coarseLocation: "granted" }));
    geo.getCurrentPosition.mockImplementation(async () => {
      throw new Error("no fix");
    });
    plugin.start.mockImplementation(async () => ({
      ...status(),
      started: native.perm.state === "granted",
      reason: native.perm.state === "granted" ? undefined : "permission",
    }));
    plugin.getCurrent.mockImplementation(async () => ({ fix: native.lastKnown, fresh: false, reason: "timeout" }));
  });

  test("boot and setup asking at the same time share ONE dialog and both see the grant", async () => {
    let answer!: () => void;
    plugin.requestPermission.mockImplementation(
      () =>
        new Promise((res) => {
          answer = () => {
            native.perm = { state: "granted", precise: true, coarse: true };
            res({ ...native.perm });
          };
        }) as any
    );
    const boot = startLocation();
    await vi.waitFor(() => expect(plugin.requestPermission).toHaveBeenCalledTimes(1));
    const setup = requestLocationPermission();
    await new Promise((r) => setTimeout(r, 5));
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    answer();
    expect(await setup).toBe("granted");
    await boot;
    expect(plugin.start).toHaveBeenCalled();
    expect(useLocation.getState().permission).toBe("granted");
  });

  test("a native start() that never answers falls back to @capacitor/geolocation", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    plugin.start.mockImplementation(() => new Promise(() => undefined) as any);
    vi.useFakeTimers();
    const p = startLocation();
    await vi.advanceTimersByTimeAsync(9000);
    await p;
    vi.useRealTimers();
    expect(geo.watchPosition).toHaveBeenCalled();
    geo.watchCb!(pos());
    expect(useLocation.getState()).toMatchObject({ status: "ok", fixSource: "capacitor" });
  });

  test("a lost permission answer never blocks later callers forever", async () => {
    plugin.requestPermission.mockImplementation(() => new Promise(() => undefined) as any);
    vi.useFakeTimers();
    void startLocation();
    await vi.advanceTimersByTimeAsync(10);
    // The user granted it some other way (another dialog / Settings).
    native.perm = { state: "granted", precise: true, coarse: true };
    const later = ensureLocation({ request: false });
    await vi.advanceTimersByTimeAsync(20_000);
    await later;
    vi.useRealTimers();
    expect(plugin.start).toHaveBeenCalled();
    expect(useLocation.getState().permission).toBe("granted");
  });

  test(`AissLocation silent for ${FALLBACK_AFTER_MS / 1000} s → Play Services + WebView fallbacks; whichever delivers is used`, async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    const web = { watchPosition: vi.fn((ok: (p: any) => void) => ((web as any).cb = ok, 7)), clearWatch: vi.fn() };
    const prev = (globalThis as any).navigator.geolocation;
    Object.defineProperty((globalThis as any).navigator, "geolocation", { value: web, configurable: true });
    try {
      vi.useFakeTimers();
      await startLocation();
      expect(geo.watchPosition).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(FALLBACK_AFTER_MS + 100);
      vi.useRealTimers();
      expect(geo.watchPosition).toHaveBeenCalled();
      expect(web.watchPosition).toHaveBeenCalled();
      expect(useLocationDiag.getState().fallback).toEqual(["capacitor", "webview"]);
      (web as any).cb(pos({ lat: 18.1 }));
      expect(useLocation.getState()).toMatchObject({ status: "ok", fixSource: "webview" });
      expect(useLocation.getState().fix?.lat).toBe(18.1);
      // Native recovers: its fixes are used again.
      native.emit("location", nfix({ lat: 18.2 }));
      expect(useLocation.getState()).toMatchObject({ fixSource: "android" });
      await stopLocation();
      expect(geo.clearWatch).toHaveBeenCalled();
      expect(web.clearWatch).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
      Object.defineProperty((globalThis as any).navigator, "geolocation", { value: prev, configurable: true });
    }
  });

  test("Approximate-only grant: fallbacks never open a permission dialog (no high accuracy, no WebView)", async () => {
    native.perm = { state: "granted", precise: false, coarse: true };
    geo.checkPermissions.mockImplementation(async () => ({ location: "denied", coarseLocation: "granted" }));
    const web = { watchPosition: vi.fn(() => 7), clearWatch: vi.fn() };
    const prev = (globalThis as any).navigator.geolocation;
    Object.defineProperty((globalThis as any).navigator, "geolocation", { value: web, configurable: true });
    try {
      vi.useFakeTimers();
      await startLocation();
      await vi.advanceTimersByTimeAsync(FALLBACK_AFTER_MS + 100);
      vi.useRealTimers();
      expect(geo.watchPosition).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: false }), expect.any(Function));
      expect(web.watchPosition).not.toHaveBeenCalled();
      expect(geo.requestPermissions).not.toHaveBeenCalled();
      await stopLocation();
    } finally {
      vi.useRealTimers();
      Object.defineProperty((globalThis as any).navigator, "geolocation", { value: prev, configurable: true });
    }
  });

  test("no fallback when native delivers in time", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    vi.useFakeTimers();
    await startLocation();
    native.emit("location", nfix());
    await vi.advanceTimersByTimeAsync(FALLBACK_AFTER_MS + 100);
    vi.useRealTimers();
    expect(geo.watchPosition).not.toHaveBeenCalled();
  });

  test("watchdog: permission granted elsewhere without a resume event is picked up", async () => {
    native.answer = { state: "prompt", precise: false, coarse: false };
    vi.useFakeTimers();
    const p = startLocation();
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(plugin.start).not.toHaveBeenCalled();
    native.perm = { state: "granted", precise: true, coarse: true };
    const asked = plugin.requestPermission.mock.calls.length;
    await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 100);
    vi.useRealTimers();
    expect(plugin.start).toHaveBeenCalled();
    expect(plugin.requestPermission.mock.calls.length).toBe(asked); // never a dialog from the watchdog
  });

  test("a fix stamped in the future (wrong GPS clock) does not block later fixes", () => {
    acceptFix({ lat: 10, lng: 10, accuracyM: 5, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() + 3_600_000 }, "capacitor");
    acceptFix({ lat: 11, lng: 10, accuracyM: 5, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() + 10 }, "android");
    expect(useLocation.getState().fix?.lat).toBe(11);
  });

  test("a coarse fix from the other source does not replace a fresh precise one", () => {
    acceptFix({ lat: 10, lng: 10, accuracyM: 5, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() }, "android");
    acceptFix({ lat: 10.01, lng: 10, accuracyM: 900, altitude: null, speedMps: null, headingDeg: null, ts: Date.now() + 1 }, "webview");
    expect(useLocation.getState().fix?.lat).toBe(10);
  });
});

describe("acquireFix (SOS text)", () => {
  test("a recent fix is used at once", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    await startLocation();
    native.emit("location", nfix({ lat: 21 }));
    const r = await acquireFix({ maxAgeMs: 120_000, timeoutMs: 8000 });
    expect(r.fresh).toBe(true);
    expect(r.fix?.lat).toBe(21);
    expect(plugin.getCurrent).not.toHaveBeenCalled();
  });

  test("no fix yet: asks the native one-shot for a fresh one", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    plugin.getCurrent.mockImplementationOnce(async () => ({ fix: nfix({ lat: 22, provider: "network", accuracy: 40 }), fresh: true, reason: "fresh" }));
    const r = await acquireFix({ timeoutMs: 3000 });
    expect(plugin.getCurrent).toHaveBeenCalled();
    expect(r).toMatchObject({ fresh: true });
    expect(r.fix?.lat).toBe(22);
  });

  test("Play Services answers when the native one-shot cannot", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    geo.checkPermissions.mockImplementation(async () => ({ location: "granted", coarseLocation: "granted" }));
    geo.getCurrentPosition.mockImplementationOnce(async () => ({
      coords: { latitude: 23, longitude: 73, accuracy: 15, altitude: null, speed: null, heading: null },
      timestamp: Date.now(),
    }));
    const r = await acquireFix({ timeoutMs: 3000 });
    expect(r.fresh).toBe(true);
    expect(r.fix?.lat).toBe(23);
  });

  test("nothing fresh in time: returns the old position marked not fresh", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    native.lastKnown = nfix({ lat: 24, time: Date.now() - 30 * 60_000 });
    vi.useFakeTimers();
    const p = acquireFix({ maxAgeMs: 120_000, timeoutMs: 8000 });
    await vi.advanceTimersByTimeAsync(8100);
    const r = await p;
    vi.useRealTimers();
    expect(r.fresh).toBe(false);
    expect(r.fix?.lat).toBe(24);
  });

  test("never opens a permission dialog: no grant → @capacitor/geolocation is not asked", async () => {
    vi.useFakeTimers();
    const p = acquireFix({ timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2100);
    await p;
    vi.useRealTimers();
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
    expect(geo.requestPermissions).not.toHaveBeenCalled();
  });

  test("Approximate-only grant: asks without high accuracy (high accuracy would open a dialog)", async () => {
    native.perm = { state: "granted", precise: false, coarse: true };
    geo.checkPermissions.mockImplementation(async () => ({ location: "denied", coarseLocation: "granted" }));
    geo.getCurrentPosition.mockImplementationOnce(async () => ({
      coords: { latitude: 23.5, longitude: 73, accuracy: 1800, altitude: null, speed: null, heading: null },
      timestamp: Date.now(),
    }));
    const r = await acquireFix({ timeoutMs: 3000 });
    expect(geo.getCurrentPosition).toHaveBeenCalledWith(expect.objectContaining({ enableHighAccuracy: false }));
    expect(r.fix?.lat).toBe(23.5);
  });

  test("no position at all → null", async () => {
    native.perm = { state: "granted", precise: true, coarse: true };
    vi.useFakeTimers();
    const p = acquireFix({ timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2100);
    const r = await p;
    vi.useRealTimers();
    expect(r).toEqual({ fix: null, fresh: false });
  });
});
