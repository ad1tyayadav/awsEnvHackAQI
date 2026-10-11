# PROGRESS.md — Clean Air Day-Planner for Schools

> Agent-maintained task checklist. Each task ≤ ~30 min, touches few files, and has a concrete verification step.

---

## Phase 0: Setup (human-driven)

- [ ] 0.1 Verify student status on AWS Builder Center (Verify by: confirmation page / screenshot)
- [ ] 0.2 Create AWS account, claim free credits, set AWS Budgets alert at $5 (Verify by: Budgets console shows the alarm)
- [ ] 0.3 Install AWS CLI, SAM CLI, Node 20, Git (Verify by: `aws --version`, `sam --version`, `node -v`, `git --version` all print versions)
- [ ] 0.4 Run `aws configure` with region `ap-south-1` (Verify by: `aws sts get-caller-identity` returns your account ID)
- [ ] 0.5 Create a free OpenAQ account and generate an API key (Verify by: `curl -H "X-API-Key: <key>" https://api.openaq.org/v3/locations?limit=1` returns 200)
- [ ] 0.6 Create the GitHub repo; push `PRD.md`, `AGENTS.md`, and this `PROGRESS.md` to main (Verify by: files visible on GitHub)

---

## Phase 1: Backend foundation

**Goal:** A deployable SAM project with all four DynamoDB tables and a placeholder Lambda.

- [ ] 1.1 Scaffold `/backend` folder structure: `src/lib/`, `src/functions/fetchAndEvaluate/`, `src/functions/api/`, `src/tests/`, `events/` (Verify by: `ls -R backend/src` shows the directory tree)
- [ ] 1.2 Create `backend/package.json` with TypeScript, Vitest, AWS SDK v3, esbuild dev-dependencies; create `backend/tsconfig.json` with strict mode (Verify by: `cd backend && npm install` succeeds with no errors)
- [ ] 1.3 Add `backend/.gitignore` covering `node_modules/`, `.aws-sam/`, `.env*`, `dist/`, `out/` (Verify by: `cat backend/.gitignore` lists all entries)
- [ ] 1.4 Write `backend/template.yaml` (SAM) — define the four DynamoDB tables: SchoolsTable (PK `schoolId`), ReadingsTable (PK `schoolId`, SK `ts`, TTL on `ttl`), AdvisoryCacheTable (PK `key`), AlertsTable (PK `schoolId`, SK `ts`). All on-demand billing, region `ap-south-1` (Verify by: `sam validate` passes)
- [ ] 1.5 Add a placeholder `fetchAndEvaluate` Lambda in the SAM template (Node 20, TypeScript, esbuild build method). Pass all four table names as environment variables. Write a minimal `src/functions/fetchAndEvaluate/index.ts` handler that logs "placeholder" and returns 200 (Verify by: `sam build` succeeds)
- [ ] 1.6 Create a sample event file `events/fetchAndEvaluate.json` (empty `{}` or EventBridge-shaped). Test locally (Verify by: `sam local invoke FetchAndEvaluateFunction -e events/fetchAndEvaluate.json` returns 200 with the placeholder log)
- [ ] 1.7 Add a trivial Vitest test in `src/tests/placeholder.test.ts` that asserts `1 + 1 === 2`, and add a `"test"` npm script (Verify by: `npm test` passes with 1 test)
- [ ] 1.8 Deploy with `sam deploy --guided` (stack name `clean-air-planner`, region `ap-south-1`, allow SAM to create roles). Verify all four tables exist (Verify by: `aws dynamodb list-tables --region ap-south-1` includes the four table names)
- [ ] 1.9 Git commit: `phase-1: backend foundation with SAM template, 4 DynamoDB tables, placeholder Lambda` (Verify by: `git log -1` shows the commit)

**Phase 1 gate:** `sam build && sam deploy` succeeds, four tables visible in DynamoDB console, `sam local invoke` runs the placeholder, `npm test` passes.

---

## Phase 2: AQI fetch and storage

**Goal:** Given a lat/lng, fetch the nearest PM2.5 reading from OpenAQ and store it.

