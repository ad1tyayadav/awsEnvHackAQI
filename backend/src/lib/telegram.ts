// Telegram Update parsing (Phase 9, task 9.3).
// Pure logic, no network or AWS: turn a raw Bot API Update object into one of
// our small, typed intents so the webhook handler only has to switch on them.
// Docs used (Oct 2026): https://core.telegram.org/bots/api (Update, Message,
// Location, CallbackQuery, BotCommand) and
// https://core.telegram.org/bots/features (deep-link payload: up to 64 chars,
// alphabet A-Z a-z 0-9 _ -).

export type Lang = 'en' | 'hi';

export interface TgChat {
  id: number;
  type?: string;
}

export interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: { id: number; first_name?: string; language_code?: string };
  text?: string;
  location?: { latitude: number; longitude: number };
}

export interface TgCallbackQuery {
  id: string;
  from?: { id: number };
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/** Commands the bot understands today (others are reported as `unknown`). */
export const COMMANDS = ['start', 'status', 'language', 'stop', 'help', 'explain'] as const;
export type Command = (typeof COMMANDS)[number];

export type Intent =
  | { kind: 'start'; chatId: number; schoolId?: string; payload?: string }
  | { kind: 'command'; chatId: number; command: Command | 'unknown'; args: string[] }
  | { kind: 'language'; chatId: number; lang: Lang }
  | { kind: 'location'; chatId: number; lat: number; lng: number }
  | { kind: 'text'; chatId: number; text: string }
  | { kind: 'ignored'; reason: string };

const BOT_COMMAND_RE = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;
// Deep-link payload alphabet, per the Bot features doc.
const PAYLOAD_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'hi';
}

/** `/start` may carry a deep-link payload, e.g. `school_sch_1728_ab12cd`. */
export function parseStartPayload(raw: string | undefined): { schoolId?: string; payload?: string } {
  const payload = (raw ?? '').trim().split(/\s+/)[0] ?? '';
  if (!payload || !PAYLOAD_RE.test(payload)) return {};
  if (payload.startsWith('school_')) {
    const schoolId = payload.slice('school_'.length);
    return schoolId ? { schoolId, payload } : { payload };
  }
  return { payload };
}

/** Language buttons send `lang:en` / `lang:hi`; accept a bare `en` / `hi` too. */
export function parseLangCallback(data: string | undefined): Lang | null {
  const d = (data ?? '').trim().toLowerCase();
  const value = d.startsWith('lang:') ? d.slice('lang:'.length) : d;
  return isLang(value) ? value : null;
}

/**
 * Turns a raw Update into a typed intent. Order matters: callback queries
 * (button taps) first, then the message's location, then commands, then
 * plain text. Anything else is ignored rather than thrown, so a malformed
 * update can never crash the webhook.
 */
export function parseUpdate(update: TgUpdate | undefined | null): Intent {
  if (!update || typeof update !== 'object') return { kind: 'ignored', reason: 'no update' };

  const cq = update.callback_query;
  if (cq) {
    const chatId = cq.message?.chat?.id;
    if (typeof chatId !== 'number') return { kind: 'ignored', reason: 'callback without chat' };
    const lang = parseLangCallback(cq.data);
    if (lang) return { kind: 'language', chatId, lang };
    return { kind: 'ignored', reason: 'unknown callback data' };
  }

  const msg = update.message ?? update.edited_message;
  if (!msg) return { kind: 'ignored', reason: 'no message' };
  const chatId = msg?.chat?.id;
  if (typeof chatId !== 'number') return { kind: 'ignored', reason: 'message without chat' };

  const loc = msg.location;
  if (loc && Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude)) {
    return { kind: 'location', chatId, lat: loc.latitude, lng: loc.longitude };
  }

  const text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (!text) return { kind: 'ignored', reason: 'non-text, non-location message' };

  const m = text.match(BOT_COMMAND_RE);
  if (m) {
    const command = m[1]!.toLowerCase();
    const args = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
    if (command === 'start') {
      const { schoolId, payload } = parseStartPayload(args[0]);
      return schoolId === undefined && payload === undefined
        ? { kind: 'start', chatId }
        : { kind: 'start', chatId, ...(schoolId ? { schoolId } : {}), ...(payload ? { payload } : {}) };
    }
    const known = (COMMANDS as readonly string[]).includes(command) ? (command as Command) : 'unknown';
    return { kind: 'command', chatId, command: known, args };
  }

  return { kind: 'text', chatId, text };
}
