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
  MSG,
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