- [ ] 2.1 Read OpenAQ v3 API docs; confirm which endpoints to use for nearest-station PM2.5 lookup; summarise the request/response shape to the developer (Verify by: summary shown to user with endpoint URLs and example response)
- [ ] 2.2 Write `src/lib/openaq.ts` — `fetchNearestPM25(lat, lng, apiKey)` that calls the chosen OpenAQ v3 endpoint with the `X-API-Key` header, returns `{ pm25, stationName, stationId, measuredAt }`. Handle: no station nearby, stale data (>3 hrs old), API errors, timeouts. Each error returns a clear message (Verify by: unit test with mocked HTTP response passes)
- [ ] 2.3 Write unit test `src/tests/openaq.test.ts` — mock HTTP calls, test: success case, no-station-nearby, stale data, API error, timeout (Verify by: `npm test -- openaq` all pass)
- [ ] 2.4 Write `src/lib/db.ts` — helpers: `putReading(reading)`, `getRecentReadings(schoolId, hours=24)`, `getAllSchools()`, `getSchool(schoolId)`, `putSchool(school)`. Use AWS SDK v3 DynamoDB DocumentClient. Read table names from environment variables (Verify by: file compiles with `npx tsc --noEmit`)
- [ ] 2.5 Write unit test `src/tests/db.test.ts` — mock DynamoDB calls, test `putReading` and `getRecentReadings` (Verify by: `npm test -- db` passes)
- [ ] 2.6 Update `src/functions/fetchAndEvaluate/index.ts` — load all schools, for each: call `fetchNearestPM25`, store reading with `putReading` (fields: `schoolId, ts, pm25, source: "openaq", stationName`). AQI/tier are not computed yet. Add the OpenAQ API key as a NoEcho parameter in `template.yaml` and pass it as a Lambda env var (Verify by: `sam build` succeeds, `sam validate` passes)
- [ ] 2.7 Create a sample event, manually insert a test school row into SchoolsTable (e.g. Delhi, lat 28.6, lng 77.2), then invoke the Lambda locally or deployed. Confirm a real PM2.5 reading appears in ReadingsTable (Verify by: `aws dynamodb scan --table-name <ReadingsTable>` shows a row with `pm25` and `source: "openaq"`)
- [ ] 2.8 Git commit: `phase-2: OpenAQ fetch, db helpers, fetchAndEvaluate stores readings` (Verify by: `git log -1`)

**Phase 2 gate:** One school row exists, Lambda runs (local or deployed), a real PM2.5 reading is in ReadingsTable, mocked unit tests pass.

---

## Phase 3: AQI and advisory engine

**Goal:** Pure, well-tested logic that turns PM2.5 into AQI, category, tier, and advisory text.

- [ ] 3.1 Write `src/lib/aqi.ts` — `pm25ToAqi(pm25): { aqi: number, category: string }` using CPCB PM2.5 breakpoints from PRD §6 with linear interpolation inside each band. Handle: pm25 = 0, band edges (30, 31, 60, 61, 90, 91, 120, 121, 250, 251), values above 250 (cap AQI at 500). No AWS calls (Verify by: file compiles with `npx tsc --noEmit`)
- [ ] 3.2 Write thorough unit tests `src/tests/aqi.test.ts` — test every band edge, interpolation midpoints (e.g. PM2.5 = 45 → AQI ≈ 75), pm25 = 0, pm25 = 300 (cap), negative input (Verify by: `npm test -- aqi` all pass)
- [ ] 3.3 Write `src/lib/tiers.ts` — `aqiToTier(aqi): "GREEN" | "YELLOW" | "ORANGE" | "RED"` using PRD §6 ranges; `shouldAlert(previousTier, newTier): boolean` implementing the dedupe rule: alert only when newTier is ORANGE or RED **and** differs from (or is higher than) previousTier. No AWS calls (Verify by: file compiles)
- [ ] 3.4 Write unit tests `src/tests/tiers.test.ts` — test every AQI→tier boundary (0, 50, 51, 100, 101, 200, 201, 300, 301, 500); test shouldAlert for all tier transitions (GREEN→GREEN, GREEN→ORANGE, ORANGE→RED, RED→RED, RED→GREEN, etc.) (Verify by: `npm test -- tiers` all pass)
- [ ] 3.5 Write `src/lib/advisory.ts` — `getAdvisoryText(tier): string` returning the English action-plan text from PRD §6 for each tier. Pure function, no AWS calls (Verify by: file compiles, quick manual check)
- [ ] 3.6 Write unit test `src/tests/advisory.test.ts` — test that each tier returns the correct English text and that an invalid tier throws (Verify by: `npm test -- advisory` passes)
- [ ] 3.7 Update `fetchAndEvaluate` handler to compute `aqi`, `category`, and `tier` on each reading using the new pure functions, and store them in the reading record (Verify by: `sam build` succeeds)
- [ ] 3.8 Deploy and invoke (or `sam local invoke`). Confirm readings in DynamoDB now include `aqi`, `category`, `tier` fields (Verify by: `aws dynamodb scan --table-name <ReadingsTable>` shows new fields)
- [ ] 3.9 Git commit: `phase-3: AQI calculation, tier mapping, advisory text with full tests` (Verify by: `git log -1`)

**Phase 3 gate:** All unit tests pass (band edges, interpolation, tier transitions, dedupe). Readings in DynamoDB include `aqi`, `category`, `tier`. Developer reviews advisory wording.

---

## Phase 4: Hindi advisories and email alerts

**Goal:** On a tier rise to ORANGE or RED, send an English + Hindi email alert via SNS.

