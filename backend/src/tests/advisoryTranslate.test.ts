// Tests for bilingual advisory: cache hit, cache miss -> translate -> store, Translate failure -> English.
import { test, expect, beforeEach, vi } from 'vitest';

const sendMock = vi.hoisted(() => vi.fn());

// mock BOTH dynamodb (cache) and translate
vi.mock('@aws-sdk/client-translate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-translate')>();
  return {
    ...actual,
    TranslateClient: vi.fn(() => ({ send: sendMock })),
  };
});

vi.mock('@aws-sdk/lib-dynamodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/lib-dynamodb')>();
  return {
    ...actual,
    DynamoDBDocumentClient: {
      ...actual.DynamoDBDocumentClient,
      from: vi.fn(() => ({ send: sendMock })),
    },
  };
});

// in-memory cache keyed by advisory key
const mem: Record<string, string> = {};

beforeEach(() => {
  sendMock.mockReset();
  for (const k of Object.keys(mem)) delete mem[k];
  (global as Record<string, unknown>).__ADVISORY_MEM__ = mem;
  process.env.ADVISORY_TABLE = 'advisory-test';
});

// we also mock ../lib/db.ts to use the in-memory map instead of real commands
vi.doMock('../lib/db', () => ({
  getAdvisoryCached: (key: string) => Promise.resolve(mem[key] ?? null),
  putAdvisoryCached: (key: string, text: string) => { mem[key] = text; return Promise.resolve(); },
  putReading: () => Promise.resolve(),
  updateSchoolLastAlertTier: () => Promise.resolve(),
  putAlertRow: () => Promise.resolve(),
  getSchool: () => Promise.resolve(null),
  getAllSchools: () => Promise.resolve([]),
  getRecentReadings: () => Promise.resolve([]),
}));

const { getAdvisory, setTranslateApiForTesting } = await import('../lib/advisoryI18n');

test('cache miss translates, stores in cache, second call reads cache', async () => {
  const enText = 'Cancel outdoor sports and assemblies. Keep classroom windows closed.';
  const translator = vi.fn().mockResolvedValue('बाहरी खेल रद्द करें।');
  setTranslateApiForTesting(translator);

  const first = await getAdvisory('hi', 'ORANGE');
  expect(first).toBe('बाहरी खेल रद्द करें।');
  expect(translator).toHaveBeenCalledTimes(1);
  expect(mem['ORANGE#hi']).toBe('बाहरी खेल रद्द करें।');

  const second = await getAdvisory('hi', 'ORANGE');
  expect(second).toBe('बाहरी खेल रद्द करें।');
  expect(translator).toHaveBeenCalledTimes(1); // cache hit, no second translate
});

test('translate failure falls back to English', async () => {
  setTranslateApiForTesting(vi.fn().mockRejectedValue(new Error('service unavailable')));
  const text = await getAdvisory('hi', 'RED');
  expect(text).toBe('All outdoor activity stopped. Keep everyone indoors with windows closed. N95 masks for travel to and from school. Parents are advised to keep children at home if possible. Follow any official order from the local education authority.');
});

test('en always returns code text, never touches translate', async () => {
  const translator = vi.fn();
  setTranslateApiForTesting(translator);
  expect(await getAdvisory('en', 'GREEN')).toBe('Normal activities. No restrictions.');
  expect(translator).not.toHaveBeenCalled();
});
