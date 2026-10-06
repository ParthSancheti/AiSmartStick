import { ObjectDetector } from '@mediapipe/tasks-vision';

let detector: ObjectDetector | null = null;
let isReady = false;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload, msgId } = e.data;

  try {
    if (type === 'INIT') {
      const { modelPath, scoreThreshold, maxResults } = payload;
      
      // Use local wasm files to avoid CDN dependency.
      // Vite dev server often breaks dynamic imports of Emscripten WASM wrappers by appending ?import.
      // To bypass Vite's interception, we manually fetch the JS wrapper, convert it to a valid ES module,
      // and pass it as a Blob URL to MediaPipe!
      const loaderRes = await fetch('/mediapipe/wasm/vision_wasm_internal.js');
      const loaderText = await loaderRes.text();
      // Ensure it exports ModuleFactory so dynamic import() succeeds natively
      const loaderEsText = loaderText + '\nexport default ModuleFactory;';
      const loaderBlob = new Blob([loaderEsText], { type: 'application/javascript' });
      const loaderUrl = URL.createObjectURL(loaderBlob);

      const vision = {
        wasmLoaderPath: loaderUrl,
        wasmBinaryPath: '/mediapipe/wasm/vision_wasm_internal.wasm'
      };
      
      detector = await ObjectDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: modelPath,
          delegate: 'CPU' // GPU delegate is often flaky in WebWorkers/Android WebView
        },
        runningMode: 'IMAGE',
        scoreThreshold,
        maxResults,
      });
      
      isReady = true;
      self.postMessage({ type: 'INIT_DONE', msgId });
    }
    else if (type === 'DETECT') {
      if (!isReady || !detector) {
        throw new Error('Detector not initialized');
      }
      
      const bmp: ImageBitmap = payload.bmp;
      const t0 = performance.now();
      const results = detector.detect(bmp);
      const t1 = performance.now();
      
      // We must map mediapipe results to our standard ObjectObservation array format
      // Note: Mediapipe bounding boxes are relative to image dimensions OR absolute pixels depending on runningMode 'IMAGE'.
      // Usually they are absolute pixels. Let's normalize them to 0..1
      
      const width = bmp.width;
      const height = bmp.height;
      
      const observations = (results.detections || []).map(d => {
        const cat = d.categories[0];
        const box = d.boundingBox!;
        // normalize
        const nx = box.originX / width;
        const ny = box.originY / height;
        const nw = box.width / width;
        const nh = box.height / height;
        
        return {
          label: cat.categoryName,
          confidence: cat.score,
          box: { x: nx, y: ny, w: nw, h: nh },
          centerX: nx + nw / 2,
          centerY: ny + nh / 2,
          bottomCenterX: nx + nw / 2,
          bottomCenterY: ny + nh
        };
      });
      
      bmp.close(); // free memory
      
      self.postMessage({ 
        type: 'DETECT_DONE', 
        msgId, 
        payload: { observations, latencyMs: t1 - t0 } 
      });
    }
  } catch (err: any) {
    self.postMessage({ type: 'ERROR', msgId, error: err.message });
  }
};
