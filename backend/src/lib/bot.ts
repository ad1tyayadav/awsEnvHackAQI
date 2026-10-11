// Conversation layer for the citizen air bot (Phase 9R).
//
// Every side effect arrives through `BotDeps`, so each flow can be tested with
// plain fakes - no AWS, no OpenAQ and no Telegram in unit tests.
//
// English only by decision (2026-10-11): the bot asks for nothing but a
// location, so there is no language step to interrupt the one-tap onboarding.
import { locationKeyboard, type Intent, type TgClient } from './telegram';
import { locKeyFor, type Subscriber } from './subscribers';
import { OpenAqError, type Pm25Reading } from './openaq';
import { pm25ToAqi } from './aqi';
import { aqiToTier, type Tier } from './tiers';
import { getAdvisoryText, DISCLAIMER } from './advisory';

export interface BotDeps {
  tg: TgClient;
  getSubscriber(chatId: string): Promise<Subscriber | null>;
  saveLocation(input: { chatId: string; firstName?: string; lat: number; lng: number }): Promise<void>;
  /** Nearest recent PM2.5 reading, reusing the same OpenAQ client as the scheduler. */
  fetchPm25(lat: number, lng: number): Promise<Pm25Reading>;
  /** /stop sets active = false; /start (via a location share) sets it back. */
  setActive(chatId: string, active: boolean): Promise<void>;
  /** Telegram said the user blocked the bot: remember it so we stop sending. */
  markBlocked(chatId: string): Promise<void>;
}

export interface BotOutcome {
  /** what the flow decided, for CloudWatch: e.g. 'start.welcome', 'location.saved' */
  action: string;
  sent: number;
  /** true when Telegram says the user blocked the bot */
  blocked: boolean;
}

/** Every user-facing string, in one place so the demo can be previewed/reviewed. */
export const TEXTS = {
  shareButton: '📍 Share my location',

  welcome: [
    '👋 I watch the air quality in YOUR area.',
    '',
    'Share your location once — that is the whole sign-up. After that I message you here automatically whenever the air turns bad, so you never have to check anything.',
    '',
    'Tap the button below to share your location.',
  ].join('\n'),

  welcomeBack: [
    '👋 You are already set up — I am watching your area.',
    '',
    'Tap the button below to update your location, or send /status for the current reading. /stop makes me go quiet.',
  ].join('\n'),

  locationSaved: (locKey: string) => [
    '✅ Saved. I am watching the air in your area.',
    '',
    `I only keep the ~2 km cell around you (${locKey}), not your exact address.`,
    '',
    'That is everything — you can close this chat. When the air turns bad here, I will message you automatically.',
    '',
    '/status — current reading   /stop — go quiet',
  ].join('\n'),

  locationUpdated: (locKey: string) =>
    `✅ Location updated (${locKey}). I am watching your new area now.`,

  noLocation: [
    'I do not know your area yet.',
    '',
    'Send /start and tap the 📍 Share my location button — that is all I need.',
  ].join('\n'),

  // One clear sentence per failure, so a user is never left guessing.
  noStation: [
    'I could not find an air-quality station near your area yet.',
    '',
    'The public sensor network is thin outside big cities. You can send /start and share a different location (a nearby city works too) — I will keep trying from here either way.',
  ].join('\n'),

  staleStation: [
    'The nearest station has not reported recently, so I cannot give you a reliable number right now.',
    '',
    'Please try /status again a little later.',
  ].join('\n'),

  serviceDown: [
    'The air-quality service is not responding right now.',
    '',
    'Please try /status again in a few minutes.',
  ].join('\n'),

  stopped: [
    '🔕 Alerts stopped. I will stay quiet.',
    '',
    'Send /start whenever you want them back.',
  ].join('\n'),

  help: [
    'I watch the air in your area and message you when it turns bad.',
    '',
    '/status — the reading right now',
    '/start — sign up or move to another area',
    '/stop — stop the alerts',
  ].join('\n'),

  notSetUp: [
    'You are not set up yet, so there is nothing to stop.',
    '',
    'Send /start and tap 📍 Share my location to begin.',
  ].join('\n'),

  alertHeader: (tier: string, aqi: number) =>
    `⚠️ Air alert — the air in your area is ${tier} (AQI ${aqi}).`,
} as const;

/** '2026-10-11T06:00:00Z' -> '06:00 UTC'; falls back to the raw string. */
function measuredLabel(measuredAt: string): string {
  return measuredAt.length >= 16 ? `${measuredAt.slice(11, 16)} UTC` : measuredAt;
}

/** The automatic alert sent when the air turns bad. Pure. */
export function formatAlert(tier: Tier, aqi: number, reading: Pm25Reading): string {
  return [
    TEXTS.alertHeader(tier, aqi),
    '',
    `PM2.5 ${reading.pm25} µg/m³, measured ${measuredLabel(reading.measuredAt)}`,
    `Station: ${reading.stationName}`,
    '',
    'What to do:',
    getAdvisoryText(tier),
    '',
    DISCLAIMER,
  ].join('\n');
}

/** Nicely formats one reading. Pure. */
export function formatAirReport(reading: Pm25Reading): string {
  const { aqi, category } = pm25ToAqi(reading.pm25);
  const tier: Tier = aqiToTier(aqi);
  const measured = measuredLabel(reading.measuredAt);

  return [
    `🌫️ Air right now in your area`,
    '',
    `AQI ${aqi} — ${category} (${tier})`,
    `PM2.5 ${reading.pm25} µg/m³, measured ${measured}`,
    `Station: ${reading.stationName}`,
    '',
    'What to do:',
    getAdvisoryText(tier),
    '',
    DISCLAIMER,
  ].join('\n');
}

