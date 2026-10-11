// Tests the citizen-facing action plan per tier, and that invalid tiers throw.
import { test, expect } from 'vitest';
import { getAdvisoryText, DISCLAIMER } from '../lib/advisory';
import type { Tier } from '../lib/tiers';

const ALL: Tier[] = ['GREEN', 'YELLOW', 'ORANGE', 'RED'];

test('each tier returns its advisory text', () => {
  expect(getAdvisoryText('GREEN')).toBe('Air is clean. Normal outdoor activity is fine.');
  expect(getAdvisoryText('YELLOW')).toMatch(/asthma/);
  expect(getAdvisoryText('ORANGE')).toMatch(/N95 mask/);
  expect(getAdvisoryText('RED')).toMatch(/Stay indoors/);
});

test('every advisory is citizen wording, not the old school wording', () => {
  // This product is a public air-alert bot: no school instructions, and nothing
  // that reads as medical advice.
  for (const tier of ALL) {
    expect(getAdvisoryText(tier), tier).not.toMatch(/school|classroom|\bPE\b|students|children/i);
  }
});

test('invalid tier throws', () => {
  expect(() => getAdvisoryText('purple' as never as Tier)).toThrow(/unknown tier/);
});

test('disclaimer exists', () => {
  expect(DISCLAIMER).toMatch(/guidance/);
});
