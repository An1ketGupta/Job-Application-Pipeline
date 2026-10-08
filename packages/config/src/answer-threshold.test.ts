import { describe, expect, it } from 'vitest';
import { loadConfig } from './index.js';
describe('candidate confidence configuration', () => {
  it('defaults to Gemini and a 75% threshold and accepts percentage overrides', () => {
    expect(loadConfig({})).toMatchObject({
      ANSWER_PROVIDER: 'GEMINI',
      ANSWER_CONFIDENCE_THRESHOLD_PERCENT: 75,
    });
    expect(
      loadConfig({ ANSWER_CONFIDENCE_THRESHOLD_PERCENT: '90' })
        .ANSWER_CONFIDENCE_THRESHOLD_PERCENT,
    ).toBe(90);
    expect(
      loadConfig({ ANSWER_CONFIDENCE_THRESHOLD_PERCENT: '' })
        .ANSWER_CONFIDENCE_THRESHOLD_PERCENT,
    ).toBe(75);
  });
  it.each(['101', '-1', 'NaN'])('rejects invalid percentage %s', (value) => {
    expect(() =>
      loadConfig({ ANSWER_CONFIDENCE_THRESHOLD_PERCENT: value }),
    ).toThrow('Invalid environment configuration');
  });
});
