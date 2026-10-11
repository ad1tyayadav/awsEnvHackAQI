// Unit tests for subscribers.ts (Phase 9R, task 9R.3).
// The AWS SDK is mocked with vi.mock - no real AWS calls ever happen.
import { test, expect, beforeEach, vi } from 'vitest';

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

// import AFTER the mock is installed so subscribers.ts picks up the fake client
const {
  locKeyFor, groupByLocKey, upsertCitizen, getSubscriber,
  listActiveCitizens, groupActiveCitizensByLocKey,
  setLastAlertTier, setActive, markBlocked, LOC_KEY_PRECISION,
} = await import('../lib/subscribers');

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
  process.env.SUBSCRIBERS_TABLE = 'subscribers-test';
});

const cmd = (i = 0) => sendMock.mock.calls[i]![0] as { constructor: { name: string }; input: Record<string, any> };

test('locKeyFor snaps neighbours into the same cell and separates distant points', () => {
  // ~2 km apart in Delhi (0.02 deg latitude) must land in different cells
  expect(locKeyFor(28.6139, 77.209)).toBe(locKeyFor(28.6151, 77.2088)); // ~150 m apart
  expect(locKeyFor(28.62, 77.2)).not.toBe(locKeyFor(28.64, 77.2));
  expect(locKeyFor(0, 0)).toBe('0.00,0.00');
});

test('locKeyFor never emits a negative zero (it would split one cell into two keys)', () => {
  expect(locKeyFor(-0.001, -0.001)).toBe('0.00,0.00');
  expect(locKeyFor(-0.001, -0.001)).not.toContain('-0.00');
});

test('locKeyFor rejects non-finite coordinates instead of storing junk', () => {
  expect(() => locKeyFor(Number.NaN, 77)).toThrow(/finite coordinates/);
  expect(() => locKeyFor(28, Number.POSITIVE_INFINITY)).toThrow(/finite coordinates/);
});

test('LOC_KEY_PRECISION is the documented ~2 km grid', () => {
  expect(LOC_KEY_PRECISION).toBe(0.02);
});

test('groupByLocKey groups subscribers and ignores anyone with no location yet', () => {
  const sub = (chatId: string, locKey?: string) => ({
    chatId, locKey, active: true, blocked: false, lastAlertTier: null,
    createdAt: 't', updatedAt: 't',
  });

  const groups = groupByLocKey([sub('1', 'a'), sub('2', 'a'), sub('3', 'b'), sub('4')]);

  expect([...groups.keys()].sort()).toEqual(['a', 'b']);
  expect(groups.get('a')!.map((s) => s.chatId)).toEqual(['1', '2']);
  expect(groups.get('b')!.map((s) => s.chatId)).toEqual(['3']);
});

test('upsertCitizen updates one row keyed by chatId and preserves createdAt', async () => {
  await upsertCitizen({ chatId: '555', firstName: 'Asha', lat: 28.6139, lng: 77.209 });

  const c = cmd();
  expect(c.constructor.name).toBe('UpdateCommand');
  expect(c.input.TableName).toBe('subscribers-test');
  expect(c.input.Key).toEqual({ chatId: '555' });
  expect(c.input.UpdateExpression).toContain('createdAt = if_not_exists(createdAt, :now)');
  expect(c.input.UpdateExpression).toMatch(/active = :true/);
  expect(c.input.UpdateExpression).toMatch(/blocked = :false/);
  expect(c.input.ExpressionAttributeValues[':locKey']).toBe(locKeyFor(28.6139, 77.209));
  expect(c.input.ExpressionAttributeValues[':locKey']).toBe('28.62,77.20'); // 28.6139 snaps up on a 0.02 grid
  expect(c.input.ExpressionAttributeValues[':firstName']).toBe('Asha');
});

test('upsertCitizen without a first name does not set one', async () => {
  await upsertCitizen({ chatId: '7', lat: 1, lng: 2 });
  expect(cmd().input.UpdateExpression).not.toContain('firstName');
});

