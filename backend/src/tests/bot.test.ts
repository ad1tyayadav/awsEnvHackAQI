// Tests for the conversation layer (Phase 9R, task 9R.4: /start + location).
// BotDeps is injected, so these tests need no AWS, no OpenAQ and no network.
import { test, expect, vi } from 'vitest';
import { handleIntent, TEXTS, type BotDeps } from '../lib/bot';
import { locKeyFor, type Subscriber } from '../lib/subscribers';
import type { Intent } from '../lib/telegram';

interface Sent {
  chatId: number | string;
  text: string;
  opts?: { replyMarkup?: unknown };
}

function fakeDeps(options: {
  existing?: Record<string, Subscriber>;
  sendFails?: 'blocked' | 'network' | 'bad_request';
} = {}) {
  const sent: Sent[] = [];
  const saved: { chatId: string; firstName?: string; lat: number; lng: number }[] = [];
  const subs = new Map<string, Subscriber>(Object.entries(options.existing ?? {}));

  const deps: BotDeps = {
    tg: {
      async sendMessage(chatId, text, opts) {
        sent.push({ chatId, text, ...(opts ? { opts } : {}) });
        if (options.sendFails === 'blocked') {
          return { ok: false, sent: 0, error: 'blocked', blocked: true };
        }
        if (options.sendFails === 'network') {
          return { ok: false, sent: 0, error: 'network', blocked: false };
        }
        if (options.sendFails === 'bad_request') {
          return { ok: false, sent: 0, error: 'bad_request', blocked: false };
        }
        return { ok: true, sent: 1, messageIds: [1] };
      },
    },
    getSubscriber: async (chatId) => subs.get(chatId) ?? null,
    saveLocation: async (input) => {
      saved.push(input);
      subs.set(input.chatId, {
        chatId: input.chatId,
        ...(input.firstName ? { firstName: input.firstName } : {}),
        lat: input.lat,
        lng: input.lng,
        locKey: locKeyFor(input.lat, input.lng),
        active: true,
        blocked: false,
        lastAlertTier: null,
        createdAt: 't',
        updatedAt: 't',
      });
    },
  };

  return { deps, sent, saved, subs };
}

const existingSub = (locKey?: string): Subscriber => ({
  chatId: '555',
  ...(locKey ? { locKey } : {}),
  active: true,
  blocked: false,
  lastAlertTier: null,
  createdAt: 't',
  updatedAt: 't',
});

