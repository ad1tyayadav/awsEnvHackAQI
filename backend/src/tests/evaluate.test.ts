// Integration-style test of the shared evaluate path with everything mocked.
import { test, expect, vi, beforeEach } from 'vitest';

const publishMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

beforeEach(() => {
  publishMock.mockClear();
});

const dbMock = vi.hoisted(() => ({
  putReading: vi.fn().mockResolvedValue(undefined),
  updateSchoolLastAlertTier: vi.fn().mockResolvedValue(undefined),
  putAlertRow: vi.fn().mockResolvedValue(undefined),
  getAdvisoryCached: vi.fn().mockResolvedValue(null),
  putAdvisoryCached: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/db', () => dbMock);

// advisory I18n: hi always returns cached English for test simplicity
vi.doMock('../lib/advisoryI18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/advisoryI18n')>();
  return {
    ...actual,
    getAdvisory: async (lang: 'en' | 'hi', tier: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED') =>
      lang === 'en' ? actual.getAdvisory('en', tier) : `[HI] ${actual.getAdvisory('en', tier)}`,
  };
});

const { evaluateSchool } = await import('../lib/evaluate');
const school = {
  schoolId: 's1', name: 'Test School', city: 'Delhi', lat: 28.6, lng: 77.2, lastAlertTier: null as string | null,
};
const ts = new Date().toISOString();

test('RED escalation: publishes alert, writes alert row, updates lastAlertTier', async () => {
  const r = await evaluateSchool(school, 180, 'simulated', undefined, ts, publishMock);
  expect(r.tier).toBe('RED');
  expect(r.aqi).toBeGreaterThan(300);
  expect(r.alertSent).toBe(true);
  expect(publishMock).toHaveBeenCalledTimes(1);
  expect(dbMock.putAlertRow).toHaveBeenCalledTimes(1);
  expect(dbMock.updateSchoolLastAlertTier).toHaveBeenCalledWith('s1', 'RED');
  expect(dbMock.putReading).toHaveBeenCalledTimes(1);
});

test('same-tier RED again: no second alert, but lastAlertTier still updated', async () => {
  const r = await evaluateSchool({ ...school, lastAlertTier: 'RED' }, 180, 'openaq', 'st', ts, publishMock);
  expect(r.alertSent).toBe(false);
  expect(publishMock).not.toHaveBeenCalled();
  expect(dbMock.updateSchoolLastAlertTier).toHaveBeenCalledWith('s1', 'RED');
});

test('GREEN from RED: no alert, tier updates to GREEN', async () => {
  const r = await evaluateSchool({ ...school, lastAlertTier: 'RED' }, 20, 'openaq', 'st', ts, publishMock);
  expect(r.tier).toBe('GREEN');
  expect(r.alertSent).toBe(false);
  expect(dbMock.updateSchoolLastAlertTier).toHaveBeenCalledWith('s1', 'GREEN');
});
