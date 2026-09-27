import { beforeEach, describe, expect, it } from 'vitest';
import { executeAction } from '../src/core/ai/executor';
import { useDevice, initialDevice } from '../src/core/store/device';
import { useSession } from '../src/core/store/session';

const act = (name: string, type: string, args: Record<string, unknown> = {}) => ({ id: 'c1', name, type, arguments: args });

describe('AI tool executor (validation & truthfulness)', () => {
  beforeEach(() => {
    useDevice.setState({ ...initialDevice(), link: 'disconnected', internet: true });
  });

  it('rejects unknown tools and type mismatches', async () => {
    expect((await executeAction(act('launch_rocket', 'x.y'))).ok).toBe(false);
    expect((await executeAction(act('get_battery', 'device.getFirmware'))).ok).toBe(false);
  });

  it('rejects malformed arguments', async () => {
    const r = await executeAction(act('set_assistant_volume', 'audio.setAssistantVolume', { level: 'loud' }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid arguments/);
  });

  it('refuses tools whose requirements are not met (no fake camera)', async () => {
    const r = await executeAction(act('describe_scene', 'vision.describeScene'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/stick is not connected/);
  });

  it('reports device state truthfully (unknown battery stays unknown)', async () => {
    const r = await executeAction(act('get_battery', 'device.getBattery'));
    expect(r.ok).toBe(true);
    expect((r.data as { battery: { estimatePercent: number | null } }).battery.estimatePercent).toBeNull();
  });

  it('never changes SOS/privacy settings by voice; valid settings apply', async () => {
    expect((await executeAction(act('change_setting', 'settings.changeSetting', { key: 'voiceRate', value: '3' }))).ok).toBe(false);
    const ok = await executeAction(act('change_setting', 'settings.changeSetting', { key: 'voiceRate', value: '1.2' }));
    expect(ok.ok).toBe(true);
    expect(useSession.getState().settings.voiceRate).toBe(1.2);
  });

  it('communication requires a linked guardian', async () => {
    useSession.setState({ linked: false });
    const r = await executeAction(act('call_guardian', 'communication.callGuardian'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No guardian/);
  });
});