- [ ] 4.1 Extend `src/lib/advisory.ts` — add `getAdvisory(tier, lang)`: for `"en"` return the English text; for `"hi"`, check AdvisoryCacheTable first, on cache miss call Amazon Translate (en→hi), store result in cache, return it. If Translate fails, fall back to English and log error (Verify by: file compiles)
- [ ] 4.2 Write unit test `src/tests/advisory-translate.test.ts` — mock DynamoDB cache and Translate SDK: test cache hit, cache miss → translate → store, Translate failure → English fallback (Verify by: `npm test -- advisory-translate` passes)
- [ ] 4.3 Add an SNS topic (`AirAlertsTopic`) to `template.yaml` with least-privilege publish permissions for the Lambda. Pass the topic ARN as a Lambda env var (Verify by: `sam validate` passes)
- [ ] 4.4 Write `src/lib/alerts.ts` — `formatAlertEmail(school, tier, aqi, advisoryEn, advisoryHi): { subject, body }` using the format from PRD §4 (subject: "Air alert: <School> is <TIER> (AQI <n>)", body: English plan + Hindi plan + disclaimer). Also: `subscribeEmail(topicArn, email, schoolId)` that subscribes an email with a filter policy on `schoolId` attribute, and `publishAlert(topicArn, schoolId, subject, body)` that publishes with the `schoolId` message attribute (Verify by: file compiles)
- [ ] 4.5 Write unit test `src/tests/alerts.test.ts` — test email formatting (subject, body contains both languages, disclaimer); mock SNS subscribe and publish (Verify by: `npm test -- alerts` passes)
- [ ] 4.6 Write `src/lib/db.ts` additions — `putAlert(alert)` to write a row to AlertsTable; `updateSchoolLastAlertTier(schoolId, tier)` to update the school's `lastAlertTier` (Verify by: file compiles)
- [ ] 4.7 Update `fetchAndEvaluate` — after computing tier, call `shouldAlert(school.lastAlertTier, newTier)`. If true: get advisory in both languages, format the email, publish to SNS with the `schoolId` attribute, write to AlertsTable, update `lastAlertTier`. Always update `lastAlertTier` after each evaluation regardless of alert (Verify by: `sam build` succeeds)
- [ ] 4.8 Deploy. Subscribe your own email to the SNS topic (manually or via a test script). Confirm the subscription. Manually insert a school, invoke the Lambda with a high-PM2.5 scenario (or use a city with bad AQI). Confirm email arrives with English + Hindi text (Verify by: email received in inbox with correct subject and bilingual body)
- [ ] 4.9 Verify dedupe: invoke the Lambda again with the same high tier. Confirm **no** second email is sent (Verify by: no new email; AlertsTable has only one row for that tier)
- [ ] 4.10 Git commit: `phase-4: Hindi translation, SNS email alerts with dedupe` (Verify by: `git log -1`)

**Phase 4 gate:** Email arrives once per tier rise (not repeatedly) with correct Hindi text. Translate cache is populated in AdvisoryCacheTable. `shouldAlert` dedupe works.

---

## Phase 5: Scheduler and API

**Goal:** Everything runs automatically via EventBridge, and the dashboard has a REST API.

- [ ] 5.1 Add an EventBridge rule (every 30 minutes) in `template.yaml` targeting the `fetchAndEvaluate` Lambda (Verify by: `sam validate` passes; rule visible in template)
- [ ] 5.2 Refactor the evaluate-and-alert logic out of `fetchAndEvaluate` handler into a shared function `evaluateSchool(school, pm25, source, stationName)` in `src/lib/evaluate.ts` so both the scheduler and simulate endpoint can call it without duplicating logic (Verify by: `sam build` succeeds, existing tests still pass)
- [ ] 5.3 Add the `api` Lambda and HTTP API (API Gateway) to `template.yaml` — CORS enabled for `*` (tighten to Amplify domain later), throttling 10 rps / burst 20. Pass all table names, SNS topic ARN, and OpenAQ key as env vars. Least-privilege IAM (Verify by: `sam validate` passes)
- [ ] 5.4 Implement `POST /schools` in `src/functions/api/index.ts` — validate input (name, city, lat ∈ [-90,90], lng ∈ [-180,180], contactEmails[] max 5, valid email format), create school in SchoolsTable, subscribe each email to SNS with filter policy on `schoolId`, return created school with 201. Return 400 with clear message on bad input (Verify by: `sam build` succeeds)
- [ ] 5.5 Implement `GET /schools` — return list of all schools with their `lastAlertTier` (Verify by: `sam build` succeeds)
- [ ] 5.6 Implement `GET /schools/{id}/status` — return `{ school, latest: { pm25, aqi, category, tier, ts, source, stationName }, advisory: { en, hi }, history: [last 24 readings] }`. Return 404 if school not found (Verify by: `sam build` succeeds)
- [ ] 5.7 Implement `POST /schools/{id}/simulate` — accept `{ tier: "RED" }` or `{ pm25: 180 }`. If tier is given, map it to a representative PM2.5 value. Create a reading with `source: "simulated"`, then call the shared `evaluateSchool` function. Return the new status. Return 404 if school not found, 400 on bad input (Verify by: `sam build` succeeds)
- [ ] 5.8 Add input validation helper and consistent error-response format (`{ error: string, statusCode: number }`) used by all endpoints (Verify by: file compiles)
- [ ] 5.9 Write unit tests `src/tests/api.test.ts` — test validation (bad lat, missing name, too many emails, invalid email), 404 for missing school, happy paths for each endpoint with mocked DB/SNS (Verify by: `npm test -- api` passes)
- [ ] 5.10 Deploy. Test all endpoints with curl:
  - `curl -X POST .../schools -d '{"name":"Test School","city":"Delhi","lat":28.6,"lng":77.2,"contactEmails":["you@example.com"]}'`
  - `curl .../schools`
  - `curl .../schools/<id>/status`
  - `curl -X POST .../schools/<id>/simulate -d '{"tier":"RED"}'`
  (Verify by: all return correct JSON; simulate RED triggers an email)
