import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';

/**
 * EfficientDet-Lite0 (MediaPipe Tasks Vision, CPU) off the main thread.
 *
 * WASM comes from /mediapipe/wasm, copied from the installed @mediapipe/tasks-vision by
 * scripts/sync-vision-assets.mjs so the glue, the binary and this bundled JS API always match.
 * Release builds run this as a classic worker (MediaPipe loads its glue with importScripts);
 * the Vite dev server runs module workers, which need the ES-module glue instead.
 */
let detector: ObjectDetector | null = null;

function isModuleWorker() {
  try {
    // A classic worker accepts an empty importScripts(); a module worker throws TypeError.
    (self as unknown as { importScripts: (...u: string[]) => void }).importScripts();
    return false;
  } catch {
    return true;
  }
}

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, msgId } = e.data as { type: string; payload: any; msgId: number };
  try {
    if (type === 'INIT') {
      const { modelPath, wasmBase, scoreThreshold, maxResults } = payload as { modelPath: string; wasmBase: string; scoreThreshold: number; maxResults: number };
      const t0 = performance.now();
      const fileset = await FilesetResolver.forVisionTasks(wasmBase, isModuleWorker());
      detector?.close();
      detector = await ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath, delegate: 'CPU' }, // GPU delegate is unreliable in Android WebView workers
        runningMode: 'IMAGE',
        scoreThreshold,
        maxResults,
      });
      post({ type: 'INIT_DONE', msgId, payload: { initMs: performance.now() - t0, loader: fileset.wasmLoaderPath } });
      return;
    }
    if (type === 'DETECT') {
      const bmp = payload.bmp as ImageBitmap;
      try {
        if (!detector) throw new Error('Detector not initialized');
        const t0 = performance.now();
        const results = detector.detect(bmp);
        const latencyMs = performance.now() - t0;
        const { width, height } = bmp;
        // MediaPipe IMAGE mode returns pixel boxes; the rest of the app works in 0..1.
        const observations = (results.detections ?? [])
          .filter((d) => d.boundingBox && d.categories[0])
          .map((d) => {
            const cat = d.categories[0];
            const b = d.boundingBox!;
            const x = Math.max(0, b.originX / width);
            const y = Math.max(0, b.originY / height);
            const w = Math.min(1 - x, b.width / width);
            const h = Math.min(1 - y, b.height / height);
            return { label: cat.categoryName, confidence: cat.score, box: { x, y, w, h }, centerX: x + w / 2, centerY: y + h / 2, bottomCenterX: x + w / 2, bottomCenterY: y + h };
          });
        post({ type: 'DETECT_DONE', msgId, payload: { observations, latencyMs, width, height } });
      } finally {
        bmp.close();
      }
      return;
    }
    if (type === 'CLOSE') {
      detector?.close();
      detector = null;
      post({ type: 'CLOSED', msgId });
    }
  } catch (err) {
    post({ type: 'ERROR', msgId, error: (err as Error)?.message ?? String(err) });
  }
};
