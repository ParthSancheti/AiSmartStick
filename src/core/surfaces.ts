import { useSession } from './store/session';
import { useUI } from './store/ui';

/**
 * In the live demo both phones run in one page. These tell side effects which
 * "device" they belong to, so the Guardian's phone never speaks the stick
 * user's voice prompts and the stick user's phone never plays the siren.
 */
export const userSurfaceActive = () =>
  useUI.getState().layout === 'stage' || useSession.getState().entryRole === 'user';

export const guardianSurfaceActive = () =>
  useUI.getState().layout === 'stage' || useSession.getState().entryRole === 'guardian';
