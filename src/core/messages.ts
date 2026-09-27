import { useSession } from './store/session';
import { useDevice } from './store/device';
import { showUserBanner, toastGuardian } from './store/ui';
import { logEvent } from './store/activity';
import { announce } from './ai/voiceOut';
import { P } from './ai/phrases';
import { earcon } from './feedback/earcons';
import { userSurfaceActive } from './surfaces';

/** Guardian → stick user: a short message read aloud in the user's earbuds. */
export function sendGuardianMessage(text: string): 'spoken' | 'queued' {
  const { guardian, person } = useSession.getState();
  if (!useDevice.getState().internet) {
    toastGuardian(`${person.name}'s phone is offline. It will be read out when it reconnects.`);
    return 'queued';
  }
  if (userSurfaceActive()) earcon('message');
  announce(P.guardianMsg(guardian.heardAs, text));
  showUserBanner({ tone: 'ink', icon: 'message', title: `Message from ${guardian.heardAs}`, body: text }, 7000);
  logEvent({ kind: 'message', severity: 'info', title: `${guardian.heardAs} sent a voice message`, detail: text });
  toastGuardian(`Read out to ${person.name}`);
  return 'spoken';
}
