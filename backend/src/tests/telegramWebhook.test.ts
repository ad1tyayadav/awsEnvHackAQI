// Tests for the Telegram webhook: the secret gate (task 9.2) and the routing of
// updates into the conversation layer (task 9R.4).
// No network: we call the handler directly with fake API Gateway events and
// injected bot deps, so nothing reaches Telegram.
import { test, expect, beforeEach } from 'vitest';
import { handler, createWebhookHandler, verifySecret, getHeader, type WebhookDeps } from '../functions/telegramWebhook';

/** Minimal bot deps that record what the webhook decided to send. */
function fakeDeps(opts: { existing?: Record<string, unknown>; throwOnSave?: boolean } = {}) {
  const sent: { chatId: number | string; text: string }[] = [];
  const saved: { chatId: string; lat: number; lng: number }[] = [];
  const deps: WebhookDeps = {
    bot: {
      tg: {
        async sendMessage(chatId, text) {
          sent.push({ chatId, text });
          return { ok: true, sent: 1, messageIds: [1] };
        },
      },
      getSubscriber: async (chatId) => (opts.existing?.[chatId] as never) ?? null,
      saveLocation: async (input) => {
        if (opts.throwOnSave) throw new Error('dynamodb down');
        saved.push(input);
      },
    },
  };
  return { deps, sent, saved };
}

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

// ---------------------------------------------------------------------------
// Routing (task 9R.4): a valid update reaches the flows.
// ---------------------------------------------------------------------------

const update = (body: unknown) => ({ headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify(body) });

const startUpdate = {
  update_id: 10,
  message: { message_id: 1, chat: { id: 555, type: 'private' }, from: { id: 555, first_name: 'Asha' }, text: '/start' },
};

const locationUpdate = {
  update_id: 11,
  message: {
    message_id: 2,
    chat: { id: 555, type: 'private' },
    from: { id: 555, first_name: 'Asha' },
    location: { latitude: 28.6139, longitude: 77.209 },
  },
};

test('/start is routed to the bot and answered', async () => {
  const { deps, sent } = fakeDeps();

  const res = await createWebhookHandler(deps)(update(startUpdate));

  expect(res.statusCode).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.chatId).toBe(555);
  expect(sent[0]!.text).toContain('Share your location');
});

test('a shared location is stored for the right chat', async () => {
  const { deps, saved } = fakeDeps();

  const res = await createWebhookHandler(deps)(update(locationUpdate));

  expect(res.statusCode).toBe(200);
  expect(saved).toEqual([{ chatId: '555', firstName: 'Asha', lat: 28.6139, lng: 77.209 }]);
});

test('an update we do not handle is acknowledged silently (no invented reply)', async () => {
  const { deps, sent } = fakeDeps();

  const res = await createWebhookHandler(deps)(update({ update_id: 12, edited_message: { message_id: 3, chat: { id: 9 } } }));

  expect(res.statusCode).toBe(200);
  expect(sent).toHaveLength(0);
});

test('a handler failure still answers 200 so Telegram does not retry and duplicate', async () => {
  const { deps } = fakeDeps({ throwOnSave: true });

  const res = await createWebhookHandler(deps)(update(locationUpdate));

  expect(res.statusCode).toBe(200);
});

test('a malformed JSON body is acknowledged, never a 5xx', async () => {
  const { deps } = fakeDeps();

  const res = await createWebhookHandler(deps)({ headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: '{not json' });

  expect(res.statusCode).toBe(200);
});

test('the real handler stays offline for updates that need no reply', async () => {
  // The production handler is wired to real DynamoDB/Telegram, so this test only
  // feeds it an update that reaches no side effect (the ignored path). Anything
  // that sends or writes is covered above with injected deps instead.
  const res = await handler({ headers: { 'x-telegram-bot-api-secret-token': SECRET }, body: JSON.stringify({ update_id: 1 }) });

  expect(res.statusCode).toBe(200);
});
