# Telegram bot — setup and test runbook

The product is **just this bot**. A person sends `/start`, taps **share my
location** once, and is done. From then on:

| What | When |
|---|---|
| **Automatic alert** | The scheduler runs every 30 minutes. If the air for your ~2 km area escalated into **ORANGE or RED**, you get a message. Once per rise, never repeated. |
| `/status` | Current AQI, tier, station and the action plan, on demand |
| `/stop` | Stop the automatic alerts. Sending a location again (or `/start`) starts them again. |

English only. Alerts fire on ORANGE and RED by decision.

Docs used while building (Oct 2026, not from memory):
- Bot API reference <https://core.telegram.org/bots/api> — `setWebhook` (`secret_token`, `allowed_updates`), `sendMessage`, the `{ok, error_code, description, parameters.retry_after}` envelope
- Bot features <https://core.telegram.org/bots/features> — deep links, commands
- Bots FAQ <https://core.telegram.org/bots/faq> — ~30 msg/s overall, ~1 msg/s per chat

---

## 1. Create the bot (one-time, you)

1. In Telegram, message **@BotFather** → `/newbot` → name + username (e.g. `CleanAirAlertsBot`).
2. Copy the **token** (`123456:AA...`). Never commit it, never paste it into a chat.
3. Make a random **webhook secret** (1–256 chars from `A-Z a-z 0-9 _ -`):

   ```bash
   openssl rand -hex 32
   ```
4. Same chat, `/setcommands` → pick your bot → paste exactly these four lines, so
   the command menu users see matches what the bot answers (`COMMANDS` in
   `src/lib/telegram.ts` — the parser test fails if the two drift apart):

   ```
   start - Set up alerts for my area
   status - Air quality in my area right now
   stop - Stop sending me alerts
   help - What this bot does
   ```

---

## 2. Deploy (this is what gives Telegram a public HTTPS URL)

Telegram cannot reach `localhost`, so the webhook needs a deployed endpoint.
Everything is in `backend/template.yaml`.

```bash
cd backend
npm test                      # should be green before you deploy anything
sam build
sam deploy --guided           # stack: clean-air-planner, region: ap-south-1
```

When prompted for parameters:

| Parameter | Value |
|---|---|
| `OpenAQApiKey` | your OpenAQ key (NoEcho — never logged) |
| `TelegramBotToken` | the BotFather token |
| `TelegramWebhookSecret` | the random string from step 1.3 |
| `Stage` | `prod` (default) |

Both Telegram values are `NoEcho`, so they never appear in deploy output or logs.
The same values can be supplied non-interactively. Keep them in `.env` (copy the
tracked `.env.example` first) rather than retyping them:

```bash
cp .env.example .env           # then fill in the three values
set -a; source .env; set +a    # exports them for the shell
```

Nothing reads `.env` automatically — there is no dotenv in the project, so it is
a safe notepad plus the source for the command below. Never put AWS access keys
in it; the AWS CLI uses `aws configure` / `aws sso login`.

```bash
sam deploy --parameter-overrides \
  OpenAQApiKey="$OPENAQ_KEY" \
  TelegramBotToken="$TELEGRAM_BOT_TOKEN" \
  TelegramWebhookSecret="$TELEGRAM_WEBHOOK_SECRET"
```

Copy the **`ApiBaseUrl`** from the deploy output — you need it next. Resources
this creates: 5 DynamoDB tables (pay-per-request), 3 Lambdas, 1 HTTP API, 1 SNS
topic, 1 EventBridge schedule. Nothing bills hourly.

---

## 3. Point Telegram at your Lambda

```bash
API=https://<api-id>.execute-api.ap-south-1.amazonaws.com/prod
TOKEN=<bot token>
SECRET=<webhook secret>

curl "https://api.telegram.org/bot$TOKEN/setWebhook" \
  -d "url=$API/telegram/webhook" \
  -d "secret_token=$SECRET" \
  -d 'allowed_updates=["message","my_chat_member"]'
```

- `secret_token` makes Telegram send the header `X-Telegram-Bot-Api-Secret-Token`
  on every request; the Lambda rejects anything else with **403**.
- `allowed_updates` keeps the noise down: messages (commands, locations) plus
  `my_chat_member` so a block/unblock is visible.

Before deploying, you can validate the template without any AWS credentials:

```bash
pip install cfn-lint
cfn-lint --region ap-south-1 --template backend/template.yaml
```

Expect one warning only (`W2531`, the deprecated `nodejs20.x` runtime) and no
`E####` errors. `backend/scripts/validate-template.mjs` is the offline stand-in
that runs without Python; it checks structure, not CloudFormation semantics.

Verify the webhook registration:

```bash
curl "https://api.telegram.org/bot$TOKEN/getWebhookInfo"
```

