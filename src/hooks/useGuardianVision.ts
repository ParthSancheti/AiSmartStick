import { useEffect, type RefObject } from 'react';
import { useVision } from '../core/store/vision';
import { requestSnapshot as guardianRequestSnapshot, stopViewing as guardianStopViewing } from '../core/camera/cameraSession';

/**
 * Renders relayed frames onto a <canvas> without leaking memory:
 * Blob → createImageBitmap → drawImage → bitmap.close(). No object URLs to revoke.
 * Auto-refresh pauses when the tab is hidden and stops when the screen unmounts.
 */
export function useGuardianVision(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const frame = useVision((s) => s.guardianFrame);
  const requesting = useVision((s) => s.requesting);
  const autoRefresh = useVision((s) => s.autoRefresh);
  const error = useVision((s) => s.error);
  const viewing = useVision((s) => s.guardianViewing);

  useEffect(() => {
    if (!frame) return;
    let cancelled = false;
    void (async () => {
      try {
        const bmp = await createImageBitmap(frame.blob);
        try {
          const c = canvasRef.current;
          if (cancelled || !c) return;
          if (c.width !== bmp.width) c.width = bmp.width;
          if (c.height !== bmp.height) c.height = bmp.height;
          c.getContext('2d')?.drawImage(bmp, 0, 0);
        } finally {
          // Canvas/context failures must release the decoded frame too.
          bmp.close();
        }
      } catch {
        if (!cancelled) useVision.setState({ error: 'failed' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [frame, canvasRef]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void guardianRequestSnapshot('snapshot');
    }, 3000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  useEffect(() => () => guardianStopViewing(), []);

  return {
    frame,
    requesting,
    autoRefresh,
    error,
    viewing,
    request: () => guardianRequestSnapshot('snapshot'),
    setAutoRefresh: (on: boolean) => {
      useVision.setState({ autoRefresh: on });
      if (on) void guardianRequestSnapshot('snapshot');
    },
  };
}

/**
 * For local debugging only (phone and stick on the same network): shows the
 * ESP32 MJPEG stream and tears the connection down properly. Browsers keep an
 * MJPEG socket open until src is cleared, so we clear it on unmount.
 */
export function useMjpegStream(imgRef: RefObject<HTMLImageElement | null>, url: string | null) {
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !url) return;
    img.src = url;
    return () => {
      img.src = '';
      img.removeAttribute('src');
    };
  }, [imgRef, url]);
}
