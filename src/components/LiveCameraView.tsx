import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLiveStreamHold } from '../core/camera/liveStream';
import { useDevice, isLinked } from '../core/store/device';
import { useNow } from '../hooks/useNow';
import { cameraChip, cameraEmptyText, frameStale, type ChipTone } from './liveCameraText';

/** True while any part of the element is on screen. Without IntersectionObserver: always true. */
function useOnScreen(ref: RefObject<Element | null>): boolean {
  const supported = typeof IntersectionObserver !== 'undefined';
  // With an observer, start "off" and let its first report (right after observe) switch it on, so an
  // element mounted off-screen never opens the stream for a moment.
  const [on, setOn] = useState(!supported);
  useEffect(() => {
    const el = ref.current;
    if (!el || !supported) return;
    const io = new IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      if (e) setOn(e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, supported]);
  return on;
}

const DOT: Record<ChipTone, string> = { live: 'bg-ok', wait: 'bg-amber', warn: 'bg-amber', off: 'bg-white/50' };

export interface LiveCameraViewProps {
  /** false pauses the stream for this view (e.g. its page is covered). It also pauses off screen. */
  active?: boolean;
  /** Home preview: 16:9, cropped to fill, no overlays, hidden from screen readers (its button has the label). */
  compact?: boolean;
  /** Accessible name of the picture (full-size view only). */
  label?: string;
  className?: string;
  /** Overlay layer drawn over the picture (detection boxes), in the picture's own 0..1 coordinates. */
  children?: ReactNode;
}

/**
 * The stick camera, live: newest MJPEG frame (or snapshot) from core/camera/liveStream.ts with a
 * status chip. It holds the stream only while it is on screen and `active`; the stream hook itself
 * pauses while the app is in the background. Spans only, so it can sit inside a button.
 * Nothing here speaks or is a live region; the accessible name changes only with the state, not per frame.
 */
export function LiveCameraView({ active = true, compact = false, label = 'Live picture from the stick camera', className = '', children }: LiveCameraViewProps) {
  const root = useRef<HTMLSpanElement>(null);
  const onScreen = useOnScreen(root);
  const s = useLiveStreamHold(active && onScreen);
  const linked = useDevice((d) => isLinked(d.link));
  const now = useNow(1000);
  const chip = cameraChip(s, linked, now);
  const stale = frameStale(s, now);
  const frame = linked ? s.frameUrl : null;
  // Full size: the box takes the frame's own shape, so overlay boxes line up exactly.
  const aspect = compact ? 16 / 9 : s.width && s.height ? s.width / s.height : 4 / 3;
  const waiting = linked && !frame && (s.status === 'connecting' || s.status === 'live' || s.status === 'stalled');

  return (
    <span
      ref={root}
      className={`relative block w-full overflow-hidden bg-black ring-1 ring-line ${compact ? 'rounded-[20px]' : 'rounded-[24px]'} ${className}`}
      style={{ aspectRatio: aspect }}
      {...(compact ? { 'aria-hidden': true } : { role: 'img', 'aria-label': `${label}. ${frame ? (stale ? 'No new frames' : 'Picture is showing') : cameraEmptyText(s, linked)}` })}
    >
      {frame && (
        <img
          src={frame}
          alt=""
          draggable={false}
          className={`absolute inset-0 h-full w-full select-none ${compact ? 'object-cover' : 'object-contain'} transition-opacity duration-300 ${stale ? 'opacity-40 grayscale' : ''}`}
        />
      )}
      {frame && !compact && children ? <span className="absolute inset-0 block">{children}</span> : null}
      {!frame && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          {waiting && <span className="block h-7 w-7 animate-spin rounded-full border-[3px] border-white/25 border-t-white/80" />}
          <span className={`block break-words font-semibold text-white/75 ${compact ? 'line-clamp-3 text-[14px]' : 'text-[15.5px]'}`}>{cameraEmptyText(s, linked)}</span>
        </span>
      )}
      {frame && (
        <span className="absolute left-2.5 top-2.5 flex max-w-[calc(100%-1.25rem)] items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[12px] font-bold text-white">
          <span className={`block h-2 w-2 shrink-0 rounded-full ${DOT[chip.tone]} ${chip.tone === 'live' && !stale ? 'animate-pulse motion-reduce:animate-none' : ''}`} />
          <span className="block min-w-0 truncate">{chip.text}</span>
        </span>
      )}
    </span>
  );
}
