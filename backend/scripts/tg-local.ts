// Test the REAL bot from your machine - no AWS, no deploy, no SAM CLI.
//
// Telegram cannot call a webhook on localhost, so instead of a webhook this
// script asks Telegram for updates itself (getUpdates "long polling") and feeds
// them through the same parser, the same conversation flows, the same Bot API
// client and the same OpenAQ code the deployed Lambdas use. Only the storage is
// swapped: DynamoDB becomes a JSON file.
//
//   npx tsx scripts/tg-local.ts            # chat with the bot on your phone
//   npx tsx scripts/tg-local.ts --fanout   # run the 30-minute alert job once
//   npx tsx scripts/tg-local.ts --store    # show what has been saved
//
// Values come from the repo-root .env (TELEGRAM_BOT_TOKEN, OPENAQ_API_KEY).
// Docs used (Oct 2026): core.telegram.org/bots/api - getUpdates ("This method
// will not work if an outgoing webhook is set up", offset/limit/timeout/
// allowed_updates), deleteWebhook, getMe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleIntent, type BotDeps } from '../src/lib/bot';
import { runCitizenFanout } from '../src/lib/fanout';
import { fetchNearestPM25 } from '../src/lib/openaq';
import { locKeyFor, type Subscriber } from '../src/lib/subscribers';
import { createTgClient, parseUpdate, type TgUpdate } from '../src/lib/telegram';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STORE_FILE = path.join(__dirname, '..', '.localstore', 'subscribers.json');
const TG_API = 'https://api.telegram.org';

// --- env ------------------------------------------------------------------
/** Reads KEY=value lines from .env. Accepts the legacy `opendata` alias. */
function loadEnv(): { token: string; openAqKey: string } {
  let text = '';
  try {
    text = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    console.error('No .env found at ' + path.join(REPO_ROOT, '.env') + ' - copy .env.example to .env first.');
    process.exit(1);
  }
  const get = (...names: string[]): string => {
    for (const name of names) {
      const m = text.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'mi'));
      const value = m?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
      if (value) return value;
    }
    return '';
  };
  return { token: get('TELEGRAM_BOT_TOKEN'), openAqKey: get('OPENAQ_API_KEY', 'opendata') };
}

// --- storage: DynamoDB replaced by a JSON file ------------------------------
function loadStore(): Subscriber[] {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as { subscribers?: Subscriber[] };
    return raw.subscribers ?? [];
  } catch {
    return [];
  }
}
function saveStore(subscribers: Subscriber[]): void {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify({ subscribers }, null, 2));
}

function upsertCitizen(input: { chatId: string; firstName?: string; lat: number; lng: number }): void {
  const subscribers = loadStore();
  const now = new Date().toISOString();
  const existing = subscribers.find((s) => s.chatId === input.chatId);
  const locKey = locKeyFor(input.lat, input.lng);
  if (existing) {
    // Mirrors the real UpdateCommand: coordinates and status move, createdAt stays.
    Object.assign(existing, {
      ...(input.firstName ? { firstName: input.firstName } : {}),
      lat: input.lat,
      lng: input.lng,
      locKey,
      active: true,
      blocked: false,
      updatedAt: now,
    });
  } else {
    subscribers.push({
      chatId: input.chatId,
      ...(input.firstName ? { firstName: input.firstName } : {}),
      lat: input.lat,
      lng: input.lng,
      locKey,
      active: true,
      blocked: false,
      lastAlertTier: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  saveStore(subscribers);
}

/** Patches one subscriber row, the way the real UpdateCommands do. */
function patch(chatId: string, changes: Partial<Subscriber>): void {
  const subscribers = loadStore();
  const row = subscribers.find((s) => s.chatId === chatId);
  if (!row) return;
  Object.assign(row, changes, { updatedAt: new Date().toISOString() });
  saveStore(subscribers);
}

function buildDeps(token: string, openAqKey: string): BotDeps {
  return {
    tg: createTgClient(token),
    getSubscriber: async (chatId) => loadStore().find((s) => s.chatId === chatId) ?? null,
    saveLocation: async (input) => upsertCitizen(input),
    setActive: async (chatId, active) => patch(chatId, { active }),
    markBlocked: async (chatId) => patch(chatId, { blocked: true }),
    fetchPm25: async (lat, lng) => {
      if (!openAqKey) throw new Error('no OpenAQ key in .env (OPENAQ_API_KEY or opendata)');
      return fetchNearestPM25(lat, lng, openAqKey);
    },
  };
}

// --- raw Telegram calls (not part of the bot: only this test harness) -------
interface TgResult<T> { ok?: boolean; result?: T; error_code?: number; description?: string }

async function tgCall<T>(token: string, method: string, body: Record<string, unknown> = {}): Promise<TgResult<T>> {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000), // long polling holds the request open
  });
  return (await res.json().catch(() => ({}))) as TgResult<T>;
}

