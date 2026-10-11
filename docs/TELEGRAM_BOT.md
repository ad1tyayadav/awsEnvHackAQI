# Telegram Bot — design doc

Status: PLANNED (documentation only, awaiting approval; no code yet).
Source docs consulted (Oct 2026):
- Bot API reference: https://core.telegram.org/bots/api (webhook + secret_token, Update/Message/Location objects, sendMessage limits, error format `{ok:false, error_code, description}`)
- Bot features / deep links: https://core.telegram.org/bots/features (start payload up to 64 chars, A-Z a-z 0-9 _ -)
- Bots FAQ (limits): https://core.telegram.org/bots/faq (≈30 msg/s broadcast, 1 msg/s per chat, 20 msg/min per group)

## Bot setup (human, @BotFather)

1. `/newbot` → choose name + username → copy the **bot token** (never commit).
2. Generate a random **webhook secret** (256 chars max, chars A-Z a-z 0-9 _ -).
3. Both go into SAM as NoEcho params `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`.
4. Set the webhook once the API is deployed:
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=https://<api>/telegram/webhook" -d "secret_token=<WEBHOOK_SECRET>" -d 'allowed_updates=["message","callback_query","my_chat_member"]'`
   - `my_chat_member` is required to detect **blocked bot** (private-chat member status change).
   - For local dev: `deleteWebhook` first (webhook and getUpdates are mutually exclusive).

## Commands and flows

| Command | Behaviour |
|---|---|
| `/start` | Welcome + language choice via inline keyboard (English / हिंदी). With deep-link payload `school_<schoolId>`, registers a **school-follower** for that school. Idempotent: re-running updates, not duplicates. |
| language buttons (callback_query) | Save `lang`, then ask for location via the Telegram **location request button** (reply keyboard) or "send your city name". |
| location message | Save `lat/lng`, rounded to create `locKey` (grouping key); confirm + show /status. |
| city name text | Geocode-lite: instead of a maps API, match against a small built-in city list or use the rounded coordinate the user shares. Clear error if unmatched. |
| `/status` | Fetch nearest PM2.5 for the subscriber's location (or linked school), compute AQI/tier with the existing pure functions, reply with the cached advisory in their language + the rule block. |
| `/language` | Show the language buttons again. |
| `/stop` | Mark subscriber inactive (stop alerts). `/start` re-activates. |
| any other text | Q&A path (AI layer, Phase 11): rule-based status + optional AI tip. Before Phase 11 it replies with the rule-based status. |

### Deep link for schools

`https://t.me/<BotUsername>?start=school_<schoolId>` — payload ≤ 64 chars, safe alphabet; school IDs already match (e.g. `sch_1728..._ab12cd` fits). The dashboard shows this link per school (Phase 12 button).

## Subscriber types

**Citizen-first: a citizen needs NOTHING else after step 3.**

- `citizen` (the default and main use): own lat/lng, alerts for the rounded location. One-time onboarding = /start → language → location. After that the bot is fully self-serve: automatic ORANGE/RED alerts every 30-minute cycle, /status, /language, /stop, Q&A and /explain — all in chat, no dashboard, no email, no account.
- `school-follower` (optional layer): linked `schoolId` via deep link, alerts whenever that school alerts (same tier-rise dedupe). A parent can ALSO be a citizen — the types are not exclusive for alerting; each subscription tracks its own `lastAlertTier`.

## Data model (SubscribersTable, PK chatId)

`type ("citizen"|"school-follower"), lang, lat, lng, locKey, schoolId, lastAlertTier, blocked (bool), active (bool), createdAt, updatedAt`

## Alert fan-out (Phase 10) — citizen-first monitoring

The scheduled job monitors BOTH kinds of location:
1. **Citizen groups:** read all ACTIVE citizen subscribers, group by `locKey` (~2 km rounding), fetch OpenAQ ONCE per group, evaluate with the shared pipeline, then send each citizen their alert (their language, dedupe via their `lastAlertTier`). This is how someone who only ever pressed /start gets automatic alerts.
2. **Schools:** exactly as today (email via SNS) plus Telegram to `school-follower` subscribers grouped by `schoolId`, dedupe per subscriber with `shouldAlert(sub.lastAlertTier, tier)`.

For every alert: per-subscriber `lastAlertTier` update, guided by the existing `shouldAlert` rule; email path unchanged.

## Message texts (draft; developer reviews before build)

English welcome: "👋 I watch the air for YOUR area. Share your location once and I'll alert you whenever it turns bad. Choose your language:"
Hindi: "👋 मैं आपके इलाक़े की हवा पर नज़र रखता हूँ। एक बार लोकेशन भेजें — फिर जब भी हवा ख़राब होगी, मैं आपको यहीं बता दूँगा। अपनी भाषा चुनें:"
Status footer (both languages): guidance-only disclaimer (same wording as the dashboard/email).

## Security

- Every webhook request: compare header `X-Telegram-Bot-Api-Secret-Token` with the secret; mismatch → 403, nothing processed.
- Handler always returns HTTP 200 quickly (Telegram retries non-2xx and would duplicate sends); errors are logged, work is idempotent where possible.
- chatId is the identity; no phone numbers or contacts are stored.

## Error handling

| Case | Handling |
|---|---|
| User blocks bot (`my_chat_member` → `kicked`) | mark `blocked = true`, stop sending; un-unblocks re-activate on next message |
| 403 Forbidden on sendMessage | same as above (belt and braces) |
| 429 Too Many Requests | respect `parameters.retry_after`, pace fan-out (≈1 msg/s per chat, chunked globally) |
| Message > 4096 chars | split into sequential sendMessage calls at the limit |
| Invalid/unmatched location or no nearby station | clear bilingual error, suggest city list or retry |
| Telegram 5xx/network | log, return 200, rely on dedupe to prevent double alerts |

## Rate limits (from Bots FAQ)

- Broadcast ≈ 30 messages/second overall, ~1 message/second per chat, 20/minute per group.
- Alert volume is naturally low (≤1 alert per subscriber per tier rise) but the fan-out loop still sleeps/chunks.

## Manual test checklist

1. setWebhook with wrong secret → send a /start from a phone → no reply; CloudWatch log shows 403.
2. Correct secret, empty chat → /start → welcome + 2 language buttons (test both).
3. Share location → /status shows AQI + tier + plan in chosen language.
4. Send a city name ("Delhi") → same as above; gibberish city → friendly error.
5. `/start school_<realId>` from the dashboard link → alerts arrive for that school; simulate RED → bot alert received once (dedupe: simulate again → no second alert).
6. `/language` switches language; `/stop` stops alerts; blocked-bot case: block the bot, run a simulate RED → no error loop, subscriber marked blocked.
7. Long advisory text (>4096 chars is unlikely, but force with a debug flag) → arrives split into two messages.
8. Rate-limit guard: simulate 40 subscribers in localdb.json → fan-out completes, sends paced, none silently dropped.
