// Telegram Update parsing (Phase 9, task 9.3).
// Pure logic, no network or AWS: turn a raw Bot API Update object into one of
// our small, typed intents so the webhook handler only has to switch on them.
// Docs used (Oct 2026): https://core.telegram.org/bots/api (Update, Message,
// Location, CallbackQuery, BotCommand) and
// https://core.telegram.org/bots/features (deep-link payload: up to 64 chars,
// alphabet A-Z a-z 0-9 _ -).
import type { FetchLike } from './openaq';

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
  | { kind: 'location'; chatId: number; lat: number; lng: number; firstName?: string }
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
    const firstName = typeof msg.from?.first_name === 'string' ? msg.from.first_name : undefined;
    return { kind: 'location', chatId, lat: loc.latitude, lng: loc.longitude, ...(firstName ? { firstName } : {}) };
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

// ---------------------------------------------------------------------------
// Bot API client (Phase 9R, task 9R.1). Sends messages back to the user.
// ---------------------------------------------------------------------------
// Docs used (Oct 2026): https://core.telegram.org/bots/api
//  - sendMessage requires `chat_id` and `text` (1..4096 chars after entities);
//    optional `reply_markup`, `disable_notification`, `parse_mode`.
//  - ReplyKeyboardMarkup = { keyboard: KeyboardButton[][], resize_keyboard,
//    one_time_keyboard, ... }; KeyboardButton = { text, request_location? }.
//  - Error envelope: { ok:false, error_code, description, parameters?: { retry_after } }.
//    We map 403 (user blocked the bot) and 429 (rate limited) explicitly.
//  Parameter names cross-checked against the generated type reference
//  (gramio.dev/telegram/methods/sendMessage) because the main page truncates.
//
// We deliberately send NO parse_mode: every message we compose is plain text, so
// nothing needs escaping and a stray `*` or `_` in a station name cannot break a send.

export const TG_MAX_TEXT = 4096;
const TG_API_BASE = 'https://api.telegram.org';
const TG_TIMEOUT_MS = 10_000;
/** Never hold a Lambda open this long waiting out a 429. */
const MAX_429_WAIT_SEC = 30;

export type TelegramError =
  | 'no_token'
  | 'blocked'
  | 'rate_limit'
  | 'bad_request'
  | 'api_error'
  | 'network';

export type SendOutcome =
  | { ok: true; sent: number; messageIds: number[] }
  | { ok: false; sent: number; error: TelegramError; description?: string; blocked: boolean; retryAfterSec?: number };

export interface TgKeyboardButton {
  text: string;
  request_location?: boolean;
}

export interface TgReplyKeyboardMarkup {
  keyboard: TgKeyboardButton[][];
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
}

export interface TgDeps {
  fetchLike?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface TgClient {
  sendMessage(
    chatId: number | string,
    text: string,
    opts?: { replyMarkup?: TgReplyKeyboardMarkup; disableNotification?: boolean }
  ): Promise<SendOutcome>;
}

interface TgApiResponse {
  ok?: boolean;
  result?: { message_id?: number };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

type CallResult =
  | { kind: 'response'; status: number; body: TgApiResponse }
  | { kind: 'network'; detail: string };

/**
 * Split text into chunks of at most `limit` characters, preferring paragraph,
 * then line, then word boundaries; a single over-long token is hard-split so a
 * send can never fail with TEXT_TOO_LONG. Pure.
 */
export function splitMessage(text: string, limit = TG_MAX_TEXT): string[] {
  const clean = (text ?? '').trim();
  if (!clean) return [];
  if (clean.length <= limit) return [clean];

  const parts: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit; // one very long token
    const head = rest.slice(0, cut).trimEnd();
    if (head) parts.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** The reply keyboard that makes Telegram offer a one-tap "share my location" button. */
export function locationKeyboard(text: string, placeholder?: string): TgReplyKeyboardMarkup {
  return {
    keyboard: [[{ text, request_location: true }]],
    resize_keyboard: true,
    one_time_keyboard: true,
    ...(placeholder ? { input_field_placeholder: placeholder } : {}),
  };
}

async function callApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  fetchLike: FetchLike
): Promise<CallResult> {
  try {
    const res = await fetchLike(`${TG_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as TgApiResponse;
    return { kind: 'response', status: res.status, body };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return { kind: 'network', detail: name === 'TimeoutError' ? 'timeout' : String(err) };
  }
}

/** Sends one chunk, retrying once when Telegram says to wait a short time. */
async function sendChunk(
  chatId: number | string,
  text: string,
  token: string,
  fetchLike: FetchLike,
  sleep: (ms: number) => Promise<void>,
  replyMarkup: TgReplyKeyboardMarkup | undefined,
  disableNotification: boolean
): Promise<SendOutcome> {
  let attempt = 0;
  for (;;) {
    const payload: Record<string, unknown> = { chat_id: chatId, text };
    if (disableNotification) payload.disable_notification = true;
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await callApi(token, 'sendMessage', payload, fetchLike);
    if (res.kind === 'network') {
      return { ok: false, sent: 0, error: 'network', description: res.detail, blocked: false };
    }

    if (res.body?.ok) {
      const id = res.body.result?.message_id;
      return { ok: true, sent: 1, messageIds: typeof id === 'number' ? [id] : [] };
    }

    const code = res.body?.error_code ?? res.status;
    const description = res.body?.description;
    if (code === 403) return { ok: false, sent: 0, error: 'blocked', description, blocked: true };
    if (code === 429) {
      const retryAfterSec = res.body?.parameters?.retry_after;
      const canWait = attempt === 0 && typeof retryAfterSec === 'number' && retryAfterSec > 0 && retryAfterSec <= MAX_429_WAIT_SEC;
      if (canWait) {
        attempt += 1;
        await sleep((retryAfterSec as number) * 1000);
        continue;
      }
      return { ok: false, sent: 0, error: 'rate_limit', description, blocked: false, retryAfterSec };
    }
    if (code === 400) return { ok: false, sent: 0, error: 'bad_request', description, blocked: false };
    return { ok: false, sent: 0, error: 'api_error', description: description ?? `HTTP ${res.status}`, blocked: false };
  }
}

/**
 * Builds a client bound to one bot token. `deps` lets tests stub the network and
 * the sleep, so no unit test ever touches Telegram.
 */
export function createTgClient(token: string, deps: TgDeps = {}): TgClient {
  const fetchLike = deps.fetchLike ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  return {
    async sendMessage(chatId, text, opts = {}) {
      if (!token) return { ok: false, sent: 0, error: 'no_token', blocked: false };

      const chunks = splitMessage(text);
      if (chunks.length === 0) {
        return { ok: false, sent: 0, error: 'bad_request', description: 'empty text', blocked: false };
      }

      const messageIds: number[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const outcome = await sendChunk(
          chatId,
          chunks[i]!,
          token,
          fetchLike,
          sleep,
          isLast ? opts.replyMarkup : undefined,
          opts.disableNotification === true
        );
        if (!outcome.ok) return { ...outcome, sent: messageIds.length };
        messageIds.push(...outcome.messageIds);
      }
      return { ok: true, sent: messageIds.length, messageIds };
    },
  };
}
