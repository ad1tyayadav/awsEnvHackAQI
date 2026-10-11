// Prints the exact conversation the bot would have, without AWS, OpenAQ, a bot
// token or a deploy. Run it after any change to the bot's copy or rules:
//
//   cd backend && npx tsx scripts/preview-bot.ts
//
// It drives the REAL lib/bot.ts and lib/fanout.ts through their injected deps
// with a fake phone and a fake station, so what you read here is what a user
// would receive (only the reading is canned).
import { handleIntent, type BotDeps } from '../src/lib/bot';
import { runCitizenFanout } from '../src/lib/fanout';
import { locKeyFor, type Subscriber } from '../src/lib/subscribers';
import { OpenAqError, type Pm25Reading } from '../src/lib/openaq';
import type { Intent } from '../src/lib/telegram';

const DELHI = { lat: 28.6139, lng: 77.209, name: 'DPCC Anand Vihar' };
const MUMBAI = { lat: 19.076, lng: 72.8777, name: 'MPCB Bandra' };

/** Canned readings: pm25 180 -> AQI 346 RED, 105 -> 249 ORANGE, 25 -> GREEN */
const station: Record<string, Pm25Reading> = {
  [locKeyFor(DELHI.lat, DELHI.lng)]: {
    pm25: 180, stationName: DELHI.name, stationId: 1, measuredAt: '2026-10-11T06:00:00Z',
  },
  [locKeyFor(MUMBAI.lat, MUMBAI.lng)]: {
    pm25: 105, stationName: MUMBAI.name, stationId: 2, measuredAt: '2026-10-11T06:00:00Z',
  },
};

/** In-memory stand-in for the Subscribers table. */
const subs = new Map<string, Subscriber>();
const outbox: { to: string; text: string }[] = [];
const activeCalls: string[] = [];

const deps: BotDeps = {
  tg: {
    async sendMessage(chatId, text) {
      outbox.push({ to: String(chatId), text });
      return { ok: true, sent: 1, messageIds: [1] };
    },
  },
  getSubscriber: async (chatId) => subs.get(chatId) ?? null,
  saveLocation: async (input) => {
    subs.set(input.chatId, {
      chatId: input.chatId,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      lat: input.lat,
      lng: input.lng,
      locKey: locKeyFor(input.lat, input.lng),
      active: true,
      blocked: false,
      lastAlertTier: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  },
  setActive: async (chatId, active) => {
    activeCalls.push(`${chatId} -> active=${active}`);
    const s = subs.get(chatId);
    if (s) s.active = active;
  },
  markBlocked: async (chatId) => {
    const s = subs.get(chatId);
    if (s) s.blocked = true;
  },
  fetchPm25: async (lat, lng) => {
    const r = station[locKeyFor(lat, lng)];
    if (!r) throw new OpenAqError('no_station', 'no station within 25 km');
    return r;
  },
};

function show(label: string, result: { action: string }): void {
  console.log(`\n${'='.repeat(72)}\n${label}   [${result.action}]\n${'='.repeat(72)}`);
  while (outbox.length) console.log(`BOT:\n${outbox.shift()!.text}\n`);
}

const CHAT = 555;

async function main(): Promise<void> {
  console.log('CLEAN AIR BOT — dry run (no AWS, no network, no token)');

  show('USER: /start', await handleIntent({ kind: 'start', chatId: CHAT }, deps));

  show(
    `USER: shares location ${DELHI.lat},${DELHI.lng}`,
    await handleIntent({ kind: 'location', chatId: CHAT, lat: DELHI.lat, lng: DELHI.lng, firstName: 'Asha' }, deps)
  );

  show('USER: /start again (must not duplicate)', await handleIntent({ kind: 'start', chatId: CHAT }, deps));
  console.log(`subscriber rows: ${subs.size} (expected 1)\n`);

  show('USER: /status', await handleIntent({ kind: 'command', chatId: CHAT, command: 'status', args: [] }, deps));

  show('USER: "is it safe to go for a run today?"', await handleIntent({ kind: 'text', chatId: CHAT, text: 'is it safe to go for a run today?' }, deps));

  show('USER: /stop', await handleIntent({ kind: 'command', chatId: CHAT, command: 'stop', args: [] }, deps));
  console.log(`setActive calls: ${activeCalls.join(', ')}\n`);

  // Automatic alerts: two neighbours in Delhi (RED), one in Mumbai (ORANGE).
  const subscriber = (chatId: string, city: typeof DELHI): Subscriber => ({
    chatId,
    lat: city.lat,
    lng: city.lng,
    locKey: locKeyFor(city.lat, city.lng),
    active: true,
    blocked: false,
    lastAlertTier: null,
    createdAt: 't',
    updatedAt: 't',
  });
  const monitored = [subscriber('555', DELHI), subscriber('556', DELHI), subscriber('557', MUMBAI)];
  const tierWrites: string[] = [];

  const fanoutDeps = {
    tg: deps.tg,
    listActiveCitizens: async () => monitored,
    fetchPm25: deps.fetchPm25,
    setLastAlertTier: async (chatId: string, tier: string | null) => {
      tierWrites.push(`${chatId}->${tier}`);
    },
    markBlocked: async (chatId: string) => {
      console.warn(`(would mark ${chatId} blocked)`);
    },
  };

  console.log(`${'='.repeat(72)}\nSCHEDULER RUN 1 — 3 subscribers, 2 neighbourhoods\n${'='.repeat(72)}`);
  const first = await runCitizenFanout(fanoutDeps);
  console.log(`summary: ${JSON.stringify(first)}`);
  console.log(`OpenAQ lookups: ${first.openAqFetches} for ${first.subscribers} subscribers`);
  console.log(`\nALERTS SENT:\n`);
  while (outbox.length) console.log(`to ${outbox[0]!.to}:\n${outbox.shift()!.text}\n`);

  console.log(`${'='.repeat(72)}\nSCHEDULER RUN 2 — same air 30 minutes later (must stay quiet)\n${'='.repeat(72)}`);
  // pretend the first run recorded the tiers
  monitored.forEach((m) => { m.lastAlertTier = locKeyFor(m.lat!, m.lng!) === locKeyFor(DELHI.lat, DELHI.lng) ? 'RED' : 'ORANGE'; });
  const second = await runCitizenFanout(fanoutDeps);
  console.log(`summary: ${JSON.stringify(second)}`);
  console.log(`alertsSent on run 2: ${second.alertsSent} (expected 0 — already told, tier unchanged)`);

  console.log(`\ntier records written across both runs: ${tierWrites.join(', ')}\n`);

  show('USER: /status from Mumbai-style location', {
    ...(await (async () => {
      subs.set('557', monitored[2]!);
      return handleIntent({ kind: 'command', chatId: 557, command: 'status', args: [] }, deps);
    })()),
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
