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
Everything is in `backend/template.yaml`. This is the whole deploy, start to
finish; every command below was run on this project before being written down.

### 2.1 Check the four prerequisites

```bash
aws sts get-caller-identity --profile mgmt   # -> arn:aws:iam::017731864609:user/hackathon-mgmt
aws configure get region --profile mgmt      # ap-south-1
sam.cmd --version                            # SAM CLI, version 1.x
node -v                                      # v20 or newer
```

- **Always pass `--profile mgmt` on this machine.** There are two credential
  sets in `~/.aws/credentials`, and they are not interchangeable:

  | profile | account | can it deploy? |
  |---|---|---|
  | `default` | 701364614914 | **no** — an SCP in the organisation denies CloudFormation, Lambda, DynamoDB, S3 and API Gateway writes, so `sam deploy` fails on its first call |
  | `mgmt` | 017731864609 (`hackathon-mgmt`, `AdministratorAccess`) | yes — the org's **management account** is exempt from SCPs |

  A bare `sam.cmd deploy` silently picks `default` and dies with `AccessDenied`.
  Every AWS/SAM command in this runbook therefore carries `--profile mgmt`.
- **On Windows, call `sam.cmd`, not `sam`.** Git Bash does not do Windows
  `PATHEXT` lookup, so a bare `sam` gives `sam: command not found` even when SAM
  CLI is installed. In PowerShell or `cmd` plain `sam` is fine.
- **`sam build` needs `esbuild` on `PATH`.** It is already a dev-dependency, so
  `npm run build` (which is `sam build`, run through npm, which puts
  `node_modules/.bin` on `PATH`) finds it. Plain `sam build` fails with
  *"Cannot find esbuild. esbuild must be installed on the host machine"* unless
  you export it first: `export PATH="$PWD/node_modules/.bin:$PATH"`.
- Docker Desktop only matters for `sam local invoke`. For deploying, the
  bundled `index.js` in `.aws-sam/build/` is all that is uploaded.

### 2.2 Get the three values into the shell

`.env` lives at the **repo root** (gitignored). Copy the tracked example once and
fill in the three values:

```bash
cp .env.example .env           # from the repo root, then edit it
cd backend                     # every deploy command below runs from here
set -a; source ../.env; set +a # nothing loads .env by itself; this exports it

# pre-flight: all three must print a length, not MISSING
for v in OPENAQ_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET; do
  eval "val=\$$v"; [ -n "$val" ] && echo "$v: ok" || echo "$v: MISSING"
done
```

If sourcing prints something like `../.env: line 3: MyPassword: command not
found`, that line is not a `KEY=value` pair — a pasted note or a raw AWS key
pair — and bash tried to run it as a command. Harmless for the three variables
above, but AWS access keys belong in `~/.aws/credentials` (`aws configure`),
which is where the CLI already reads them from; keeping extra copies in `.env`
only adds another place for them to leak.

| Parameter | Value |
|---|---|
| `OpenAQApiKey` | your OpenAQ key (NoEcho — never logged) |
| `TelegramBotToken` | the BotFather token |
| `TelegramWebhookSecret` | the random string from step 1.3 |
| `Stage` | `prod` (default) |

Never put AWS access keys in `.env`; the AWS CLI uses `aws configure`.
**Never put parameter values in `backend/samconfig.toml`.** `sam deploy --guided`
writes every answer you type into that file in plaintext, and it is (now)
gitignored for exactly that reason — an earlier version of it committed the
OpenAQ key. Pass secrets on the command line, not in a config file.

### 2.3 Build and deploy

```bash
npm test                # green before you deploy anything
npm run build           # = sam build; must print "Build Succeeded"

sam.cmd deploy --profile mgmt --region ap-south-1 \
  --parameter-overrides \
    OpenAQApiKey="$OPENAQ_API_KEY" \
    TelegramBotToken="$TELEGRAM_BOT_TOKEN" \
    TelegramWebhookSecret="$TELEGRAM_WEBHOOK_SECRET"
```