/** Maps a station/service failure to the sentence we send the user. */
function fetchFailureText(err: unknown): string {
  if (err instanceof OpenAqError) {
    if (err.reason === 'no_station') return TEXTS.noStation;
    if (err.reason === 'stale_data') return TEXTS.staleStation;
  }
  return TEXTS.serviceDown;
}

/** Sends one reply and turns the client's result into a loggable outcome. */
async function reply(
  deps: BotDeps,
  chatId: number,
  text: string,
  action: string,
  replyMarkup?: ReturnType<typeof locationKeyboard>
): Promise<BotOutcome> {
  const res = await deps.tg.sendMessage(chatId, text, replyMarkup ? { replyMarkup } : {});
  if (!res.ok) {
    console.error(JSON.stringify({ msg: 'telegram send failed', chatId, action, error: res.error }));
    if (res.blocked) {
      // A 403 means they blocked the bot: remember it so the scheduler stops
      // wasting sends. A failure here must not mask the send failure.
      try {
        await deps.markBlocked(String(chatId));
      } catch (err) {
        console.error(JSON.stringify({ msg: 'could not mark subscriber blocked', chatId, error: String(err) }));
      }
    }
    return { action: `${action}.failed`, sent: res.sent, blocked: res.blocked };
  }
  return { action, sent: res.sent, blocked: false };
}

/**
 * /start: greet and offer the share-location button. Deliberately writes
 * NOTHING, which is what makes re-running /start harmless - a user who taps it
 * twice gets the same one row, never a duplicate.
 */
async function handleStart(chatId: number, deps: BotDeps): Promise<BotOutcome> {
  const existing = await deps.getSubscriber(String(chatId));
  const known = Boolean(existing?.locKey);
  const text = known ? TEXTS.welcomeBack : TEXTS.welcome;
  return reply(deps, chatId, text, known ? 'start.welcome_back' : 'start.welcome', locationKeyboard(TEXTS.shareButton));
}

/** A shared location is the only thing we ever store: coordinates + a 2 km cell. */
async function handleLocation(
  chatId: number,
  lat: number,
  lng: number,
  firstName: string | undefined,
  deps: BotDeps
): Promise<BotOutcome> {
  const before = await deps.getSubscriber(String(chatId));
  // Save first: if the write fails we must not claim the location was saved.
  await deps.saveLocation({
    chatId: String(chatId),
    ...(firstName ? { firstName } : {}),
    lat,
    lng,
  });

  const locKey = locKeyFor(lat, lng);
  const moved = Boolean(before?.locKey) && before?.locKey !== locKey;
  const text = moved ? TEXTS.locationUpdated(locKey) : TEXTS.locationSaved(locKey);

  // Best effort: showing the current air right away makes the one-time sign-up
  // feel complete. If OpenAQ is unreachable we still confirm the location.
  let reading: string | null = null;
  try {
    reading = formatAirReport(await deps.fetchPm25(lat, lng));
  } catch (err) {
    console.warn(JSON.stringify({ msg: 'openaq failed during onboarding', chatId, error: String(err) }));
  }

  return reply(deps, chatId, reading ? `${text}\n\n${reading}` : text, moved ? 'location.updated' : 'location.saved');
}

/**
 * /stop: stop the automatic alerts. Only meaningful for someone who is set up;
 * telling a stranger "stopped" would be a lie, so they get the sign-up hint.
 */
async function handleStop(chatId: number, deps: BotDeps): Promise<BotOutcome> {
  const sub = await deps.getSubscriber(String(chatId));
  if (!sub) return reply(deps, chatId, TEXTS.notSetUp, 'stop.not_set_up');

  await deps.setActive(String(chatId), false);
  return reply(deps, chatId, TEXTS.stopped, 'stop.done');
}

/** /status: same reading on demand, with a clear sentence if anything fails. */
async function handleStatus(chatId: number, deps: BotDeps): Promise<BotOutcome> {
  const sub = await deps.getSubscriber(String(chatId));
  if (!sub || typeof sub.lat !== 'number' || typeof sub.lng !== 'number') {
    return reply(deps, chatId, TEXTS.noLocation, 'status.no_location');
  }

  try {
    const reading = await deps.fetchPm25(sub.lat, sub.lng);
    return reply(deps, chatId, formatAirReport(reading), 'status.report');
  } catch (err) {
    console.error(JSON.stringify({ msg: 'openaq failed for /status', chatId, error: String(err) }));
    return reply(deps, chatId, fetchFailureText(err), 'status.fetch_failed');
  }
}

/**
 * Routes one parsed update. Intents that this phase does not handle yet return
 * an `unhandled:` action and send nothing, so the webhook can log them without
 * inventing a reply.
 */
export async function handleIntent(intent: Intent, deps: BotDeps): Promise<BotOutcome> {
  switch (intent.kind) {
    case 'start':
      return handleStart(intent.chatId, deps);
    case 'location':
      return handleLocation(intent.chatId, intent.lat, intent.lng, intent.firstName, deps);
    case 'command':
      if (intent.command === 'status') return handleStatus(intent.chatId, deps);
      if (intent.command === 'stop') return handleStop(intent.chatId, deps);
      if (intent.command === 'help') return reply(deps, intent.chatId, TEXTS.help, 'help');
      // An unknown command gets the same menu as plain chat: never silence.
      return reply(deps, intent.chatId, TEXTS.help, 'help.unknown_command');
    case 'text':
      // Free text cannot be understood yet (no AI layer). Answer with the menu
      // rather than leaving the user staring at nothing.
      return reply(deps, intent.chatId, TEXTS.help, 'help.text');
    case 'ignored':
      return { action: `ignored:${intent.reason}`, sent: 0, blocked: false };
    default:
      return { action: `unhandled:${intent.kind}`, sent: 0, blocked: false };
  }
}
