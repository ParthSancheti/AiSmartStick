import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { SensorConditioningCore, ObjectTracker, fuseSensors, evaluateWalkingGuidance } from '../deliverables/algorithm-replay/core/walking-core.mjs';

const thresholds={awarenessCm:150,warningCm:100,dangerCm:50};
const clock=Date.now;
const network=globalThis.fetch;
Date.now=()=>{throw new Error('Algorithm read the system clock');};
globalThis.fetch=()=>{throw new Error('Algorithm attempted network access');};
let checks=0;
try {
  function run() {
    const sensors=new SensorConditioningCore();
    const tracker=new ObjectTracker();
    let previous;
    const decisions=[];
    for(let i=0;i<12;i++) {
      const now=i*250;
      sensors.ingest({deviceId:'example',uptimeMs:now,
        ultrasonic:{distanceCm:i===1?20:300,status:'ok',sampleAgeMs:0},
        imu:{ax:0,ay:0,az:1,gx:0,gy:0,gz:0,pitch:0,roll:0,ok:true},
      },now,now);
      const context=sensors.getContext(now);
      const tracks=tracker.update([],now);
      const fusion=fuseSensors(tracks,context,now);
      const snapshot={timestamp:now,frameTimestamp:now,processingLatencyMs:0,sensorContext:context,frameSensorContext:context,
        objects:[],tracks,...fusion,overallQuality:'good'};
      previous=evaluateWalkingGuidance({context,snapshot,thresholds,linked:true,walking:true,sensorRequired:true,previous,now});
      decisions.push(previous);
    }
    return decisions;
  }
  const a=run(), b=run();
  assert.deepEqual(a,b); checks++;
  assert.deepEqual(JSON.parse(JSON.stringify(a)),a); checks++;
  assert.equal(a[0].frontDistanceCm,300); checks++;
  assert.equal(a[1].severity,'danger'); checks++;
  assert.equal(a[1].routeHold,true); checks++;
  assert.equal(a[2].routeHold,true); checks++;
  assert.equal(a[5].routeHold,false); checks++;
  const before=performance.now();
  for(let n=0;n<1000;n++)run();
  const elapsed=performance.now()-before;
  const result={checks,passed:true,iterations:1000,steps:12000,elapsedDesktopMs:elapsed,
    averageDesktopMsPerStep:elapsed/12000,
    runtime:'Node; Date.now and fetch deliberately throw during execution; no app/device/model runtime',
    caveat:'Desktop microbenchmark excluding inference, transport, decoding, rendering and native effects; not a phone power or latency measurement'};
  await mkdir('validation', { recursive: true });
  await writeFile('validation/algorithm-portable-smoke.json',JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {Date.now=clock;globalThis.fetch=network;}