- [ ] 5.11 Verify EventBridge schedule is active — check that readings appear automatically every 30 minutes (Verify by: `aws events list-rules --region ap-south-1` shows the rule; after 30 min a new reading appears in ReadingsTable, or check CloudWatch logs)
- [ ] 5.12 Git commit: `phase-5: EventBridge scheduler, API Gateway with 4 endpoints, shared evaluate logic` (Verify by: `git log -1`)

**Phase 5 gate:** All four endpoints work via curl against deployed URL. Simulate RED triggers email. EventBridge schedule produces readings on its own.

---

## Phase 6: Dashboard

**Goal:** One clean, mobile-friendly page a non-technical principal can use.

- [ ] 6.1 Scaffold `/frontend` with Next.js (static export, `output: 'export'`), TypeScript, and Tailwind. Configure `NEXT_PUBLIC_API_URL` env var. Add `.gitignore` for `.next/`, `out/`, `node_modules/` (Verify by: `npm run dev` starts locally with the default Next.js page)
- [ ] 6.2 Build the page layout and design system — header with app title and tagline, responsive container, color tokens for tier badges (GREEN, YELLOW, ORANGE, RED), typography. Accessible: labels + color for tier indicators (Verify by: page renders locally with styled header)
- [ ] 6.3 Add School form component — fields: name, city, lat, lng, emails (comma-separated). Client-side validation matching API rules. Note about email confirmation. Calls `POST /schools`. Show success/error feedback (Verify by: form renders, submitting with valid data against the API creates a school)
- [ ] 6.4 School list component — fetches `GET /schools`, displays school name, city, and a colored tier badge with label. Auto-refreshes or has a refresh button (Verify by: schools appear in the list after adding one)
- [ ] 6.5 School detail / status panel — selecting a school calls `GET /schools/{id}/status`, displays: AQI (large number), category, tier badge, source (live/simulated), station name, last-updated time. Loading and error states (Verify by: selecting a school shows its current status)
- [ ] 6.6 Advisory text with English/Hindi toggle — displays the action plan for the current tier. A toggle button switches between English and Hindi text from the API response (Verify by: clicking toggle swaps the advisory language)
- [ ] 6.7 Last-24-readings trend — display the history array as a simple list or lightweight chart (e.g. a CSS bar chart or a small canvas chart). Show timestamp, AQI, and tier for each reading (Verify by: trend data visible for a school with multiple readings)
- [ ] 6.8 "Simulate severe day" button — prominent button that calls `POST /schools/{id}/simulate` with `{ tier: "RED" }`. Shows a loading spinner, then refreshes the status panel. Confirm the email arrives (Verify by: clicking the button flips status to RED, email received)
- [ ] 6.9 Empty, loading, and error states — show a spinner while fetching, a friendly message when no schools exist yet, and an error banner if the API is unreachable (Verify by: test each state by disconnecting API / empty DB / slow network)
- [ ] 6.10 Guidance disclaimer — footer note: "Advisories are guidance based on hourly PM2.5 estimates and do not replace official orders from local authorities." (Verify by: visible on page)
- [ ] 6.11 Mobile-responsive pass — test on a narrow viewport (~375px). Large readable text, stacked layout, touch-friendly buttons (Verify by: Chrome DevTools mobile emulation looks good)
- [ ] 6.12 Full demo flow test — run through PRD §4 locally: add school → see AQI → simulate severe → email arrives → status is RED → Hindi toggle works (Verify by: all steps succeed end-to-end)
- [ ] 6.13 Git commit: `phase-6: Next.js dashboard with full demo flow` (Verify by: `git log -1`)

**Phase 6 gate:** Full demo flow (PRD §4) works locally against the deployed API. Works on mobile.

---

## Phase 7: Deploy, polish, README, demo script

**Goal:** Public URL works, repo is clean, README is complete, demo script is ready.

