import { useEffect, useRef } from 'react';
import type { VisionFrame } from '../core/types';

/** Draws one camera frame without object URLs (Blob → ImageBitmap → canvas → close). */
export function FrameCanvas({ frame, className, label }: { frame: VisionFrame | null; className?: string; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!frame) return;
    let cancelled = false;
    void createImageBitmap(frame.blob).then((bmp) => {
      const c = ref.current;
      if (cancelled || !c) return bmp.close();
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d')?.drawImage(bmp, 0, 0);
      bmp.close();
    });
    return () => {
      cancelled = true;
    };
  }, [frame]);
  return <canvas ref={ref} className={className} role="img" aria-label={label} />;
}
