import type { TelemetryPacket } from '../../../shared/deviceProtocol';
import { SensorConditioningCore } from '../perception/sensorCore';

export * from '../perception/sensorCore';

/** Live application clock adapter; the reusable core receives every timestamp explicitly. */
class SensorConditioningAdapter {
  private core = new SensorConditioningCore();

  public ingest(packet: TelemetryPacket, receivedAt: number) {
    this.core.ingest(packet, receivedAt, Date.now());
  }

  public getContext(warningDistanceCm?: number) {
    return this.core.getContext(Date.now(), warningDistanceCm);
  }

  public reset() { this.core.reset(); }
  public _reset() { this.reset(); }
}

export const sensorConditioning = new SensorConditioningAdapter();

export function getCurrentSensorContext(warningDistanceCm?: number) {
  return sensorConditioning.getContext(warningDistanceCm);
}