- [ ] 7.1 Deploy `/frontend` to AWS Amplify Hosting — set `NEXT_PUBLIC_API_URL` as an Amplify env var, configure build settings for static export. Document the exact steps (Verify by: public Amplify URL loads the dashboard)
- [ ] 7.2 Update CORS in `template.yaml` to allow only the Amplify domain (instead of `*`). Redeploy backend (Verify by: dashboard on Amplify can still call the API; random origin is blocked)
- [ ] 7.3 Full demo flow on the public Amplify URL — add school, see AQI, simulate, receive email, toggle Hindi (Verify by: all steps succeed on the public URL)
- [ ] 7.4 Test on a real phone — open the Amplify URL on a mobile device (Verify by: layout is usable, text is readable, buttons are tappable)
- [ ] 7.5 Write `README.md` — sections: Problem, Solution, Screenshot placeholders, Architecture diagram (Mermaid), AWS services table (service + why), How to Run Locally, How to Deploy, Cost Notes, Honesty Note (hourly PM2.5 vs 24-hr average), Future Scope (Bedrock wording, Polly voice, heatwave Track 02, district dashboard) (Verify by: README renders correctly on GitHub)
- [ ] 7.6 Security review — scan repo for leaked secrets, API keys, `.env` files. Ensure `.gitignore` covers everything. Check git history for accidental commits (Verify by: `git log --all -p | grep -i "apikey\|secret\|password"` returns nothing sensitive)
- [ ] 7.7 Code cleanup — remove unused imports, commented-out code, console.logs that aren't meaningful. Ensure all files have brief top-of-file comments explaining purpose (Verify by: quick scan of `src/` directory)
- [ ] 7.8 Create `docs/DEMO_SCRIPT.md` from PRD §13 — the 3-minute demo video script with timing, what to show, and setup notes (Verify by: file exists and matches PRD §13 structure)
- [ ] 7.9 Git commit: `phase-7: README, Amplify deploy, demo script, cleanup` (Verify by: `git log -1`)

**Phase 7 gate:** A stranger can open the public URL and complete the demo flow. README is complete. No secrets in git. Demo script is ready.

---

## Phase 8 (Stretch): "All clear" email

**Goal:** Send a recovery email when tier drops back to GREEN or YELLOW. NOTE: Phase 8 and 9 below remain stretch scope; Phase 8 stays open — but the NEW phases (Telegram bot + AI layer) take priority and are ordered after Phase 9 and before Phase 10 (Bedrock wording), which is REPLACED.

- [ ] 8.1 Add `shouldSendAllClear(previousTier, newTier): boolean` to `tiers.ts` — returns true when previous was ORANGE/RED and new is GREEN/YELLOW (Verify by: unit test passes)
- [ ] 8.2 Add "all clear" email template in `alerts.ts` — subject: "All clear: <School> is now <TIER>", body: good news message in English + Hindi (Verify by: unit test passes)
- [ ] 8.3 Update `evaluateSchool` to check `shouldSendAllClear` and publish the recovery email via SNS (Verify by: simulate RED → then simulate GREEN → "all clear" email arrives)
- [ ] 8.4 Git commit: `phase-8: all-clear recovery email` (Verify by: `git log -1`)

---

## Phase 9 (new, P0): Telegram bot — citizen-first registration, commands, webhook

**Goal:** ANY person clicks /start, picks a language, shares their location ONCE — and from that moment they are done: everything else (alerts, /status, Q&A, /explain) happens in chat. A school deep link is an optional extra for parents, not the main path.

