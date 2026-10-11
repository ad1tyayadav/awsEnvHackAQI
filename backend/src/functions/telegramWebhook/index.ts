// Telegram webhook Lambda (Phase 9 task 9.2, wired to the flows in task 9R.4).
// Telegram POSTs every bot Update to /telegram/webhook. Two jobs:
//   1. the security gate: verify the X-Telegram-Bot-Api-Secret-Token header
//      Telegram echoes back (the value we passed as `secret_token` to setWebhook);
//   2. hand the Update to the conversation layer and acknowledge it.
// We always answer 200 once the secret is valid: Telegram retries every non-2xx
// and a retry would mean duplicate messages.
import { createTgClient, parseUpdate, type TgUpdate } from '../../lib/telegram';
import { handleIntent, type BotDeps } from '../../lib/bot';
import { getSubscriber, upsertCitizen } from '../../lib/subscribers';
import { fetchNearestPM25 } from '../../lib/openaq';

/** Case-insensitive header lookup; HTTP API v2 header names vary in case. */
export function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string
): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/** True only when the supplied header exactly matches the configured secret.
 *  Refuses when the secret is not configured, so a missing env var can never
 *  turn the endpoint into an open door. Compares in constant-ish time. */
export function verifySecret(header: string | undefined, expected: string): boolean {
  if (!expected || !header) return false;
  if (header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i += 1) {
    diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export interface WebhookDeps {
  bot: BotDeps;
}

/**
 * Real dependencies for Lambda. Environment variables are read per request
 * (inside the injected functions) so a cold start cannot cache a stale value.
 */
export function productionDeps(): WebhookDeps {
  return {
    bot: {
      tg: createTgClient(process.env.TELEGRAM_BOT_TOKEN ?? ''),
      getSubscriber,
      saveLocation: upsertCitizen,
      // Same OpenAQ client the scheduler uses; key read per request.
      fetchPm25: (lat, lng) => fetchNearestPM25(lat, lng, process.env.OPENAQ_API_KEY ?? ''),
    },
  };
}

export function createWebhookHandler(deps: WebhookDeps) {
  return async (event: {
    headers?: Record<string, string | undefined>;
    body?: string | null;
  } = {}): Promise<{ statusCode: number; body: string }> => {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
    const got = getHeader(event.headers, 'x-telegram-bot-api-secret-token');

    if (!verifySecret(got, expected)) {
      // Log the decision, never the secret value.
      console.warn(JSON.stringify({ msg: 'telegram webhook rejected', reason: 'bad secret' }));
      return { statusCode: 403, body: 'forbidden' };
    }

    let update: TgUpdate | undefined;
    try {
      update = event.body ? (JSON.parse(event.body) as TgUpdate) : undefined;
    } catch {
      console.error(JSON.stringify({ msg: 'telegram webhook bad json body' }));
      return { statusCode: 200, body: 'ok' };
    }

    try {
      const intent = parseUpdate(update);
      const outcome = await handleIntent(intent, deps.bot);
      console.log(
        JSON.stringify({
          msg: 'telegram update handled',
          updateId: update?.update_id,
          intent: intent.kind,
          action: outcome.action,
          sent: outcome.sent,
        })
      );
      if (outcome.blocked) {
        console.warn(JSON.stringify({ msg: 'telegram user blocked the bot', action: outcome.action }));
      }
    } catch (err) {
      // Never 5xx: Telegram would retry and the user would get duplicates.
      console.error(JSON.stringify({ msg: 'telegram handler error', error: String(err) }));
    }

    return { statusCode: 200, body: 'ok' };
  };
}

/** Production entry point: built per request so env vars are read fresh. */
export const handler = async (event: {
  headers?: Record<string, string | undefined>;
  body?: string | null;
} = {}): Promise<{ statusCode: number; body: string }> => createWebhookHandler(productionDeps())(event);
