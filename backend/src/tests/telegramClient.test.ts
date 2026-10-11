// Tests for the Telegram Bot API client (Phase 9R, task 9R.1).
// No network: every call goes through an injected fetch and an injected sleep.
// Response shapes used here come from the Bot API docs (ok/result/error_code/
// description/parameters.retry_after), see the header of lib/telegram.ts.
import { test, expect, vi } from 'vitest';
import { createTgClient, splitMessage, locationKeyboard, TG_MAX_TEXT } from '../lib/telegram';
import type { FetchLike } from '../lib/openaq';

const TOKEN = '123456:AAtest-token';

/** Builds a fetch stub that replays the given responses in order. */
function fetchSequence(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; payload: Record<string, unknown> }[] = [];
  let i = 0;
  const fetchLike: FetchLike = async (url, init) => {
    calls.push({ url, payload: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchLike, calls };
}

const okBody = (messageId = 42) => ({ ok: true, result: { message_id: messageId, chat: { id: 1 } } });

test('sends a plain-text message and returns the message id', async () => {
  const { fetchLike, calls } = fetchSequence([{ status: 200, body: okBody(7) }]);
  const client = createTgClient(TOKEN, { fetchLike });

  const res = await client.sendMessage(555, 'Hello');

  expect(res).toEqual({ ok: true, sent: 1, messageIds: [7] });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  expect(calls[0]!.payload.chat_id).toBe(555);
  expect(calls[0]!.payload.text).toBe('Hello');
});

test('never sends parse_mode (our text is plain, so nothing can be mis-parsed)', async () => {
  const { fetchLike, calls } = fetchSequence([{ status: 200, body: okBody() }]);
  await createTgClient(TOKEN, { fetchLike }).sendMessage(1, 'AQI 210 *RED* _now_');

  expect(calls[0]!.payload).not.toHaveProperty('parse_mode');
  expect(calls[0]!.payload.text).toBe('AQI 210 *RED* _now_');
});

test('attaches the location keyboard only when asked', async () => {
  const { fetchLike, calls } = fetchSequence([{ status: 200, body: okBody() }]);
  const kb = locationKeyboard('📍 Share my location');
  await createTgClient(TOKEN, { fetchLike }).sendMessage(1, 'Where are you?', { replyMarkup: kb });

  expect(calls[0]!.payload.reply_markup).toEqual(kb);
  expect(calls[0]!.payload).not.toHaveProperty('disable_notification');
});

test('a message longer than 4096 chars is split into several sends', async () => {
  const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a long advisory.`).join('\n');
  expect(long.length).toBeGreaterThan(TG_MAX_TEXT);
  const { fetchLike, calls } = fetchSequence([{ status: 200, body: okBody(1) }, { status: 200, body: okBody(2) }]);

  const res = await createTgClient(TOKEN, { fetchLike }).sendMessage(1, long);

  expect(res.ok).toBe(true);
  expect(calls.length).toBeGreaterThan(1);
  for (const c of calls) expect(String(c.payload.text).length).toBeLessThanOrEqual(TG_MAX_TEXT);
  // nothing may be dropped on the floor
  expect(calls.map((c) => c.payload.text).join('\n')).toBe(long);
});

test('a 403 means the user blocked the bot, and it is reported not thrown', async () => {
  const { fetchLike } = fetchSequence([
    { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } },
  ]);

  const res = await createTgClient(TOKEN, { fetchLike }).sendMessage(1, 'hi');

  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error).toBe('blocked');
    expect(res.blocked).toBe(true);
  }
});

test('a short 429 waits retry_after seconds and retries once', async () => {
  const { fetchLike, calls } = fetchSequence([
    {
      status: 429,
      body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } },
    },
    { status: 200, body: okBody(9) },
  ]);
  const sleep = vi.fn(async () => {});

  const res = await createTgClient(TOKEN, { fetchLike, sleep }).sendMessage(1, 'hi');

  expect(sleep).toHaveBeenCalledWith(2000);
  expect(calls).toHaveLength(2);
  expect(res).toEqual({ ok: true, sent: 1, messageIds: [9] });
});

test('a long 429 gives up instead of holding the Lambda open', async () => {
  const { fetchLike } = fetchSequence([
    {
      status: 429,
      body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 120', parameters: { retry_after: 120 } },
    },
  ]);
  const sleep = vi.fn(async () => {});

  const res = await createTgClient(TOKEN, { fetchLike, sleep }).sendMessage(1, 'hi');

  expect(sleep).not.toHaveBeenCalled();
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error).toBe('rate_limit');
    expect(res.retryAfterSec).toBe(120);
    expect(res.blocked).toBe(false);
  }
});

test('400 (e.g. TEXT_TOO_LONG) is reported as bad_request', async () => {
  const { fetchLike } = fetchSequence([
    { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: TEXT_TOO_LONG' } },
  ]);

  const res = await createTgClient(TOKEN, { fetchLike }).sendMessage(1, 'hi');

  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe('bad_request');
});

test('a 5xx is reported as api_error', async () => {
  const { fetchLike } = fetchSequence([{ status: 502, body: { ok: false, description: 'Bad Gateway' } }]);

  const res = await createTgClient(TOKEN, { fetchLike }).sendMessage(1, 'hi');

  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe('api_error');
});

test('a network failure is caught, not thrown', async () => {
  const fetchLike: FetchLike = async () => {
    throw new TypeError('fetch failed');
  };

  const res = await createTgClient(TOKEN, { fetchLike }).sendMessage(1, 'hi');

  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe('network');
});

test('a missing token fails fast without any network call', async () => {
  const fetchLike = vi.fn() as unknown as FetchLike;

  const res = await createTgClient('', { fetchLike }).sendMessage(1, 'hi');

  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe('no_token');
  expect(fetchLike).not.toHaveBeenCalled();
});

test('sendMessage refuses to send an empty body', async () => {
  const { fetchLike, calls } = fetchSequence([{ status: 200, body: okBody() }]);

  const res = await createTgClient(TOKEN, { fetchLike }).sendMessage(1, '   \n  ');

  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe('bad_request');
  expect(calls).toHaveLength(0);
});

test('splitMessage prefers paragraph breaks and hard-splits an over-long token', () => {
  expect(splitMessage('')).toEqual([]);
  expect(splitMessage('   ')).toEqual([]);
  expect(splitMessage('short')).toEqual(['short']);

  const twoParagraphs = `${'a'.repeat(10)}\n\n${'b'.repeat(10)}`;
  expect(splitMessage(twoParagraphs, 12)).toEqual(['a'.repeat(10), 'b'.repeat(10)]);

  const oneWord = 'x'.repeat(25);
  expect(splitMessage(oneWord, 10)).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);

  const atLimit = 'y'.repeat(TG_MAX_TEXT);
  expect(splitMessage(atLimit)).toEqual([atLimit]);
});

test('locationKeyboard requests the location and is a one-time, resized keyboard', () => {
  expect(locationKeyboard('Share location')).toEqual({
    keyboard: [[{ text: 'Share location', request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
  expect(locationKeyboard('Share location', 'Or type a city').input_field_placeholder).toBe('Or type a city');
});
