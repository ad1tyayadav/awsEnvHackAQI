// Telegram webhook Lambda (Phase 9, task 9.2).
// Telegram POSTs every bot Update to /telegram/webhook. This handler's only job
// right now is the security gate: verify the X-Telegram-Bot-Api-Secret-Token
// header that Telegram echoes back (the value we pass as `secret_token` when we
// call setWebhook). Everything else (parsing the Update, /start, location,
// /status) is added in tasks 9.3+.

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

export const handler = async (event: {
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

  // 9.3+: parse the Update and route it. Today we just acknowledge so Telegram
  // does not retry.
  console.log(JSON.stringify({ msg: 'telegram webhook accepted' }));
  return { statusCode: 200, body: 'ok' };
};
