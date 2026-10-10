import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const [beforeRoot, afterRoot = '.'] = process.argv.slice(2);
if (!beforeRoot) {
  console.error('Usage: node validation/pcm-allocation-check.mjs <original-project-root> [refined-project-root]');
  process.exit(2);
}

function measure(path) {
  const source = readFileSync(path, 'utf8');
  const start = source.indexOf('export function playPcmChunk');
  const end = source.indexOf('/** Stops the Live voice', start);
  const body = source.slice(start, end).replace('export function', 'function').replace('base64: string', 'base64').replaceAll('liveGain!', 'liveGain');
  const counts = { chunks: 0, samplesPerChunk: 2400, temporaryPcmBytes: 0, playbackPcmBytes: 0, samplesCopied: 0, sourceDisconnects: 0 };
  let latest;
  const ctx = {
    currentTime: 1,
    createBuffer(_channels, len, rate) {
      const data = new Float32Array(len);
      counts.playbackPcmBytes += data.byteLength;
      data.set = (values) => {
        counts.samplesCopied += values.length;
        Float32Array.prototype.set.call(data, values);
      };
      return { duration: len / rate, getChannelData: () => data };
    },
    createBufferSource() {
      latest = { connect() {}, disconnect() { counts.sourceDisconnects++; }, start() {}, stop() {}, buffer: null, onended: null };
      return latest;
    },
  };
  const countedFloatArray = new Proxy(Float32Array, {
    construct(target, args) {
      const value = new target(...args);
      counts.temporaryPcmBytes += value.byteLength;
      return value;
    },
  });
  const play = new Function('Float32Array', 'getAudioCtx', 'getSettings', 'atob', `
    const current = null;
    const RANK = { high: 5 };
    const liveGain = { gain: { value: 1 } };
    const volume = () => 1;
    let pcmStartTime = 0;
    const liveSources = new Set();
    ${body}
    return playPcmChunk;
  `)(countedFloatArray, () => ctx, () => ({ voiceOut: true }), atob);
  const payload = Buffer.alloc(counts.samplesPerChunk * 2, 0x55).toString('base64');
  for (let i = 0; i < 1000; i++) {
    play(payload, 24000);
    counts.chunks++;
    latest.onended();
  }
  return counts;
}
console.log(JSON.stringify({
  method: 'Execute unchanged PCM decoding bodies from baseline and refinement with counted Float32Array construction and fake Web Audio buffers; 1000 completed 100 ms mono 24 kHz chunks. Host synthetic allocation/resource counts only, no device battery or latency measurement.',
  before: measure(join(resolve(beforeRoot), 'src/core/audio/audioManager.ts')),
  after: measure(join(resolve(afterRoot), 'src/core/audio/audioManager.ts')),
}, null, 2));