Expect `url` = your endpoint and `pending_update_count` at or near 0. If
`last_error_message` shows a 403, the secret in `setWebhook` and the secret in
the Lambda disagree — re-run `setWebhook`.

---

## 4. Test on a real phone

1. Open your bot, send `/start`.
   → Welcome text + a **📍 Share my location** button.
2. Tap the button and share the location.
   → "✅ Saved…" plus the **current reading** (AQI, tier, station, action plan)
     if a station is within 25 km.
   → Send `/start` again first if you want to check idempotency: you get the
     short welcome-back text and **no duplicate row**.
3. Send `/status` → the same reading on demand, recomputed.
4. Send `/stop` → "🔕 Alerts stopped."
5. Send anything else (`hello`) or `/help` → the command menu.

### Making the automatic alert fire on demand

You do not have to wait for the 30-minute schedule, and you do not have to hope
the air is bad. Run the scheduler by hand:

```bash
aws lambda invoke --region ap-south-1 \
  --function-name cleanair-fetch-evaluate-prod \
  --payload '{}' /dev/stdout
```

The response contains a `citizens` block:

```json
{"evaluated":0,"ok":0,"failed":0,
 "citizens":{"groups":1,"openAqFetches":1,"subscribers":1,
             "alertsSent":1,"blocked":0,"sendFailures":0}}
```

`alertsSent: 1` means your phone got an alert. Run it again immediately:
`alertsSent: 0` — that is the de-duplication working, because you have already
been told about this tier. Delete or change the subscriber's `lastAlertTier` in
`cleanair-subscribers-prod` if you want to see it fire again.

If `skippedGroups: 1` and nothing arrives, the station nearby was unreadable —
try `/start` with a location in a city with heavy sensor coverage (Delhi,
Mumbai, Bengaluru).

---

## 5. Test on your phone WITHOUT deploying

Telegram cannot reach `localhost`, so a webhook needs a public URL. You do not
need one for a live test: instead of a webhook, the runner below asks Telegram
for updates itself ("long polling") and feeds them through the **same** parser,
conversation flows, Bot API client and OpenAQ code the deployed Lambdas use.
Only the storage changes: DynamoDB becomes a JSON file at
`backend/.localstore/subscribers.json` (gitignored).

```bash
cd backend
npx tsx scripts/tg-local.ts            # then chat with the bot on your phone
```

It clears the webhook first (the API docs say polling and a webhook are mutually
exclusive), prints the bot's `@username`, and logs one line per update it handles.
Now send `/start` and tap **📍 Share my location** — you get real replies, with
real OpenAQ data. Then try `/status`, `/stop`, and any random text.

### See the automatic alert today, not in 30 minutes

In a second terminal, run exactly what the EventBridge schedule runs:

```bash
npx tsx scripts/tg-local.ts --fanout   # the alert job, once, for real
npx tsx scripts/tg-local.ts --store    # what got saved (locKey, active, tier)
npx tsx scripts/tg-local.ts --reset    # forget lastAlertTier so --fanout alerts again
```

The summary line tells you what happened. `alertsSent: 0` with subscribers > 0
means the air is not ORANGE/RED right now, or you were already told about the
current tier — that is the de-duplication working, and `--reset` is how you see
it fire again on demand.

The bot's own logic is also fully unit-tested (`npm test` — no AWS, no network,
no Telegram), so day-to-day the fast loop is the test suite, not the phone.

### Deploying later is still worth it

Polling is for testing. The deployed version is what gives you the automatic
30-minute checks with your laptop closed, so keep §2–§4 for that day.

### See the whole conversation without deploying anything

```bash
cd backend && npx tsx scripts/preview-bot.ts
```

This drives the real `lib/bot.ts` and `lib/fanout.ts` through fake deps and
prints, verbatim, every message a user would receive: `/start`, sharing a
location, a repeated `/start`, `/status`, `/stop`, free text, then two scheduler
runs showing three alerts going out and the second run staying silent. No AWS,
no OpenAQ, no bot token. Use it to proof-read the copy before a demo.

---

## What a subscriber row looks like

Table `cleanair-subscribers-<Stage>`, partition key `chatId` (string):

| Field | Meaning |
|---|---|
| `chatId` | the Telegram chat — the only identity we keep |
| `lat` / `lng` | the shared location |
| `locKey` | `lat,lng` snapped to a ~2 km grid; everyone in a cell shares one OpenAQ lookup |
| `active` | false after `/stop` |
| `blocked` | true once Telegram returns 403 (user blocked the bot) |
| `lastAlertTier` | the last tier we alerted them about (de-duplication) |
| `firstName` | for friendlier logs |
| `createdAt` / `updatedAt` | bookkeeping |

No phone numbers, no contacts, no message history.