`backend/samconfig.toml` supplies the stack name (`clean-air-planner`), the
region (`ap-south-1`), `resolve_s3` (SAM creates its own artifact bucket),
`capabilities = CAPABILITY_IAM` (the Lambdas need execution roles) and
`confirm_changeset = false`, so the command above is all you type. Both Telegram
values are `NoEcho`, so they never appear in the deploy output or CloudWatch.

Resources this creates: 1 DynamoDB table (pay-per-request), 2 Lambdas, 1 HTTP
API, 1 EventBridge rule. Nothing bills hourly, and there is no email/SNS path
any more.

Read the stack outputs instead of copying by eye — you need **`WebhookUrl`**:

```bash
aws cloudformation describe-stacks --stack-name clean-air-planner \
  --region ap-south-1 --query "Stacks[0].Outputs" --output table
```

---

## 3. Point Telegram at your Lambda

```bash
set -a; source ../.env; set +a
URL=$(aws cloudformation describe-stacks --stack-name clean-air-planner --profile mgmt \
  --region ap-south-1 --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" \
  --output text)
echo "$URL"   # .../prod/telegram/webhook

curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=$URL" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","my_chat_member"]'
```

- `secret_token` makes Telegram send the header `X-Telegram-Bot-Api-Secret-Token`
  on every request; the Lambda rejects anything else with **403**.
- `allowed_updates` keeps the noise down: messages (commands, locations) plus
  `my_chat_member` so a block/unblock is visible.

Before deploying, validate the template. No AWS credentials needed:

```bash
cd backend && sam.cmd validate --region ap-south-1     # "is a valid SAM Template"
```

For deeper linting, `pip install cfn-lint` then
`cfn-lint --region ap-south-1 --template template.yaml`. Expect no `E####`
errors and one warning (`W2531`, the deprecated `nodejs20.x` runtime — see §6).
`backend/scripts/validate-template.mjs` is the offline stand-in that runs
without Python; it checks structure, not CloudFormation semantics.

Verify the webhook registration:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo"
```

Expect `url` = your endpoint and `pending_update_count` at or near 0. If
`last_error_message` shows a 403, the secret in `setWebhook` and the secret in
the Lambda disagree — re-run `setWebhook` with the right `secret_token`.

Two things to know before you keep polling locally: `setWebhook` and
`scripts/tg-local.ts` are mutually exclusive (the local runner calls
`deleteWebhook` first), so after a deploy stop using the local runner and test
on the phone instead.

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
aws lambda invoke --profile mgmt --region ap-south-1 \
  --function-name cleanair-fetch-evaluate-prod \
  --payload '{}' --cli-binary-format raw-in-base64-out out.json >/dev/null
cat out.json; rm -f out.json
```

Write to a file and `cat` it, as above. The tidier-looking `... --payload '{}'
/dev/stdout` **does not work on Windows**: the AWS CLI is a Windows program, so
it cannot open Git Bash's `/dev/stdout` and fails with `[Errno 2] No such file or
directory: '/dev/stdout'` (verified on this machine).

The response is a single `citizens` block — this is a real run:

```json
{"citizens":{"groups":1,"openAqFetches":1,"skippedGroups":0,"subscribers":1,
             "alertsSent":1,"blocked":0,"sendFailures":0}}
```

`alertsSent: 1` means your phone got an alert. Run it again immediately:
`alertsSent: 0` — that is the de-duplication working, because you have already
been told about this tier. Delete or change the subscriber's `lastAlertTier` in
`cleanair-subscribers-prod` if you want to see it fire again.

Read the other numbers when something looks wrong:

| Field | Meaning |
|---|---|
| `groups` | neighbourhoods (≈2 km cells) with at least one subscriber |
| `openAqFetches` | OpenAQ calls actually made — **one per group**, not per person |
| `skippedGroups` | groups whose station was unreadable this cycle; look for `fanout group fetch failed` in the logs. `HTTP 429` means OpenAQ's rate limit — normal if you have just run several checks by hand; wait a minute and retry |
| `sendFailures` | Telegram refused the message; the tier is deliberately **not** recorded, so the next run retries it |
| `blocked` | the user blocked the bot, so they are marked and never retried |

If `skippedGroups: 1` and nothing arrives, the station nearby was unreadable —
try `/start` with a location in a city with heavy sensor coverage (Delhi,
Mumbai, Bengaluru).

### Reading CloudWatch logs from Git Bash

A log group name starts with `/`, and Git Bash rewrites a leading `/` into a
Windows path, so this fails with `InvalidParameterException: Value at
'logGroupName' failed to satisfy constraint`:

```bash
aws logs describe-log-streams --profile mgmt --region ap-south-1 \
  --log-group-name /aws/lambda/cleanair-fetch-evaluate-prod --output text   # fails
