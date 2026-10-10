// Tests that each tier returns the PRD English text and invalid tiers throw.
import { test, expect } from 'vitest';
import { getAdvisoryText, DISCLAIMER } from '../lib/advisory';
import type { Tier } from '../lib/tiers';

test('each tier returns its English advisory text', () => {
  expect(getAdvisoryText('GREEN')).toBe('Normal activities. No restrictions.');
  expect(getAdvisoryText('YELLOW')).toMatch(/asthma/);
  expect(getAdvisoryText('ORANGE')).toMatch(/Cancel outdoor sports/);
  expect(getAdvisoryText('RED')).toMatch(/All outdoor activity stopped/);
});

test('invalid tier throws', () => {
  expect(() => getAdvisoryText('purple' as never as Tier)).toThrow(/unknown tier/);
});

test('disclaimer exists', () => {
  expect(DISCLAIMER).toMatch(/guidance/);
});
