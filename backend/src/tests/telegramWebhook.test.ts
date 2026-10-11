// Tests for the Telegram webhook secret gate (task 9.2).
// No network: we call the handler directly with fake API Gateway events.
import { test, expect, beforeEach } from 'vitest';
import { handler, verifySecret, getHeader } from '../functions/telegramWebhook';

const SECRET = 's3cr3t-token_ABC-123';
const event = (secretHeader?: string | undefined, headerName = 'x-telegram-bot-api-secret-token') => ({
  headers: secretHeader === undefined ? {} : { [headerName]: secretHeader },
  body: JSON.stringify({ update_id: 1 }),
});

beforeEach(() => {
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
});

test('correct secret header returns 200', async () => {
  const res = await handler(event(SECRET));
  expect(res.statusCode).toBe(200);
});

test('header name match is case-insensitive (Telegram sends X-Telegram-Bot-Api-Secret-Token)', async () => {
  const res = await handler(event(SECRET, 'X-Telegram-Bot-Api-Secret-Token'));
  expect(res.statusCode).toBe(200);
});

test('wrong secret returns 403', async () => {
  const res = await handler(event('wrong'));
  expect(res.statusCode).toBe(403);
});

test('same-length wrong secret returns 403', async () => {
  const res = await handler(event('S3CR3T-token_ABC-123')); // 19 chars, same length
  expect(res.statusCode).toBe(403);
});

test('missing header returns 403', async () => {
  const res = await handler({ headers: {}, body: '{}' });
  expect(res.statusCode).toBe(403);
});

test('unconfigured secret refuses everyone (never an open door)', async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = '';
  expect((await handler(event(SECRET))).statusCode).toBe(403);
});

test('empty header value returns 403', async () => {
  expect((await handler(event(''))).statusCode).toBe(403);
});

test('verifySecret and getHeader unit behaviour', () => {
  expect(verifySecret(SECRET, SECRET)).toBe(true);
  expect(verifySecret(undefined, SECRET)).toBe(false);
  expect(verifySecret(SECRET, '')).toBe(false);
  expect(getHeader({ Foo: 'bar' }, 'foo')).toBe('bar');
  expect(getHeader(undefined, 'foo')).toBeUndefined();
});
