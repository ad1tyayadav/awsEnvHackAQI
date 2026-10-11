// Conversation layer for the citizen air bot (Phase 9R).
//
// Every side effect arrives through `BotDeps`, so each flow can be tested with
// plain fakes - no AWS, no OpenAQ and no Telegram in unit tests.
//
// English only by decision (2026-10-11): the bot asks for nothing but a
// location, so there is no language step to interrupt the one-tap onboarding.
import { locationKeyboard, type Intent, type TgClient } from './telegram';
import { locKeyFor, type Subscriber } from './subscribers';

export interface BotDeps {
  tg: TgClient;
  getSubscriber(chatId: string): Promise<Subscriber | null>;
  saveLocation(input: { chatId: string; firstName?: string; lat: number; lng: number }): Promise<void>;
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
} as const;

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
  return reply(deps, chatId, text, moved ? 'location.updated' : 'location.saved');
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
    case 'ignored':
      return { action: `ignored:${intent.reason}`, sent: 0, blocked: false };
    default:
      return { action: `unhandled:${intent.kind}`, sent: 0, blocked: false };
  }
}