test('upsertCitizen is a single write, so /start twice cannot duplicate a user', async () => {
  await upsertCitizen({ chatId: '9', lat: 1, lng: 2 });
  await upsertCitizen({ chatId: '9', lat: 1, lng: 2 });

  expect(sendMock).toHaveBeenCalledTimes(2);
  for (const call of sendMock.mock.calls) {
    const c = call[0] as { constructor: { name: string }; input: Record<string, any> };
    expect(c.constructor.name).toBe('UpdateCommand'); // never Put: no blind overwrite
    expect(c.input.Key).toEqual({ chatId: '9' });
  }
});

test('getSubscriber returns null when the chat is unknown, and the row otherwise', async () => {
  sendMock.mockResolvedValueOnce({});
  expect(await getSubscriber('nope')).toBeNull();

  sendMock.mockResolvedValueOnce({ Item: { chatId: '1', locKey: 'a' } });
  expect((await getSubscriber('1'))?.locKey).toBe('a');
});

test('listActiveCitizens filters on active and blocked', async () => {
  sendMock.mockResolvedValue({ Items: [{ chatId: '1' }] });

  const subs = await listActiveCitizens();

  expect(subs).toHaveLength(1);
  const c = cmd();
  expect(c.constructor.name).toBe('ScanCommand');
  expect(c.input.FilterExpression).toBe('#a = :true AND #b = :false');
  expect(c.input.ExpressionAttributeNames).toEqual({ '#a': 'active', '#b': 'blocked' });
});

test('listActiveCitizens follows pagination so nobody is silently skipped', async () => {
  sendMock
    .mockResolvedValueOnce({ Items: [{ chatId: '1' }], LastEvaluatedKey: { chatId: '1' } })
    .mockResolvedValueOnce({ Items: [{ chatId: '2' }] });

  const subs = await listActiveCitizens();

  expect(subs.map((s) => s.chatId)).toEqual(['1', '2']);
  expect(sendMock).toHaveBeenCalledTimes(2);
  expect(cmd(1).input.ExclusiveStartKey).toEqual({ chatId: '1' });
});

test('groupActiveCitizensByLocKey turns a scan into one bucket per neighbourhood', async () => {
  sendMock.mockResolvedValue({
    Items: [
      { chatId: '1', locKey: 'a' },
      { chatId: '2', locKey: 'a' },
      { chatId: '3', locKey: 'b' },
    ],
  });

  const groups = await groupActiveCitizensByLocKey();

  expect(groups.size).toBe(2);
  expect(groups.get('a')!.map((s) => s.chatId)).toEqual(['1', '2']);
});

test('setLastAlertTier records the tier for de-duplication', async () => {
  await setLastAlertTier('42', 'RED');

  const c = cmd();
  expect(c.constructor.name).toBe('UpdateCommand');
  expect(c.input.UpdateExpression).toMatch(/lastAlertTier = :tier/);
  expect(c.input.ExpressionAttributeValues[':tier']).toBe('RED');
  expect(c.input.ExpressionAttributeValues[':now']).toMatch(/Z$/);
});

test('setActive(false) is how /stop goes quiet, and /start flips it back', async () => {
  await setActive('42', false);
  expect(cmd(0).input.ExpressionAttributeValues[':active']).toBe(false);

  await setActive('42', true);
  expect(cmd(1).input.ExpressionAttributeValues[':active']).toBe(true);
});

test('markBlocked stops us messaging a user who blocked the bot', async () => {
  await markBlocked('42');
  expect(cmd().input.ExpressionAttributeValues[':true']).toBe(true);
  expect(cmd().input.UpdateExpression).toMatch(/blocked = :true/);
});

test('the table name comes from the environment, never hard-coded', async () => {
  delete process.env.SUBSCRIBERS_TABLE;
  await expect(getSubscriber('1')).rejects.toThrow(/SUBSCRIBERS_TABLE/);
});
