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

**Goal:** Send a recovery email when tier drops back to GREEN or YELLOW.

- [ ] 8.1 Add `shouldSendAllClear(previousTier, newTier): boolean` to `tiers.ts` — returns true when previous was ORANGE/RED and new is GREEN/YELLOW (Verify by: unit test passes)
- [ ] 8.2 Add "all clear" email template in `alerts.ts` — subject: "All clear: <School> is now <TIER>", body: good news message in English + Hindi (Verify by: unit test passes)
- [ ] 8.3 Update `evaluateSchool` to check `shouldSendAllClear` and publish the recovery email via SNS (Verify by: simulate RED → then simulate GREEN → "all clear" email arrives)
- [ ] 8.4 Git commit: `phase-8: all-clear recovery email` (Verify by: `git log -1`)

---

## Phase 9 (Stretch): Telegram alerts

**Goal:** Send alerts via a Telegram bot in addition to email.

- [ ] 9.1 Write `src/lib/telegram.ts` — function to send a message via the Telegram Bot API. Bot token stored as a Lambda env var via NoEcho SAM parameter (Verify by: file compiles)
- [ ] 9.2 Add Telegram chat ID to the school model (optional field). Update `POST /schools` to accept it (Verify by: API accepts the new field)
- [ ] 9.3 Update `evaluateSchool` to send Telegram alert alongside email when the school has a chat ID configured (Verify by: simulate RED → Telegram message received)
- [ ] 9.4 Git commit: `phase-9: Telegram bot alerts` (Verify by: `git log -1`)

---

## Phase 10 (Stretch): Bedrock wording

**Goal:** Optionally use Bedrock to generate friendlier advisory text, with rule-based fallback.

- [ ] 10.1 Add a feature flag env var `USE_BEDROCK` (default `false`) to the Lambda (Verify by: `sam validate` passes)
- [ ] 10.2 Write `src/lib/bedrock.ts` — call Bedrock to rephrase the advisory text in a friendlier tone. On failure, return `null` (Verify by: file compiles)
- [ ] 10.3 Update `getAdvisory` to try Bedrock when the flag is on, fall back to rule-based text on failure (Verify by: with flag off, behavior is unchanged; with flag on + mock, Bedrock text is used; with flag on + Bedrock failure, falls back to rule-based)
- [ ] 10.4 Git commit: `phase-10: optional Bedrock advisory wording` (Verify by: `git log -1`)

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
