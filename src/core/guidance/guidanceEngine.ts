import { visionEngine } from '../vision/visionLoop';
import { earcon } from '../feedback/earcons';
import { haptics } from '../feedback/haptics';
import type { DetectionSnapshot } from '../vision/types';

export class GuidanceEngine {
  private lastAlertTime = 0;
  private isStarted = false;
  
  // Throttle alerts so we don't bombard the user
  private ALERT_COOLDOWN_MS = 2500;
  private WARNING_COOLDOWN_MS = 3500;

  public start() {
    if (this.isStarted) return;
    this.isStarted = true;
    visionEngine.onSnapshot = (s) => this.processSnapshot(s);
  }

  public stop() {
    this.isStarted = false;
    visionEngine.onSnapshot = null;
  }

  private processSnapshot(s: DetectionSnapshot) {
    if (!this.isStarted) return;
    const now = Date.now();
    
    // Evaluate immediate hazards
    let hasDanger = false;
    let hasWarning = false;
    
    for (const obj of s.fusedObjects) {
      if (obj.hazardLevel === 'danger') hasDanger = true;
      if (obj.hazardLevel === 'warning') hasWarning = true;
    }
    
    // If center path is strictly blocked but no visual object claims it (sonar only)
    if (s.pathState.center === 'BLOCKED' && s.fusedObjects.length === 0) {
      // Ultrasonic says something is right in front of us
      hasDanger = true;
    }

    if (hasDanger && now - this.lastAlertTime > this.ALERT_COOLDOWN_MS) {
      earcon('alert');
      haptics.play('error');
      this.lastAlertTime = now;
    } else if (hasWarning && now - this.lastAlertTime > this.WARNING_COOLDOWN_MS) {
      earcon('warning');
      haptics.play('warning');
      this.lastAlertTime = now;
    }
  }
}

export const guidanceEngine = new GuidanceEngine();