// --- modes -----------------------------------------------------------------
async function modeStore(): Promise<void> {
  const subscribers = loadStore();
  console.log(`\n${subscribers.length} subscriber(s) in ${STORE_FILE}\n`);
  for (const s of subscribers) {
    console.log(
      `  chat ${s.chatId}  ${s.firstName ?? ''}  locKey ${s.locKey ?? '-'}  ` +
      `active=${s.active} blocked=${s.blocked} lastAlertTier=${s.lastAlertTier ?? 'null'}`
    );
  }
}

/** The automatic alert, exactly as the 30-minute scheduler runs it. */
async function modeFanout(token: string, openAqKey: string): Promise<void> {
  const subscribers = loadActive();
  console.log(`\nRunning the alert job now (as the 30-minute scheduler would) - ${subscribers.length} active subscriber(s).\n`);

  const summary = await runCitizenFanout({
    tg: createTgClient(token),
    listActiveCitizens: async () => subscribers,
    fetchPm25: (lat, lng) => fetchNearestPM25(lat, lng, openAqKey),
    setLastAlertTier: async (chatId, tier) => patch(chatId, { lastAlertTier: tier }),
    markBlocked: async (chatId) => patch(chatId, { blocked: true }),
  });

  console.log('\nsummary: ' + JSON.stringify(summary));
  if (summary.subscribers === 0) {
    console.log('Nothing to alert: no active subscribers yet. Send /start to the bot on your phone first.');
  } else if (summary.alertsSent === 0) {
    console.log(
      'No alert sent. Either the air is not ORANGE/RED right now, or this subscriber was already\n' +
      'told about the current tier (that is the de-duplication working). To see it fire again:\n' +
      '  npx tsx scripts/tg-local.ts --reset   (clears lastAlertTier, keeps the location)'
    );
  }
}

function loadActive(): Subscriber[] {
  return loadStore().filter((s) => s.active && !s.blocked);
}

function modeReset(): void {
  const subscribers = loadStore().map((s) => ({ ...s, lastAlertTier: null }));
  saveStore(subscribers);
  console.log(`Cleared lastAlertTier on ${subscribers.length} subscriber(s) - the next --fanout will alert again.`);
}

/** Long polling: Telegram hands us the updates instead of calling a webhook. */
async function modePoll(token: string, openAqKey: string): Promise<void> {
  const me = await tgCall<{ username?: string; first_name?: string }>(token, 'getMe');
  if (!me.ok) {
    console.error(`\nTelegram rejected the token: ${me.error_code} ${me.description}`);
    console.error('Check TELEGRAM_BOT_TOKEN in .env (it comes from @BotFather, /newbot).\n');
    process.exit(1);
  }
  console.log(`\nBot: @${me.result?.username} (${me.result?.first_name})`);
  console.log(`OpenAQ key: ${openAqKey ? 'loaded' : 'MISSING - /status will explain the failure'}`);

  // Docs: getUpdates does not work while a webhook is set, so remove it first.
  const del = await tgCall(token, 'deleteWebhook', { drop_pending_updates: false });
  console.log(`Webhook cleared: ${del.ok ? 'yes' : `no (${del.description ?? 'unknown'})`}`);
  console.log(`Store: ${STORE_FILE}`);
  console.log('\nOpen your bot in Telegram and send /start, then tap "Share my location".');
  console.log('Send /status, /stop, or any message. Press Ctrl+C to stop this script.\n');

  const deps = buildDeps(token, openAqKey);
  let offset = 0;
  for (;;) {
    const res = await tgCall<TgUpdate[]>(token, 'getUpdates', {
      offset,
      timeout: 30,
      allowed_updates: ['message'],
    });
    if (!res.ok) {
      console.error(`getUpdates failed: ${res.error_code} ${res.description}`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    for (const update of res.result ?? []) {
      offset = update.update_id + 1; // offset must exceed the last update_id
      const intent = parseUpdate(update);
      try {
        const outcome = await handleIntent(intent, deps);
        console.log(`  ${new Date().toISOString().slice(11, 19)}  ${intent.kind.padEnd(9)} -> ${outcome.action} (sent ${outcome.sent})`);
      } catch (err) {
        console.error(`  handler error for ${intent.kind}: ${String(err)}`);
      }
    }
  }
}

// --- entry point -----------------------------------------------------------
// Wrapped in a function on purpose: this package compiles to CommonJS (no
// "type": "module" in package.json), where top-level await is a syntax error.
async function main(): Promise<void> {
  const flag = process.argv[2] ?? '';
  const { token, openAqKey } = loadEnv();

  if (flag === '--store') {
    await modeStore();
  } else if (flag === '--reset') {
    modeReset();
  } else if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is missing from .env - get it from @BotFather (/newbot).');
    process.exitCode = 1;
  } else if (flag === '--fanout') {
    await modeFanout(token, openAqKey);
  } else {
    await modePoll(token, openAqKey);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
