import type { LiveStreamState } from '../core/camera/liveStream';

/**
 * Pure text helpers for the stick camera views (LiveCameraView, CameraView). Short, simple
 * English: the stick user may hear these through TalkBack.
 */

/** A frame older than this is "old": the picture is dimmed and the chip says so. */
export const STALE_MS = 3000;

type StreamView = Pick<LiveStreamState, 'status' | 'fps' | 'source' | 'error' | 'frameAt' | 'frameUrl'>;

export type ChipTone = 'live' | 'wait' | 'warn' | 'off';

/** "6 fps", "0.5 fps", or '' when there is no rate yet. */
export function fpsText(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return '';
  return `${fps < 1.5 ? Math.round(fps * 10) / 10 : Math.round(fps)} fps`;
}

/** True when a frame is shown but no new one came for more than STALE_MS. */
export function frameStale(s: Pick<StreamView, 'frameUrl' | 'frameAt'>, now: number): boolean {
  return s.frameUrl != null && s.frameAt != null && now - s.frameAt > STALE_MS;
}

/** Status chip over the picture. */
export function cameraChip(s: StreamView, linked: boolean, now: number): { text: string; tone: ChipTone } {
  if (!linked) return { text: 'Stick not connected', tone: 'off' };
  if (s.status === 'error') return { text: s.error || 'Camera not working', tone: 'warn' };
  if (s.status === 'stalled' || frameStale(s, now)) return { text: 'No new frames', tone: 'warn' };
  if (s.status === 'live') {
    const rate = fpsText(s.fps);
    return { text: `${s.source === 'snapshots' ? 'Snapshots' : 'Live'}${rate ? ` · ${rate}` : ''}`, tone: 'live' };
  }
  if (s.status === 'connecting') return { text: 'Connecting to camera…', tone: 'wait' };
  return { text: 'Camera off', tone: 'off' };
}

/** Big centred message while there is no picture to show. */
export function cameraEmptyText(s: Pick<StreamView, 'status' | 'error'>, linked: boolean): string {
  if (!linked) return 'Connect the stick to see the camera';
  if (s.status === 'error') return s.error || 'The camera is not working right now.';
  if (s.status === 'connecting') return 'Connecting to camera…';
  if (s.status === 'stalled' || s.status === 'live') return 'Waiting for the camera…';
  return 'Camera off';
}

/** One line under the full-screen picture: how the picture arrives, how fast, how big. */
export function streamInfoLine(s: Pick<LiveStreamState, 'status' | 'source' | 'fps' | 'width' | 'height'> & { hasFrame: boolean }, linked: boolean): string {
  if (!linked) return 'Stick not connected';
  if (!s.hasFrame) return s.status === 'connecting' ? 'Connecting to camera…' : 'No picture yet';
  const parts = [s.source === 'snapshots' ? 'Snapshots (one photo at a time)' : s.source === 'stream' ? 'Live video' : 'Camera'];
  const rate = fpsText(s.fps);
  if (rate) parts.push(rate);
  if (s.width && s.height) parts.push(`${s.width}×${s.height}`);
  return parts.join(' · ');
}

/** Simple words for a failed "Describe what the camera sees". */
export function describeErrorText(e: unknown): string {
  const code = typeof e === 'object' && e && 'code' in e ? String((e as { code?: unknown }).code ?? '') : '';
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const raw = `${code} ${msg}`;
  if (/stick-offline|stick is not connected/i.test(raw)) return 'The stick is not connected. Connect it and try again.';
  if (/^\s*camera:|\bcamera\b.*(busy|unavailable|unauthorized)|HTTP \d{3}|\/api\/v1\/capture|no path to the stick|not bound|stick network/i.test(raw)) return 'The stick camera did not answer. Try again.';
  if (/describe-timeout|deadline-exceeded|timed? ?out/i.test(raw)) return 'It took too long. Check the internet and try again.';
  if (/sign in/i.test(raw)) return 'Please sign in again.';
  // Our functions say "Sign in required." themselves; a bare "unauthenticated" is the app check failing.
  if (/unauthenticated|app.?check|permission-denied/i.test(raw)) return 'The server did not accept this app. Try again later.';
  if (/failed-precondition|not configured/i.test(raw)) return 'Picture description is not set up on the server yet.';
  if (/resource-exhausted|too many/i.test(raw)) return 'Too many requests. Wait a moment and try again.';
  if (/unavailable|network|failed to fetch|offline|internal/i.test(raw)) return 'Could not reach the server. Check the internet and try again.';
  return 'Could not describe the picture. Try again.';
}