```

Turn the rewrite off first (in the same shell):

```bash
export MSYS_NO_PATHCONV=1
aws logs describe-log-streams --profile mgmt --region ap-south-1 \
  --log-group-name /aws/lambda/cleanair-fetch-evaluate-prod \
  --order-by LastEventTime --descending --max-items 1 \
  --query "logStreams[0].logStreamName" --output text
```

Both Lambdas log one JSON line per decision (school-free citizen wording):
`{"msg":"fanout group done","locKey":"28.66,77.46","tier":"ORANGE","aqi":208,"members":1,"alerts":0,"skipped":0}`.
No secret is ever logged — the values are NoEcho and only lengths are visible.

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

## 6. Making it public (anyone can use it)

Nothing has to be "published". A Telegram bot is public the moment the webhook
is registered: anyone who opens it can `/start`, share a location and get their
own alerts. There is no account, no approval step and no dashboard to hand out.

What is worth doing before judges or users touch it:

1. **Get the link.** `curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"`
   returns the `username`; the public link is `https://t.me/<username>`
   (this project's is `https://t.me/VayuAQI_bot`).
2. **BotFather polish** — same chat as step 1.1: `/setdescription` (the long text
   on the empty chat), `/setabouttext` (the short one shown in the profile),
   `/setuserpic`, and `/setcommands` (already in step 1.4). A public bot with no
   description looks unfinished to a first-time user.
3. **Prove it is really public**: from a *different* Telegram account (a friend's
   phone), `/start` and share a location. They get their own reading and their own
   row — the table is keyed by `chatId`, so two people in the same neighbourhood
   share one OpenAQ lookup and never see each other's data.
4. **Set the $5 budget alarm** (PRD §13, still outstanding). Amount, unit and
   notification shape below come from
   `aws budgets create-budget --generate-cli-skeleton`:

   ```bash
   ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
   aws budgets create-budget --account-id "$ACCOUNT" \
     --budget '{"BudgetName":"clean-air-5usd","BudgetLimit":{"Amount":"5","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
     --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"you@example.com"}]}]'
   ```

   Replace the email with one you read. AWS Budgets is free for the first two
   budgets; email alerts only, so nothing bills hourly.
5. **Optional: cap the log noise.** Lambda log groups default to *never expire*.
   Logs are cheap but unbounded, so set a retention:

   ```bash
   aws logs put-retention-policy --region ap-south-1 \
     --log-group-name /aws/lambda/cleanair-telegram-webhook-prod \
     --retention-in-days 14
   ```

### Why "public" does not mean "expensive"

| Rail | Where |
|---|---|
| Throttling **10 rps / burst 20** on the HTTP API, so a spammer cannot run the bill up | `template.yaml`, `HttpApi.DefaultRouteSettings` |
| **One OpenAQ call per ~2 km cell** per 30-minute cycle, no matter how many people are in it | `runCitizenFanout` in `src/lib/fanout.ts` |
| DynamoDB **on-demand** and 1 table; the scheduler runs 48 times a day | `template.yaml` |
| A user who blocked the bot is marked `blocked` and never retried | `src/lib/fanout.ts` |
| Only the ~2 km cell is stored — no phone number, no contacts, no message history | see the row table below |

### One maintenance item to know about

The Lambda runtime is `nodejs20.x`, which AWS deprecated on **Apr 30, 2026**.
Deploying today still works; AWS blocks *new* functions on **Feb 1, 2027** and
*updates* on **Mar 3, 2027**. Changing `Runtime: nodejs20.x` to `nodejs22.x` in
`template.yaml` and redeploying is the whole fix (source is bundled by esbuild to
`es2022`, so nothing else changes), and it clears the `W2531` lint warning.

### Tear-down

```bash
sam.cmd delete --stack-name clean-air-planner --region ap-south-1
```

Then delete the SAM-managed artifact bucket (`aws-sam-cli-managed-default-samcli…`)
if you want the account byte-for-byte as you found it.

---

## 7. What is deployed right now (verified 2026-10-11)

Account **017731864609**, profile `mgmt`, region **ap-south-1**, stack
`clean-air-planner` = `CREATE_COMPLETE`:

| Resource | Name |
|---|---|
| DynamoDB table | `cleanair-subscribers-prod` (PAY_PER_REQUEST, key `chatId`) |
| Lambda — scheduler | `cleanair-fetch-evaluate-prod` |
| Lambda — webhook | `cleanair-telegram-webhook-prod` |
| HTTP API | `kt6cpfvh1j`, stage `prod`, throttling 10 rps / burst 20 |
| EventBridge rule | `cleanair-fetch-30min-prod`, `rate(30 minutes)`, `ENABLED` |
| SAM artifact bucket | `aws-sam-cli-managed-default-samclisourcebucket-o2blv6yrdvrm` |

Webhook: `https://kt6cpfvh1j.execute-api.ap-south-1.amazonaws.com/prod/telegram/webhook`
(`setWebhook` answered `ok: true`, `getWebhookInfo` shows this URL,
`pending_update_count: 0`). No NAT gateway, EC2 instance, RDS or load balancer
exists in the account — checked, not assumed.

What was actually run against the deployed stack (not simulated):

| Check | Result |
|---|---|
| `npm test` / `npm run typecheck` / `npm run build` | 124 passing / clean / "Build Succeeded" |
| OpenAQ key as deployed | PM2.5 80 µg/m³, "R K Puram, Delhi - DPCC" |
| `POST` webhook, no secret / wrong secret | **403** twice + log `{"msg":"telegram webhook rejected","reason":"bad secret"}` |
| `POST` webhook, correct secret, update with no message | **200** + `{"msg":"telegram update handled","intent":"ignored"...}` |
| `POST` webhook, correct secret, `/start` from a non-existent chat | **200**, `action: start.welcome.failed` — Telegram's 400 is logged, not a crash |
| Scheduler invoked by hand, no subscribers | `{"msg":"fanout summary","subscribers":0,"alertsSent":0}` |
| Scheduler with a **temporary** fixture row in Delhi (deleted afterwards) | `tier YELLOW, aqi 166`, no alert sent, table updated to `lastAlertTier = "YELLOW"` |
| Scheduler with the fixture moved to ORANGE air (Ghaziabad, deleted afterwards) | `tier ORANGE, aqi 208` → send attempted → Telegram rejected the fake chat → `sendFailures: 1`, and `lastAlertTier` stayed `NULL` so the next run retries |
| Cleanup | fixture row deleted, `scan` count back to **0**, no temp files left in the repo |
| Least privilege | each Lambda's only inline policy is SAM's `DynamoDBCrudPolicy` scoped to that one table ARN |

Two caveats found while verifying:

- **Do not trust `aws iam simulate-principal-policy` in this account.** For these
  roles it reports `explicitDeny` on the very DynamoDB actions the Lambdas
  demonstrably perform (the org's SCPs are evaluated even though the management
  account is exempt from them). The inline policy documents and the CloudWatch
  evidence are the truth.
- **The runtime warning is real.** CloudWatch prints
  `NodeVersionSupportWarning: The AWS SDK for JavaScript (v3) versions published
  after the first week of January 2027 will require node >=22. You are running
  node v20.20.2.` See §6 — the `nodejs22.x` change clears it.

Still unverified: a message reaching a **real** chat. That needs §4 on your
phone (`/start` → share location → `/status`), and it is the only way to see
`alertsSent: 1` turn into an actual Telegram alert.

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
