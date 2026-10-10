import { describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/common', () => ({
  CALLABLE: {}, GEMINI_API_KEY: { name: 'GEMINI_API_KEY', value: () => '' },
  GEMINI_LIVE_MODEL: { value: () => '' }, GEMINI_FLASH_MODEL: { value: () => '' },
  GEMINI_VISION_MODEL: { value: () => '' }, db: {}, quota: vi.fn(), requireAuth: vi.fn(), str: vi.fn(),
}));

import { visionSensorEvidenceNote, VISION_TASK_INSTRUCTIONS } from '../functions/src/assistant';
import { functionDeclarations } from '../src/core/ai/tools';

describe('cloud scene evidence boundaries', () => {
  const sensors = { forwardDistanceCm: 118, ultrasonicStatus: 'ok', zone: 'warning', pitchDeg: 0, rollDeg: 0, headingDeg: null, speedMps: null, measuredAt: 1 };

  it('does not put captured numeric sonar range or object identity into the model prompt', () => {
    const note = visionSensorEvidenceNote(sensors);
    expect(note).toContain('unidentified reflection');
    expect(note).toContain('independent timestamps');
    expect(note).toContain('cannot be associated with any camera object');
    expect(note).not.toContain('118');
    expect(note).not.toMatch(/Use it for distance/);
  });

  it.each([
    { forwardDistanceCm: 14_000 }, { forwardDistanceCm: NaN },
    { forwardDistanceCm: 1 }, { ultrasonicStatus: 'no_echo' }, { forwardDistanceCm: null },
  ])('does not promote invalid or missing sonar to measured evidence: %j', override => {
    const note = visionSensorEvidenceNote({ ...sensors, ...override });
    expect(note).toContain('No measured forward range');
    expect(note).toContain('does not establish a clear path');
  });

  it('describes sides as image position and disallows metre/step guesses in existing declarations', () => {
    const task = VISION_TASK_INSTRUCTIONS.describe_scene;
    expect(task).toContain('relative to the image');
    expect(task).toContain('do not measure metres or steps');
    expect(task).not.toMatch(/near <2|2–5/);
    const declaration = functionDeclarations.find(value => value.name === 'describe_scene')!;
    expect(declaration.description).toContain('Never infer metres, step distances, side clearance or a safe path');
  });
});
