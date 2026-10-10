import { useSession } from './store/session';
import { useUI } from './store/ui';

/**
 * In the live demo both phones run in one page. These tell side effects which
 * "device" they belong to, so the Guardian's phone never speaks the stick
 * user's voice prompts and the stick user's phone never plays the siren.
 */
/**
 * The shipped app is the stick user's app (one user + one stick). Only an explicit guardian role
 * (dev/demo builds) silences the user's voice prompts; an unset role must never mute the user.
 */
export const userSurfaceActive = () =>
  useUI.getState().layout === 'stage' || useSession.getState().entryRole !== 'guardian';

export const guardianSurfaceActive = () =>
  useUI.getState().layout === 'stage' || useSession.getState().entryRole === 'guardian';