test('/start greets a new user and offers the share-location button', async () => {
  const { deps, sent } = fakeDeps();

  const outcome = await handleIntent({ kind: 'start', chatId: 555 }, deps);

  expect(outcome).toEqual({ action: 'start.welcome', sent: 1, blocked: false });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toBe(TEXTS.welcome);
  expect(sent[0]!.opts?.replyMarkup).toEqual({
    keyboard: [[{ text: TEXTS.shareButton, request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
});

test('/start writes nothing, so pressing it twice cannot duplicate a subscriber', async () => {
  const { deps, saved } = fakeDeps();

  await handleIntent({ kind: 'start', chatId: 555 }, deps);
  await handleIntent({ kind: 'start', chatId: 555 }, deps);

  expect(saved).toHaveLength(0);
});

test('a returning user gets the shorter welcome-back text, not a second sign-up', async () => {
  const { deps, sent } = fakeDeps({ existing: { '555': existingSub('28.62,77.20') } });

  const outcome = await handleIntent({ kind: 'start', chatId: 555 }, deps);

  expect(outcome.action).toBe('start.welcome_back');
  expect(sent[0]!.text).toBe(TEXTS.welcomeBack);
  expect(sent[0]!.text).not.toBe(TEXTS.welcome);
});

test('sharing a location stores it and confirms with the ~2 km cell (no exact address)', async () => {
  const { deps, sent, saved } = fakeDeps();

  const outcome = await handleIntent(
    { kind: 'location', chatId: 555, lat: 28.6139, lng: 77.209, firstName: 'Asha' },
    deps
  );

  expect(outcome).toEqual({ action: 'location.saved', sent: 1, blocked: false });
  expect(saved).toEqual([{ chatId: '555', firstName: 'Asha', lat: 28.6139, lng: 77.209 }]);
  expect(sent[0]!.text).toContain(locKeyFor(28.6139, 77.209));
  expect(sent[0]!.text).toContain('~2 km');
  // the confirmation must not include the raw coordinates
  expect(sent[0]!.text).not.toContain('28.6139');
  expect(sent[0]!.opts?.replyMarkup).toBeUndefined(); // no keyboard on the confirmation
});

test('sharing a location in a new area says updated, not saved', async () => {
  const { deps, sent } = fakeDeps({ existing: { '555': existingSub('19.07,72.87') } });

  const outcome = await handleIntent({ kind: 'location', chatId: 555, lat: 28.6139, lng: 77.209 }, deps);

  expect(outcome.action).toBe('location.updated');
  expect(sent[0]!.text).toBe(TEXTS.locationUpdated(locKeyFor(28.6139, 77.209)));
});

test('sharing the same area again is not reported as a move', async () => {
  const { deps } = fakeDeps({ existing: { '555': existingSub(locKeyFor(28.6139, 77.209)) } });

  const outcome = await handleIntent({ kind: 'location', chatId: 555, lat: 28.6139, lng: 77.209 }, deps);

  expect(outcome.action).toBe('location.saved');
});

test('a location with no first name still saves (the field is optional)', async () => {
  const { deps, saved } = fakeDeps();

  await handleIntent({ kind: 'location', chatId: 7, lat: 1, lng: 2 }, deps);

  expect(saved[0]).toEqual({ chatId: '7', lat: 1, lng: 2 });
});

test('chatId is stored as a string so big Telegram ids cannot lose precision', async () => {
  const { deps, saved } = fakeDeps();

  await handleIntent({ kind: 'location', chatId: 9007199254740991, lat: 1, lng: 2 }, deps);

  expect(typeof saved[0]!.chatId).toBe('string');
  expect(saved[0]!.chatId).toBe('9007199254740991');
});

test('a blocked user is reported, not thrown', async () => {
  const { deps } = fakeDeps({ sendFails: 'blocked' });

  const outcome = await handleIntent({ kind: 'start', chatId: 555 }, deps);

  expect(outcome).toEqual({ action: 'start.welcome.failed', sent: 0, blocked: true });
});

test('a network failure on send does not crash the flow', async () => {
  const { deps } = fakeDeps({ sendFails: 'network' });

  const outcome = await handleIntent({ kind: 'start', chatId: 555 }, deps);

  expect(outcome.action).toBe('start.welcome.failed');
  expect(outcome.blocked).toBe(false);
});

test('if saving the location fails we must not promise it was saved', async () => {
  const { deps, sent } = fakeDeps();
  deps.saveLocation = vi.fn(async () => {
    throw new Error('dynamodb down');
  });

  await expect(
    handleIntent({ kind: 'location', chatId: 555, lat: 1, lng: 2 }, deps)
  ).rejects.toThrow(/dynamodb down/);
  expect(sent).toHaveLength(0);
});

test('ignored and not-yet-handled intents send nothing and say why', async () => {
  const { deps, sent } = fakeDeps();

  const ignored = await handleIntent({ kind: 'ignored', reason: 'no message' }, deps);
  expect(ignored).toEqual({ action: 'ignored:no message', sent: 0, blocked: false });

  const text: Intent = { kind: 'text', chatId: 555, text: 'hello?' };
  const unhandled = await handleIntent(text, deps);
  expect(unhandled).toEqual({ action: 'unhandled:text', sent: 0, blocked: false });

  expect(sent).toHaveLength(0);
});
