// Tests for the conversation layer (Phase 9R: 9R.4 /start + location, 9R.5 /status).
// BotDeps is injected, so these tests need no AWS, no OpenAQ and no network.
import { test, expect, vi } from 'vitest';
import { formatAirReport, handleIntent, TEXTS, type BotDeps } from '../lib/bot';
import { locKeyFor, type Subscriber } from '../lib/subscribers';
import { OpenAqError, type Pm25Reading } from '../lib/openaq';
import { aqiToTier } from '../lib/tiers';
import type { Intent } from '../lib/telegram';

/** A station reading shaped like the OpenAQ client's output. */
const READING: Pm25Reading = {
  pm25: 105,
  stationName: 'DPCC Anand Vihar',
  stationId: 8118,
  measuredAt: '2026-10-11T06:00:00Z',
};

interface Sent {
  chatId: number | string;
  text: string;
  opts?: { replyMarkup?: unknown };
}

function fakeDeps(options: {
  existing?: Record<string, Subscriber>;
  sendFails?: 'blocked' | 'network' | 'bad_request';
  /** what the OpenAQ lookup should do */
  pm25?: Pm25Reading | 'no_station' | 'stale_data' | 'api_error' | 'timeout';
} = {}) {
  const sent: Sent[] = [];
  const saved: { chatId: string; firstName?: string; lat: number; lng: number }[] = [];
  const fetched: { lat: number; lng: number }[] = [];
  const activeCalls: { chatId: string; active: boolean }[] = [];
  const blockedCalls: string[] = [];
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
    fetchPm25: async (lat, lng) => {
      fetched.push({ lat, lng });
      if (options.pm25 === 'no_station') throw new OpenAqError('no_station', 'no station within 25 km');
      if (options.pm25 === 'stale_data') throw new OpenAqError('stale_data', 'sensor reports are stale');
      if (options.pm25 === 'api_error') throw new OpenAqError('api_error', 'HTTP 500');
      if (options.pm25 === 'timeout') throw new OpenAqError('timeout', 'took too long');
      return options.pm25 ?? READING;
    },
    setActive: async (chatId, active) => {
      activeCalls.push({ chatId, active });
    },
    markBlocked: async (chatId) => {
      blockedCalls.push(chatId);
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

  return { deps, sent, saved, fetched, activeCalls, blockedCalls, subs };
}

const existingSub = (locKey?: string, lat?: number, lng?: number): Subscriber => ({
  chatId: '555',
  ...(locKey ? { locKey } : {}),
  ...(typeof lat === 'number' && typeof lng === 'number' ? { lat, lng } : {}),
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
  // the confirmation line, followed by the current reading (task 9R.5)
  expect(sent[0]!.text).toContain(TEXTS.locationUpdated(locKeyFor(28.6139, 77.209)));
  expect(sent[0]!.text).toContain('AQI 249');
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

test('an unparseable update sends nothing and reports why', async () => {
  const { deps, sent } = fakeDeps();

  const ignored = await handleIntent({ kind: 'ignored', reason: 'no message' }, deps);

  expect(ignored).toEqual({ action: 'ignored:no message', sent: 0, blocked: false });
  expect(sent).toHaveLength(0);
});

test('a not-yet-implemented intent type stays silent rather than guessing', async () => {
  const { deps, sent } = fakeDeps();
  const intent = { kind: 'language', chatId: 555, lang: 'en' } as unknown as Intent;

  const outcome = await handleIntent(intent, deps);

  expect(outcome.action).toBe('unhandled:language');
  expect(sent).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// task 9R.5: /status and the reading shown right after onboarding
// ---------------------------------------------------------------------------

const status = (chatId = 555): Intent => ({ kind: 'command', chatId, command: 'status', args: [] });

test('/status with no shared location asks for one and never calls OpenAQ', async () => {
  const { deps, sent, fetched } = fakeDeps();

  const outcome = await handleIntent(status(), deps);

  expect(outcome.action).toBe('status.no_location');
  expect(sent[0]!.text).toBe(TEXTS.noLocation);
  expect(fetched).toHaveLength(0);
});

test('/status reports AQI, tier, station and the action plan for the saved location', async () => {
  const { deps, sent, fetched } = fakeDeps({ existing: { '555': existingSub('28.62,77.20', 28.6139, 77.209) } });

  const outcome = await handleIntent(status(), deps);

  expect(outcome.action).toBe('status.report');
  expect(fetched).toEqual([{ lat: 28.6139, lng: 77.209 }]);
  const text = sent[0]!.text;
  expect(text).toContain('AQI 249');
  expect(text).toContain('Poor');
  expect(text).toContain('ORANGE');
  expect(text).toContain('PM2.5 105');
  expect(text).toContain('06:00 UTC');
  expect(text).toContain('DPCC Anand Vihar');
  expect(text).toContain('Cancel outdoor sports and assemblies.');
  expect(text).toContain('do not replace official orders');
});

test('/status says so plainly when there is no station within range', async () => {
  const { deps, sent } = fakeDeps({ existing: { '555': existingSub('a', 1, 2) }, pm25: 'no_station' });

  const outcome = await handleIntent(status(), deps);

  expect(outcome.action).toBe('status.fetch_failed');
  expect(sent[0]!.text).toBe(TEXTS.noStation);
});

test('/status distinguishes a silent station from a dead service', async () => {
  const stale = fakeDeps({ existing: { '555': existingSub('a', 1, 2) }, pm25: 'stale_data' });
  expect((await handleIntent(status(), stale.deps)).action).toBe('status.fetch_failed');
  expect(stale.sent[0]!.text).toBe(TEXTS.staleStation);

  for (const reason of ['api_error', 'timeout'] as const) {
    const down = fakeDeps({ existing: { '555': existingSub('a', 1, 2) }, pm25: reason });
    await handleIntent(status(), down.deps);
    expect(down.sent[0]!.text).toBe(TEXTS.serviceDown);
  }
});

test('a subscriber row without coordinates is treated as no location', async () => {
  const { deps, fetched } = fakeDeps({ existing: { '555': existingSub() } });

  const outcome = await handleIntent(status(), deps);

  expect(outcome.action).toBe('status.no_location');
  expect(fetched).toHaveLength(0);
});

test('sharing a location also shows the current air, in the same reply', async () => {
  const { deps, sent } = fakeDeps();

  const outcome = await handleIntent({ kind: 'location', chatId: 555, lat: 28.6139, lng: 77.209 }, deps);

  expect(outcome.action).toBe('location.saved');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.text).toContain('✅ Saved');
  expect(sent[0]!.text).toContain('AQI 249');
});

test('if OpenAQ is down we still confirm the saved location (onboarding must not fail)', async () => {
  const { deps, sent, saved } = fakeDeps({ pm25: 'api_error' });

  const outcome = await handleIntent({ kind: 'location', chatId: 555, lat: 28.6139, lng: 77.209 }, deps);

  expect(outcome.action).toBe('location.saved');
  expect(saved).toHaveLength(1);
  expect(sent[0]!.text).toBe(TEXTS.locationSaved(locKeyFor(28.6139, 77.209)));
});

test('formatAirReport derives the tier from the shared AQI math', () => {
  const text = formatAirReport(READING);

  expect(text).toContain(`AQI 249 — Poor (${aqiToTier(249)})`);
  expect(text).toContain(`PM2.5 ${READING.pm25}`);
  expect(text).toContain(READING.stationName);
});

// ---------------------------------------------------------------------------
// task 9R.6: /stop, help fallback and the blocked-bot path
// ---------------------------------------------------------------------------

test('/stop switches the alerts off for a subscriber who is set up', async () => {
  const { deps, sent, activeCalls } = fakeDeps({ existing: { '555': existingSub('a', 1, 2) } });

  const outcome = await handleIntent({ kind: 'command', chatId: 555, command: 'stop', args: [] }, deps);

  expect(outcome.action).toBe('stop.done');
  expect(activeCalls).toEqual([{ chatId: '555', active: false }]);
  expect(sent[0]!.text).toBe(TEXTS.stopped);
});

test('/stop on a chat that never signed up says so instead of faking success', async () => {
  const { deps, sent, activeCalls } = fakeDeps();

  const outcome = await handleIntent({ kind: 'command', chatId: 555, command: 'stop', args: [] }, deps);

  expect(outcome.action).toBe('stop.not_set_up');
  expect(activeCalls).toHaveLength(0);
  expect(sent[0]!.text).toBe(TEXTS.notSetUp);
});

test('sharing a location again after /stop switches the alerts back on', async () => {
  const stopped = existingSub();
  stopped.active = false;
  const { deps, subs } = fakeDeps({ existing: { '555': stopped } });

  await handleIntent({ kind: 'location', chatId: 555, lat: 1, lng: 2 }, deps);

  // upsertCitizen sets active = true, so re-onboarding revives a stopped chat
  expect(subs.get('555')?.active).toBe(true);
});

test('/help explains the three things the bot can do', async () => {
  const { deps, sent } = fakeDeps();

  const outcome = await handleIntent({ kind: 'command', chatId: 555, command: 'help', args: [] }, deps);

  expect(outcome.action).toBe('help');
  expect(sent[0]!.text).toBe(TEXTS.help);
  expect(sent[0]!.text).toContain('/status');
  expect(sent[0]!.text).toContain('/stop');
});

test('an unknown command and plain chat get the menu, never silence', async () => {
  const { deps, sent } = fakeDeps();

  const unknown = await handleIntent({ kind: 'command', chatId: 555, command: 'unknown', args: [] }, deps);
  const chat = await handleIntent({ kind: 'text', chatId: 555, text: 'is it safe today?' }, deps);

  expect(unknown.action).toBe('help.unknown_command');
  expect(chat.action).toBe('help.text');
  expect(sent.map((s) => s.text)).toEqual([TEXTS.help, TEXTS.help]);
});

test('a 403 from Telegram marks the subscriber blocked', async () => {
  const { deps, blockedCalls } = fakeDeps({ sendFails: 'blocked' });

  await handleIntent({ kind: 'start', chatId: 555 }, deps);

  expect(blockedCalls).toEqual(['555']);
});

test('a non-blocking send failure does not mark anyone blocked', async () => {
  const { deps, blockedCalls } = fakeDeps({ sendFails: 'network' });

  await handleIntent({ kind: 'start', chatId: 555 }, deps);

  expect(blockedCalls).toHaveLength(0);
});

test('formatAirReport handles a RED reading', () => {
  const text = formatAirReport({ ...READING, pm25: 180, measuredAt: '2026-10-11T18:30:00Z' });

  expect(text).toContain('AQI 346');
  expect(text).toContain('RED');
  expect(text).toContain('18:30 UTC');
  expect(text).toContain('All outdoor activity stopped.');
});