- [x] 9.1 Create the bot with @BotFather; get the token and a random webhook secret. NoEcho SAM params `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (Verify by: so far only template.yaml edit; `sam validate` passes) — SAM CLI absent here, verified with `node scripts/validate-template.mjs` (YAML parses, NoEcho params present, core resources intact) + all 44 unit tests still pass. BotFather creation is a human step; developer must run `/newbot` and supply the token + secret at deploy time.
- [x] 9.2 Add `telegramWebhook` Lambda + API route `/telegram/webhook`; validate `X-Telegram-Bot-Api-Secret-Token` header, return 403 on mismatch, 200 otherwise (Verify by: unit tests for both header cases; `sam build` passes) — verified with `npm test` (52 passing, 8 new webhook tests incl. case-insensitive header, wrong/empty/missing header, unconfigured secret) + `npm run typecheck` + `node scripts/validate-template.mjs`. `sam build` N/A: SAM CLI not installed on this machine.
- [x] 9.3 Update parser in `telegram.ts`: extract /start payload (school_<id> deep link), commands, callback_query (language buttons), location message, plain text (Verify by: unit test on sample Update fixtures per current Bot API docs) — `src/lib/telegram.ts` + 11 tests on Bot API-shaped Update fixtures; invalid/malformed updates return `ignored` instead of throwing. Verified: `npm test` 63 passing, `npm run typecheck` clean.
- [~] 9.4–9.9 SUPERSEDED by **Phase 9R** below (scope changed to citizen-only, English-only, no schools).

**Phase 9 gate (citizen-first):** on a phone: /start -> language -> share location -> /status reply — and that is ALL a citizen ever needs to do. Deep link subscribes a follower to a school; wrong secret token returns 403. Re-registering the same chat never duplicates.

---

## Phase 9R (APPROVED REDIRECT): Telegram bot ONLY — citizen air-alert bot, no schools

> Scope note (2026-10-11): the bot asks for a location and nothing else. English-only copy, so
> `/language` and `advisoryI18n` Hindi are out of the user journey; alerts fire on ORANGE and RED.

**Developer decision (2026-10-11):** the product is now JUST the bot. A user does `/start` and shares
location ONCE. From then on the bot messages them automatically when the air goes bad for their area,
and they can ask for a reading manually any time. Decisions: **English only** (no language buttons),
**alert on ORANGE and RED**, and the **school dashboard + email code is REMOVED** (task 9R.10).

**Kept from 9.1–9.3:** NoEcho bot params, `telegramWebhook` Lambda + secret-header gate, `parseUpdate`.

**The whole user journey:** `/start` -> share location -> done. Then: auto alert on ORANGE/RED rise, `/status` on demand, `/stop` to go quiet.

- [x] 9R.1 `telegram.ts` Bot API client: `sendMessage` (plain text, 4096-char split), location-request reply keyboard, error mapping (403 -> blocked, 429 -> respect `retry_after`), all calls through an injectable `fetch` (Verify by: unit tests with mocked fetch — normal send, 403, 429 retry, long-message split) — `createTgClient(token, {fetchLike,sleep})`, `splitMessage`, `locationKeyboard`; 14 new tests in `src/tests/telegramClient.test.ts`, `npm test` 77 passing, `npm run typecheck` clean. No `parse_mode` sent on purpose, so station names can never break a send; a 429 only waits when `retry_after` <= 30s so a Lambda is never held open.
- [x] 9R.2 Add `SubscribersTable` (PK `chatId`, on-demand) to `template.yaml` + pass `SUBSCRIBERS_TABLE` to the webhook and scheduler Lambdas (Verify by: `node scripts/validate-template.mjs` OK) — added `cleanair-subscribers-${Stage}` + `SUBSCRIBERS_TABLE` with a least-privilege `DynamoDBCrudPolicy` on the two Lambdas that need it (api intentionally excluded, it is removed in 9R.10). Verified: `node scripts/validate-template.mjs` -> `template.yaml OK`; grep confirms the table, the env var on FetchAndEvaluate + TelegramWebhook, and no access for ApiFunction.
- [x] 9R.3 `subscribers.ts` data access: upsert citizen (chatId, lat, lng, locKey, active, blocked, lastAlertTier), get by chatId, list all ACTIVE, group by locKey, mark blocked, unsubscribe/reactivate (Verify by: unit tests with mocked DocumentClient) — 16 tests in `src/tests/subscribers.test.ts`; `locKeyFor` snaps coordinates to a 0.02 deg (~2 km) grid (guards the "-0.00" key split), `listActiveCitizens` paginates, grouping is a pure exported function so 9R.7 can test one-OpenAQ-fetch-per-group. Verified: `npm test` 93 passing, `npm run typecheck` clean.
- [x] 9R.4 `/start` flow: welcome + "share my location" button; save location on receipt; confirm; re-running `/start` UPDATES, never duplicates (Verify by: unit tests on fixture Updates, incl. `/start` twice) — new `src/lib/bot.ts` (all side effects injected via `BotDeps`, so its 12 tests use plain fakes) + `telegramWebhook/index.ts` now parses and routes; `/start` writes nothing at all, which is what makes it idempotent, and a returning user gets a short welcome-back. Parser now carries `firstName` into the location intent. Verified: `npm test` 112 passing (15 files), `npm run typecheck` clean. NOTE: the "show current reading" half of the confirm is deliberately deferred to 9R.5 where the OpenAQ call is introduced.
- [x] 9R.5 `/status`: nearest PM2.5 via existing `fetchNearestPM25` + pure AQI/tier code -> reply with AQI, tier, station name and the English action plan (Verify by: unit tests with mocked OpenAQ, incl. no-location and no-station cases) — `handleStatus` + pure `formatAirReport` (AQI/tier via the same `pm25ToAqi`/`aqiToTier` as the scheduler, advisory via `getAdvisoryText`, no Translate needed for English-only); distinct sentences for no-location / no-station / stale-station / service-down. The location confirmation now also shows the current reading, and if OpenAQ is down the sign-up still succeeds. Verified: `npm test` 122 passing, `npm run typecheck` clean.
- [ ] 9R.6 `/stop` marks inactive and `/start` re-activates; clear error text when no station is within range or location is missing (Verify by: unit tests)
- [x] 9R.7 Scheduler fan-out: `fetchAndEvaluate` loops distinct citizen `locKey` groups, fetches OpenAQ ONCE per group, evaluates with the shared pipeline, sends each subscriber an alert only on an ORANGE/RED rise (per-subscriber `lastAlertTier` dedupe) (Verify by: unit test — 3 citizens sharing a locKey -> exactly 1 OpenAQ fetch, 3 sends, no repeat on the second run) — new pure-ish `src/lib/fanout.ts` (`runCitizenFanout`, all deps injected) + `formatAlert` in `bot.ts`; one failure never stops the other neighbourhoods, a blocked user is marked and not counted as alerted, and a transient send failure deliberately leaves `lastAlertTier` unset so the alert is retried instead of lost. Wired into the scheduler next to the existing school loop (the school half is deleted in 9R.10). Verified: `npm test` 141 passing (11 new), `npm run typecheck` clean, `node scripts/validate-template.mjs` OK.
- [~] 9R.8 setWebhook runbook in `docs/TELEGRAM_BOT.md` (secret_token, allowed_updates, deleteWebhook for local dev) + live phone test (Verify by: register on a real phone and receive the `/status` reply)
  - [x] Runbook written: BotFather steps, `sam deploy --parameter-overrides`, the `setWebhook` curl (with `secret_token` + `allowed_updates`), `getWebhookInfo` check, the phone test script, and how to force the automatic alert with `aws lambda invoke` on the scheduler (no waiting 30 minutes).
  - [ ] BLOCKED ON THE DEVELOPER: the live phone test itself. It needs a real bot token, an AWS deploy and a real chat — the agent cannot do any of those. Task cannot be ticked until a phone receives the `/status` reply.
- [x] 9R.9 Git commit: `phase-9r: citizen telegram bot with automatic air alerts` (Verify by: `git log -1`) — committed incrementally per task (9R.1 a5fa134 ... 9R.8 5da5a95). Added `backend/scripts/preview-bot.ts`: a no-AWS, no-network dry run that prints every message a user would get and two scheduler runs, so the copy and the de-duplication can be reviewed without a deploy (`npx tsx scripts/preview-bot.ts` -> 3 alerts then 0). Full gate at this point: `npm test` 141 passing / 16 files, `npm run typecheck` clean, `node scripts/validate-template.mjs` OK.
- [ ] 9R.10 REMOVE the school product surface now that the bot is the whole product: delete `frontend/`, the `api` Lambda + its route/tests, school/readings/advisory/alerts tables, the SNS topic + email code, and the Amazon Translate path; rewrite README + demo docs for the bot (Verify by: `npm test` green on the remaining tests, `node scripts/validate-template.mjs` OK, `git grep -i "school"` shows only intentional leftovers)
- [ ] 9R.11 Git commit: `phase-9r: remove school dashboard and email surface` (Verify by: `git log -1`)

**Phase 9R gate:** on a phone: `/start` -> share location -> `/status` replies with AQI + tier + action plan -> simulate a RED rise -> the bot messages the user automatically, exactly once. Wrong webhook secret returns 403. `/stop` goes quiet, `/start` resumes.

> Supersedes task 9.8 (deep link) — there are no schools to follow any more.

---

## Phase 9 (Stretch → superseded): Telegram alerts (old school-chat-id list)

> Superseded by the new Phase 9 and Phase 10 above (Subscribers table with citizen / school-follower types instead of a single school chat ID). Kept here for history.

**Goal (original):** Send alerts via a Telegram bot in addition to email.

**Goal:** Send alerts via a Telegram bot in addition to email.

- [ ] 9.1 Write `src/lib/telegram.ts` — function to send a message via the Telegram Bot API. Bot token stored as a Lambda env var via NoEcho SAM parameter (Verify by: file compiles)
- [ ] 9.2 Add Telegram chat ID to the school model (optional field). Update `POST /schools` to accept it (Verify by: API accepts the new field)
- [ ] 9.3 Update `evaluateSchool` to send Telegram alert alongside email when the school has a chat ID configured (Verify by: simulate RED → Telegram message received)
- [ ] 9.4 Git commit: `phase-9: Telegram bot alerts` (Verify by: `git log -1`)

---

## Phase 10 — REPLACED (was: Bedrock wording)

> Bedrock is REMOVED from the project plan. Replaced by the new Phase 10: Telegram bot alert fan-out and Phase 11 AI layer (Hugging Face) — see the phases added below. F9 now lives in the new Phase 9 (full bot: registration, language, location). The school-only chat-ID list approach is superseded by the Subscribers table with citizen and school-follower types.

---

## Phase 10 (SUPERSEDED by Phase 9R): Telegram alert fan-out — citizen-first monitoring

> **Superseded (2026-10-11).** The fan-out now lives in Phase 9R task 9R.7 (citizen locKey groups only).
> Phase 10's school-follower half (10.1/10.6) and the deep-link work are dropped with the school surface.
> The Subscribers table (10.1), the Bot API client (10.2), `subscribers.ts` (10.3) and the fan-out (10.5)
> are delivered earlier as 9R.1–9R.3 and 9R.7. Keep the tasks below only as reference for the email path.

**Goal:** Citizen locations are FIRST-CLASS: the scheduler monitors registered schools AND distinct citizen locKey groups; on a tier rise every matched subscriber gets a Telegram alert (dedupe per subscriber). OpenAQ is called once per group, not once per person.

- [ ] 10.1 Add SubscribersTable to `template.yaml` (PK chatId) and pass its name as env var to fetchAndEvaluate, api and the new telegramWebhook Lambdas (Verify by: `sam validate` passes)
- [ ] 10.2 Add `telegram.ts` Bot API client (sendMessage, sendLocation prompt helpers, error mapping incl. 403 blocked-bot, rate-limit backoff, 4096-char split) (Verify by: unit test with mocked fetch passes: normal send, 403 -> mark blocked, 429 -> retry-after)
- [ ] 10.3 Add `subscribers.ts` data access: upsert citizen (chatId + rounded locKey), upsert school-follower (chatId + schoolId), list ACTIVE subscribers by locKey / by schoolId, distinct locKey groups, mark blocked/unsubscribe, track lastAlertTier per subscriber (Verify by: unit test with mocked DocumentClient passes)
- [ ] 10.4 Add `notify.ts` channel-agnostic sender: given {schoolId?, locKey?, tier, aqi, advisoryEn, advisoryHi} publishes email (existing snsApi) for schools AND Telegram messages to matching subscribers; dedupe per subscriber via lastAlertTier (Verify by: unit test with mocked SNS + Telegram passes; email path unchanged when no subscribers)
- [ ] 10.5 Update the scheduler (`fetchAndEvaluate`): loop = schools ∪ distinct citizen locKeys. For a citizen group: fetch PM2.5 once, evaluate, then `notify` every active citizen with that locKey (each with their own lang and lastAlertTier) (Verify by: unit test — 3 citizens sharing a locKey → exactly 1 OpenAQ fetch, 3 Telegram sends, 3 lastAlertTier updates)
- [ ] 10.6 Wire `evaluateSchool` to call notify (Verify by: existing evaluate tests still pass + one new test shows both channels called on ORANGE rise)
- [ ] 10.7 sam local invoke test: seed localdb.json with two citizen subscribers + one school-follower, simulate RED, confirm all three get a Telegram-shaped message logged (Verify by: local invoke output shows three sendMessage payloads)
- [ ] 10.8 Git commit: `phase-10: citizen-first telegram fan-out in shared evaluate path` (Verify by: `git log -1`)

**Phase 10 gate:** a citizen with only Telegram (no dashboard, no email) receives the alert once per tier rise after just /start + location; schools keep working exactly as before.

---

## Phase 11 (new, P1): AI layer — Hugging Face with token fallback

**Goal:** RULES DECIDE, AI EXPLAINS: cached audience advisories per tier+audience+lang, Telegram Q&A grounded in the approved rules, safe fallback when AI is unavailable.

- [ ] 11.1 Add `ai/` module: `hf.ts` client for `POST https://router.huggingface.co/v1/chat/completions` (Bearer token from env HF_TOKENS ordered list, default HF_TOKEN_1,HF_TOKEN_2; HF_MODEL env var; 3s timeout, max_tokens 160, no streaming) (Verify by: unit test with mocked fetch checks request shape from current docs: Authorization header, model, messages, max_tokens)
- [ ] 11.2 Token fallback + DynamoDB exhaustion: `tokenStatus.ts` (mark exhausted with cooldown on 402/429-quota, short cooldown on 5xx/timeout), chain token 1 → token 2 → null (Verify by: unit test: token1 returns 402, token2 returns valid chat completion; both exhausted → null without network call)
- [ ] 11.3 Output safety check: length cap, no "outdoor is safe" on ORANGE/RED, no medical diagnosis; drop AI text on failure (Verify by: unit test passes on bad outputs)
- [ ] 11.4 Rate limits in DynamoDB: per-user Q&A N/hour + global/day; polite rule-based reply when hit (Verify by: unit test passes)
- [ ] 11.5 Audience advisories cached per `tier#audience#lang`: model writes English, Amazon Translate converts to Hindi, both cached; final message = rule block + AI addition (Verify by: unit test: cache hit avoids network; HF failure returns rule text only)
- [ ] 11.6 Telegram Q&A handler: grounded system prompt with tier + approved rules + untrusted-user-text guard; health questions refer to a doctor (Verify by: unit test with mocked HF client + prompt snapshot)
- [ ] 11.7 Add `/explain` for the current category with a fixed rule-based explanation fallback (Verify by: unit test)
- [ ] 11.8 Add HF_TOKEN_1, HF_TOKEN_2 (NoEcho), HF_MODEL, ai/ env wiring to template.yaml (Verify by: `sam validate` passes)
- [ ] 11.9 Git commit: `phase-11: HF AI layer with token fallback and safety checks` (Verify by: `git log -1`)

