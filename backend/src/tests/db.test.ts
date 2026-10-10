// Unit tests for db.ts. AWS SDK is mocked with vi.mock - no real AWS calls ever happen.
import { test, expect, beforeEach, vi } from 'vitest';

beforeEach(() => {
  sendMock.mockReset();
  process.env.SCHOOLS_TABLE = 'schools-test';
  process.env.READINGS_TABLE = 'readings-test';
  process.env.ADVISORY_TABLE = 'advisory-test';
  process.env.ALERTS_TABLE = 'alerts-test';
});

// hoisted mock state, so vi.mock factory can reference it before imports run
const sendMock = vi.hoisted(() => vi.fn());

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

// import AFTER mocks are installed so db.ts picks up the mocked client
const { putReading, getRecentReadings, putSchool, getSchool, getAllSchools } = await import('../lib/db');

test('putReading writes to the readings table with ttl', async () => {
  sendMock.mockResolvedValue({});
  await putReading({
    schoolId: 's1', ts: '2026-10-10T06:00:00Z', pm25: 100,
    source: 'openaq', ttl: 1790000000,
  });
  const cmd = sendMock.mock.calls[0]![0];
  expect(cmd.constructor.name).toBe('PutCommand');
  expect(cmd.input.TableName).toBe('readings-test');
  expect(cmd.input.Item.schoolId).toBe('s1');
  expect(cmd.input.Item.ttl).toBe(1790000000);
});

test('getRecentReadings queries 24h window newest-first', async () => {
  sendMock.mockResolvedValue({ Items: [{ schoolId: 's1', ts: 't2' }, { schoolId: 's1', ts: 't1' }] });
  const items = await getRecentReadings('s1');
  expect(items.map((i) => i.ts)).toEqual(['t2', 't1']);
  const cmd = sendMock.mock.calls[0]![0];
  expect(cmd.input.TableName).toBe('readings-test');
  expect(cmd.input.ScanIndexForward).toBe(false);
  expect(cmd.input.ExpressionAttributeValues[':since']).toMatch(/Z$/);
});

test('table name env vars are required, not hard-coded', async () => {
  delete process.env.SCHOOLS_TABLE;
  await expect(putSchool({ schoolId: 'x', name: 'n', city: 'c', lat: 0, lng: 0 })).rejects.toThrow(
    /SCHOOLS_TABLE/
  );
});

test('getSchool returns null when Item absent', async () => {
  sendMock.mockResolvedValue({});
  expect(await getSchool('missing')).toBeNull();
});

test('getAllSchools returns Items array', async () => {
  sendMock.mockResolvedValue({ Items: [{ schoolId: 'a' }, { schoolId: 'b' }] });
  expect(await getAllSchools()).toHaveLength(2);
});
