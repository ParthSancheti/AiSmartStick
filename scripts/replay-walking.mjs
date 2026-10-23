import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
function option(name, fallback) { const n = args.indexOf(name); return n < 0 ? fallback : args[n + 1]; }
const detectionFile = option('--detections', 'validation/algorithm-video-detections.json');
const outputFile = option('--output', 'validation/algorithm-video-decisions.json');
const scenario = option('--scenario', 'camera-only');
if (!['camera-only', 'injected-sensors'].includes(scenario)) throw new Error('Choose camera-only or injected-sensors');
const coreFile = path.resolve(option('--core', 'deliverables/algorithm-replay/core/walking-core.mjs'));
const { ObjectTracker, SensorConditioningCore, fuseSensors, evaluateWalkingGuidance, GuidanceSpeechPolicy } = await import(pathToFileURL(coreFile));
const detections = JSON.parse(await readFile(detectionFile, 'utf8'));
const tracker = new ObjectTracker();
const sensors = new SensorConditioningCore();
const speech = new GuidanceSpeechPolicy();
const thresholds = { awarenessCm: 150, warningCm: 100, dangerCm: 50 };
const origin = 10_000;
let previous;
const frames = [];
const transitions = [];

/** Test stimuli only, never inferred from the source footage or associated to a camera object. */
function stimulus(timeMs) {
  const t = (timeMs / 1000) % 30;
  if (t < 4) return { range: 350, gyro: 8, phase: 'SIMULATED: fresh distant range' };
  if (t < 8) return { range: 350 - (t - 4) * 65, gyro: 8, phase: 'SIMULATED: shrinking forward beam range' };
  if (t < 10) return { range: 20, gyro: 8, phase: 'SIMULATED: sudden near obstacle' };
  if (t < 13) return { range: null, gyro: 160, phase: 'SIMULATED: no echo during stick sweep' };
  if (t < 17) return { range: 300, gyro: 160, phase: 'SIMULATED: farther range while sweeping; cannot release' };
  if (t < 22) return { range: 300, gyro: 8, phase: 'SIMULATED: stable farther samples; camera still decides independently' };
  if (t < 26) return { range: 300, gyro: 8, gap: true, phase: 'SIMULATED: sensor outage / aging' };
  return { range: 300, gyro: 8, phase: 'SIMULATED: restored sensing' };
}

for (const frame of detections.frames) {
  const now = origin + frame.timeMs;
  const injected = scenario === 'injected-sensors' ? stimulus(frame.timeMs) : null;
  if (injected && !injected.gap) sensors.ingest({
    deviceId: 'SIMULATED-replay', uptimeMs: now,
    ultrasonic: { distanceCm: injected.range, status: injected.range === null ? 'no_echo' : 'ok', sampleAgeMs: 0 },
    imu: { ok: true, ax: 0, ay: 0, az: 1, gx: injected.gyro, gy: 0, gz: 0, pitch: 0, roll: 0 },
  }, now, now);
  const context = sensors.getContext(now, thresholds.warningCm);
  const observations = frame.observations.map(observation => ({ ...observation, timestamp: now }));
  const tracks = tracker.update(observations, now);
  const fusion = fuseSensors(tracks, context, now);
  const snapshot = { timestamp: now, frameTimestamp: now, frameWidth: frame.width, frameHeight: frame.height,
    // Replay samples use a logical clock. Desktop inference timings are recorded separately.
    processingLatencyMs: 0, sensorContext: context, frameSensorContext: context, objects: observations, tracks,
    ...fusion, overallQuality: 'degraded' };
  const guidance = evaluateWalkingGuidance({ context, snapshot, thresholds, linked: true, walking: true,
    sensorRequired: scenario === 'injected-sensors', previous, now });
  const sceneKey = guidance.observedObjects.map(o => o.label + ':' + (guidance.directionsReliable ? o.side : 'UNKNOWN')).sort().join('|');
  const policy = speech.decide(guidance, context, null, sceneKey, now);
  const speechIntent = policy.speak ? guidance.plan + ' (' + guidance.severity + ')' : null;
  if (!previous || previous.plan !== guidance.plan || previous.holdReason !== guidance.holdReason || previous.severity !== guidance.severity) {
    transitions.push({ index: frame.index, timeMs: frame.timeMs, severity: guidance.severity, plan: guidance.plan,
      holdReason: guidance.holdReason, effects: guidance.effects });
  }
  frames.push({ index: frame.index, timeMs: frame.timeMs, sourceTimeMs: frame.sourceTimeMs,
    latencyMs: frame.latencyMs, tracks, ...fusion, guidance, speechIntent,
    sensor: { provenance: injected ? 'SIMULATED' : 'unavailable', rangeCm: context.ultrasonic.value,
      rangeState: context.ultrasonic.state, motion: context.motion, quality: context.quality,
      speedMps: null, phase: injected?.phase ?? 'Actual video only; sonar, IMU and GPS not recorded' } });
  previous = guidance;
}
const percentile = p => { const a = detections.frames.map(f => f.latencyMs).sort((a,b)=>a-b); return a[Math.min(a.length-1,Math.floor(a.length*p))]; };
const summary = { frames: frames.length, observations: detections.frames.reduce((n,f)=>n+f.observations.length,0),
  distinctTrackIds: new Set(frames.flatMap(f=>f.tracks.map(t=>t.trackId))).size,
  heldFrames: frames.filter(f=>f.guidance.routeHold).length,
  speechIntents: frames.filter(f=>f.speechIntent).length, transitions,
  desktopInferenceMs: { median: percentile(.5), p95: percentile(.95) },
  forbiddenFreeClaims: frames.filter(f=>Object.values(f.pathState).includes('FREE')).length,
  cameraObjectsWithInventedRange: frames.flatMap(f=>f.fusedObjects).filter(o=>o.ultrasonicDistanceCm!==null).length };
const output = { metadata: { ...detections.metadata, scenario, sensorProvenance: scenario === 'camera-only' ? 'unavailable' : 'SIMULATED',
  clock: 'Logical capture clock; desktop latency measured separately, not phone latency',
  core: path.basename(coreFile), coreSha256: createHash('sha256').update(await readFile(coreFile)).digest('hex'), thresholds, limitations: [
    'No ground truth object annotations, physical depth, measured free space, GPS, sonar, IMU or mounting calibration in source footage.',
    'Any injected sensor trace is synthetic and independent of camera content.',
    'A release resumes route cue eligibility, never certifies physical clearance.',
  ] }, summary, frames };
await mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
await writeFile(outputFile, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ output: path.resolve(outputFile), ...summary }, null, 2));