**Phase 11 gate:** Q&A answers arrive under the rule block; forcing both tokens to fail still answers with rule-based text; rate limits enforced and tested.

---

## Phase 12 (new): Dashboard + demo polish for Telegram/AI

**Goal:** Show Telegram deep link per school and demo the fallback on demand.

- [~] 12.1 Dashboard: per-school "Subscribe on Telegram" button linking to `https://t.me/<bot>?start=school_<schoolId>` (Verify by: clicking opens the bot with the right payload) — DROPPED, no dashboard and no schools in Phase 9R
- [ ] 12.2 Update README Future Scope (remove Bedrock; add WhatsApp — needs Meta business verification and paid templates —, SQS fan-out) and architecture diagram with Telegram + HF chain (Verify by: README renders correctly on GitHub)
- [ ] 12.3 Update docs/DEMO_SCRIPT.md: phone registration -> simulate -> Telegram alert -> ask question -> simulate token-1 failure -> fallback answer (Verify by: script matches new PRD §13 table)
- [ ] 12.4 Git commit: `phase-12: dashboard deep link + demo polish` (Verify by: `git log -1`)

---

## Definition of Done (PRD §15)

- [ ] Backend deployed with `sam deploy`; EventBridge schedule producing readings
- [ ] AQI/tier/advisory logic unit-tested
- [ ] Email alert received once per tier rise, with English and Hindi text
- [ ] Dashboard live on a public Amplify URL and works on mobile
- [ ] Simulate button demonstrates the whole flow in under a minute
- [ ] README with architecture diagram, AWS service explanations and future scope
- [ ] 3-minute demo video recorded
- [ ] No secrets committed; billing alarm active
