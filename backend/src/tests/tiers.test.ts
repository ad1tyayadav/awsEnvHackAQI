// Tests for tier boundaries and the alert dedupe rule.
import { test, expect } from 'vitest';
import { aqiToTier, shouldAlert, isTier, type Tier } from '../lib/tiers';

test('aqiToTier boundaries: 0,50,51,100,101,200,201,300,301,500', () => {
  expect(aqiToTier(0)).toBe('GREEN');
  expect(aqiToTier(50)).toBe('GREEN');
  expect(aqiToTier(51)).toBe('GREEN');
  expect(aqiToTier(100)).toBe('GREEN');
  expect(aqiToTier(101)).toBe('YELLOW');
  expect(aqiToTier(200)).toBe('YELLOW');
  expect(aqiToTier(201)).toBe('ORANGE');
  expect(aqiToTier(300)).toBe('ORANGE');
  expect(aqiToTier(301)).toBe('RED');
  expect(aqiToTier(500)).toBe('RED');
});

test('shouldAlert transitions (dedupe rule, PRD section 6)', () => {
  const cases: [Tier | null, Tier, boolean][] = [
    [null, 'GREEN', false],
    [null, 'ORANGE', true],
    [null, 'RED', true],
    ['GREEN', 'GREEN', false],
    ['GREEN', 'YELLOW', false],
    ['GREEN', 'ORANGE', true],
    ['GREEN', 'RED', true],
    ['YELLOW', 'ORANGE', true],
    ['YELLOW', 'RED', true],
    ['ORANGE', 'ORANGE', false], // same tier: dedupe
    ['ORANGE', 'RED', true], // escalation
    ['RED', 'RED', false], // no repeat
    ['RED', 'ORANGE', false], // recovery, not alert
    ['RED', 'GREEN', false],
  ];
  for (const [prev, next, expected] of cases) {
    expect(shouldAlert(prev, next), `${prev ?? 'null'}->${next}`).toBe(expected);
  }
});

test('isTier accepts exactly the four tiers', () => {
  expect(isTier('GREEN')).toBe(true);
  expect(isTier('RED')).toBe(true);
  expect(isTier('purple')).toBe(false);
  expect(isTier('')).toBe(false);
});

test('aqiToTier rejects out-of-range', () => {
  expect(() => aqiToTier(501)).toThrow(RangeError);
  expect(() => aqiToTier(-1)).toThrow(RangeError);
});
