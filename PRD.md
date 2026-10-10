# PRD: Clean Air Day-Planner for Schools

**Hackathon:** AWS Bharat Build · **Track 01: Air** · Solo entry
**Problem areas covered:** AQI, School safety on bad days
**One-line pitch:** When the air turns bad, every school gets a clear, bilingual action plan before the first bell, automatically.

---

## 1. Problem

On high-pollution days, Indian schools usually find out too late. Principals don't know whether to cancel PE, assemblies or outdoor duty, bus children are exposed on the way in, and parents get no clear guidance. The data exists (public AQI feeds) but nobody turns it into a decision for a school.

## 2. Users

| User | Need |
|---|---|
| **Principal / teacher (primary)** | Know today's risk level and what to do, without reading AQI charts |
| **Parents** | A short, clear message in English and Hindi |
| **Judges (secondary)** | See a working product, AWS used meaningfully, in 3 minutes |

## 3. Goals and non-goals

**Goals**
- Works for any school in any city (generic: location in, advisory out)
- Fully automatic: scheduled fetch, rule-based advisory, alert on bad days
- Deployed on AWS with a public URL
- One reliable demo path: add school, see AQI, simulate severe day, receive alert

**Non-goals (do NOT build unless every phase is done)**
- User login or accounts, maps, mobile app, payments
- SMS (needs DLT registration in India), voice calls
- Machine-learning forecasting
- Bedrock as a dependency (optional extra only)

## 4. Core demo flow

1. Open dashboard, add a school (name, city, lat/lng, parent/principal emails).
2. Dashboard shows live AQI, category, risk tier, and the action plan (English/Hindi toggle).
3. Press **Simulate severe day**.
4. Status flips to RED, the 24-hour trend updates, and an email arrives with the plan in English and Hindi.

## 5. Functional requirements

**P0 (must ship)**
- F1. Register a school with name, city, lat, lng and contact emails.
- F2. Scheduled job (every 30 minutes) fetches the nearest air-quality reading for each school and stores it.
- F3. Convert PM2.5 to an India (CPCB) AQI value and category, and map it to an action tier.
- F4. Generate an advisory per tier in English and Hindi (Hindi via Amazon Translate, cached).
- F5. Send an email alert when a school's tier rises to ORANGE or RED. No repeat alert for the same tier.
- F6. Dashboard: school list, current AQI and tier, advisory text with language toggle, last 24 readings.
- F7. **Simulate** endpoint and button that injects a reading and runs the full pipeline (used for the demo).

**P1 (if time remains)**
- F8. "All clear" email when the tier drops back to GREEN or YELLOW.
- F9. Telegram bot alert via Lambda.
- F10. Optional Bedrock-written friendlier wording, with rule-based text as fallback.

**P2 (future scope, README only)**
- Heatwave alerts for Track 02 using the same engine, Polly voice alerts, WhatsApp, district-level dashboard for education officers.

## 6. Advisory rules

AQI is computed from PM2.5 using CPCB breakpoints with linear interpolation inside each band.

| CPCB category | AQI | PM2.5 (µg/m³) | Action tier | Alert? |
|---|---|---|---|---|
| Good | 0-50 | 0-30 | GREEN | No |
| Satisfactory | 51-100 | 31-60 | GREEN | No |
| Moderate | 101-200 | 61-90 | YELLOW | No (dashboard only) |
| Poor | 201-300 | 91-120 | ORANGE | **Yes** |
| Very Poor | 301-400 | 121-250 | RED | **Yes** |
| Severe | 401-500 | 250+ | RED | **Yes** |

**Action plans (English source text, translate to Hindi):**
- **GREEN:** Normal activities. No restrictions.
- **YELLOW:** Children with asthma or breathing problems should avoid heavy exercise outdoors. Shorten outdoor PE and keep water available.
- **ORANGE:** Cancel outdoor sports and assemblies. Keep classroom windows closed. Bus children and outdoor-duty staff should wear N95 masks. Keep children with asthma indoors.
- **RED:** All outdoor activity stopped. Keep everyone indoors with windows closed. N95 masks for travel to and from school. Parents are advised to keep children at home if possible. Follow any official order from the local education authority.

**Honesty note (put in README):** CPCB AQI normally uses 24-hour averages. This prototype uses the latest hourly PM2.5 reading as a real-time estimate. Advisories are guidance and do not replace official orders.

**Alert dedupe:** store `lastAlertTier` on the school. Send an alert only when the new tier is ORANGE or RED and differs from `lastAlertTier` (or is higher). Update `lastAlertTier` on every evaluation.

## 7. Architecture

```
EventBridge (30 min)
      │
      ▼
Lambda: fetchAndEvaluate ──► OpenAQ API (free, needs API key)
      │  ├─ compute AQI + tier (pure functions)
      │  ├─ write reading ──► DynamoDB (Readings)
      │  └─ if tier rises to ORANGE/RED:
      │        get advisory EN + HI (Translate, cached in DynamoDB)
      │        publish ──► SNS topic ──► email subscribers
      ▼
API Gateway ──► Lambda: api (schools CRUD, status, simulate) ──► DynamoDB
      ▲
Dashboard (Next.js static export) on Amplify Hosting

CloudWatch: logs + AWS Budgets alarm
```

All services in **ap-south-1 (Mumbai)**.

| Service | Role |
|---|---|
| EventBridge | 30-minute schedule |
| Lambda (Node 20, TypeScript) | All backend logic |
| DynamoDB (on-demand) | Schools, readings, advisory cache, alert history |
| Amazon Translate | English to Hindi, cached per tier |
| SNS | Email alerts (one topic, per-school subscription filter on `schoolId`) |
| API Gateway (HTTP API) | Dashboard backend |
| Amplify Hosting | Dashboard hosting and public URL |
| CloudWatch | Logs |
| AWS SAM | Infrastructure as code, one `template.yaml` |

## 8. Data model (DynamoDB, on-demand)

**SchoolsTable**: PK `schoolId` (string)
`name, city, lat, lng, contactEmails[], lastAlertTier, createdAt`

**ReadingsTable**: PK `schoolId`, SK `ts` (ISO string)
`pm25, aqi, category, tier, source ("openaq" | "simulated"), stationName, ttl` (TTL 7 days)

**AdvisoryCacheTable**: PK `key` (`<TIER>#<lang>`, e.g. `RED#hi`)
`text, updatedAt`

**AlertsTable**: PK `schoolId`, SK `ts`
`tier, aqi, subject, channel`

## 9. API spec (all JSON, CORS enabled for the dashboard origin)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/schools` | `{name, city, lat, lng, contactEmails[]}` | created school; subscribes emails to SNS with a filter on `schoolId` |
| GET | `/schools` | | list of schools with latest tier |
| GET | `/schools/{id}/status` | | `{school, latest:{pm25,aqi,category,tier,ts,source,stationName}, advisory:{en,hi}, history:[last 24]}` |
| POST | `/schools/{id}/simulate` | `{tier: "RED"}` or `{pm25: 180}` | runs the full pipeline with a simulated reading; returns the new status |

Validate all inputs (lat in -90..90, lng in -180..180, valid emails, max 5 emails per school). Return clear error messages with proper status codes.

## 10. Tech stack and repo structure

- TypeScript everywhere, Node 20 Lambdas built with SAM + esbuild
- Vitest for unit tests of pure logic
- Next.js (static export) + Tailwind for the dashboard
- AWS SDK v3

```
/
├── PRD.md
├── AGENTS.md
├── PROGRESS.md              (agent-maintained task checklist)
├── README.md
├── backend/
│   ├── template.yaml
│   ├── samconfig.toml
│   ├── events/              (sample test events for sam local invoke)
│   └── src/
│       ├── lib/             (aqi.ts, tiers.ts, advisory.ts, openaq.ts, db.ts)
│       ├── functions/
│       │   ├── fetchAndEvaluate/
│       │   └── api/
│       └── tests/
├── frontend/
└── docs/                    (architecture diagram, screenshots)
```

## 11. Cost and security guardrails

- Serverless only. **Never create:** NAT Gateway, EC2, RDS, OpenSearch, load balancers.
- Set an AWS Budgets alert at $5 on day one.
- API Gateway throttling (e.g. 10 requests/second, burst 20) to protect credits since the API is public.
- No AWS keys, API keys or secrets in the repo. The OpenAQ key is passed as a NoEcho SAM parameter at deploy time and stored as a Lambda environment variable. `.env` files are in `.gitignore`.
- Lambda IAM permissions scoped to the specific tables, topic and `translate:TranslateText`.
- Translate each advisory once per tier and language, then read from the cache.
- Tear down with `sam delete` after the hackathon if no longer needed.

## 12. Build phases and agent prompts

Each phase lists its goal, the prompt to give the agent, and acceptance criteria. The agent must follow `AGENTS.md`: break the phase into small tasks, finish and verify one task at a time, and stop at the end of each phase for approval.

---

### Phase 0: Setup (mostly manual, the human does this)

**Human checklist**
- [ ] Verify student status on AWS Builder Center
- [ ] Create AWS account, claim free credits, set an AWS Budgets alert at $5
- [ ] Install AWS CLI, SAM CLI, Node 20, Git; run `aws configure` (region `ap-south-1`)
- [ ] Create a free OpenAQ account and generate an API key
- [ ] Create the GitHub repo and put `PRD.md` and `AGENTS.md` at the root

**Prompt to agent**
```text
Read PRD.md and AGENTS.md fully. Do not write code yet. Create PROGRESS.md with
every phase from the PRD as a heading. Then expand Phase 1 only into small tasks
(each should take under ~30 minutes and have a clear way to verify it). Show me
the task list and wait for my approval before starting task 1.
```

**Done when:** the repo exists, `aws sts get-caller-identity` works, `sam --version` works, the OpenAQ key is in hand.

---

### Phase 1: Backend foundation

**Goal:** A deployable SAM project with all four DynamoDB tables and a placeholder Lambda.

**Prompt**
```text
Phase 1 of PRD.md: backend foundation. Scaffold /backend with a SAM template
(Node 20, TypeScript, esbuild build method, region ap-south-1). Define the four
DynamoDB tables from PRD section 8 (on-demand billing, ReadingsTable with TTL on
`ttl`). Add one placeholder Lambda with a sample event in /backend/events. Add
`.gitignore`, `package.json`, `tsconfig.json`, and Vitest. Pass table names to
Lambdas via environment variables, not hard-coded. Work in small tasks per
AGENTS.md. At the end, give me exact commands to build, deploy and verify.
```

**Done when:** `sam build && sam deploy --guided` succeeds, the four tables are visible in the DynamoDB console, `sam local invoke` runs the placeholder, and `npm test` runs (even with a trivial test).

---

### Phase 2: AQI fetch and storage

**Goal:** Given a lat/lng, fetch the nearest PM2.5 reading from OpenAQ and store it.

**Prompt**
```text
Phase 2 of PRD.md: AQI fetch. In /backend/src/lib/openaq.ts write a function
that takes lat/lng and returns the nearest recent PM2.5 reading and station name
using the OpenAQ v3 API (requires the X-API-Key header). IMPORTANT: do not guess
the API shape. First read the current OpenAQ v3 documentation, tell me which
endpoints you will use, then implement. Handle: no station nearby (search within
a reasonable radius), stale data, API errors and timeouts, each with a clear
error. In /backend/src/lib/db.ts add helpers to write a reading and read recent
readings. Create the fetchAndEvaluate Lambda that, for now, loads all schools,
fetches PM2.5 for each, and stores a reading (without AQI/tier yet; store pm25
and source "openaq"). Read the API key from an environment variable passed via a
NoEcho SAM parameter. Add unit tests with the OpenAQ response mocked, and a
sample event. Small tasks, one at a time.
```

**Done when:** you manually insert one school row, run `sam local invoke` (or the deployed Lambda), and see a real PM2.5 reading in ReadingsTable. Mocked tests pass.

---

### Phase 3: AQI and advisory engine

**Goal:** Pure, well-tested logic that turns PM2.5 into AQI, category, tier and advisory text.

**Prompt**
```text
Phase 3 of PRD.md: advisory engine. In /backend/src/lib add:
1) aqi.ts: pm25ToAqi(pm25) using CPCB PM2.5 breakpoints from PRD section 6 with
   linear interpolation, returning {aqi, category}. Handle 0, band edges, and
   values above 250 (cap at 500).
2) tiers.ts: aqiToTier(aqi) returning GREEN | YELLOW | ORANGE | RED, and
   shouldAlert(previousTier, newTier) implementing the dedupe rule in PRD
   section 6.
3) advisory.ts: the English action plan per tier (use the text in PRD section 6).
Write thorough Vitest tests: every band edge, interpolation midpoints, every
tier, every alert-dedupe case. Then update fetchAndEvaluate to compute and store
aqi, category and tier on each reading. Do not call any AWS service in these
pure functions.
```

**Done when:** tests pass, including band edges (e.g. PM2.5 = 30, 31, 90, 91, 120, 121, 250, 251); readings in DynamoDB now include `aqi`, `category`, `tier`. **Human reviews the advisory wording.**

---

### Phase 4: Hindi advisories and email alerts

**Goal:** On a tier rise to ORANGE or RED, send an English and Hindi email alert.

**Prompt**
```text
Phase 4 of PRD.md: alerts. Add to advisory.ts a function getAdvisory(tier, lang)
that returns English from code and Hindi from AdvisoryCacheTable; on a cache miss,
call Amazon Translate (en to hi), store the result, and return it. If Translate
fails, fall back to English and log the error. Add an SNS topic to the SAM
template with least-privilege permissions. Add a function that formats the alert
email (subject: "Air alert: <School> is <TIER> (AQI <n>)", body: English plan
then Hindi plan, plus a note that this is guidance and local authority orders
take priority). Add a helper that subscribes an email to the topic with a
subscription filter policy on the `schoolId` message attribute. In
fetchAndEvaluate, after computing the tier, use shouldAlert(school.lastAlertTier,
tier); if true, publish with the schoolId attribute, write a row to AlertsTable,
and update lastAlertTier. Always update lastAlertTier after each evaluation. Add
tests with AWS calls mocked. Small tasks, one at a time.
```

**Done when:** you subscribe your own email, confirm the subscription, force a RED reading, and receive the email once (not repeatedly) with the Hindi text rendered correctly.

---

### Phase 5: Scheduler and API

**Goal:** Everything runs automatically and the dashboard has an API to talk to.

**Prompt**
```text
Phase 5 of PRD.md: scheduler and API. Add an EventBridge schedule (every 30
minutes) for fetchAndEvaluate. Add an HTTP API (API Gateway) with the `api`
Lambda implementing the four endpoints in PRD section 9: POST /schools,
GET /schools, GET /schools/{id}/status, POST /schools/{id}/simulate. Requirements:
input validation with clear 400 errors, CORS enabled, API throttling (10 rps,
burst 20), structured JSON responses, and consistent error handling. The
simulate endpoint must create a reading with source "simulated" and run the SAME
evaluate-and-alert code path used by the scheduler (refactor into a shared
function, do not duplicate logic). POST /schools must create the school and
subscribe its emails to SNS with the filter policy. Add tests for validation and
handlers. Provide curl commands to test every endpoint. Small tasks, one at a
time.
```

**Done when:** all four endpoints work via curl against the deployed URL; simulate RED triggers an email; the schedule appears in EventBridge and produces readings on its own.

---

### Phase 6: Dashboard

**Goal:** One clean page that a non-technical principal can use.

**Prompt**
```text
Phase 6 of PRD.md: dashboard. Create /frontend with Next.js (static export,
`output: 'export'`), TypeScript and Tailwind. Single page that reads the API base
URL from NEXT_PUBLIC_API_URL. Features: (1) form to add a school (name, city,
lat, lng, emails) with validation and a note that each email must confirm the
subscription; (2) list of schools with a colored tier badge; (3) selecting a
school shows AQI, category, tier, source (live vs simulated), station name,
last-updated time, and the action plan with an English/Hindi toggle; (4) a
simple trend list or chart of the last 24 readings (no heavy chart library
unless trivial); (5) a prominent "Simulate severe day" button; (6) loading,
empty and error states; (7) mobile-friendly layout with large readable text and
an accessible color-plus-label tier indicator (do not rely on color alone). Show
the guidance disclaimer. Do not add login, maps or extra pages. Small tasks, one
at a time. Run locally first and tell me how to verify.
```

**Done when:** the full demo flow in section 4 works locally against the deployed API, then on the Amplify URL. Test it on a phone.

---

### Phase 7: Deploy, polish, README, demo video

**Prompt**
```text
Phase 7 of PRD.md: finish. (1) Give me exact steps to deploy /frontend to AWS
Amplify Hosting with NEXT_PUBLIC_API_URL set, and verify CORS against the Amplify
domain. (2) Write README.md: problem, solution, screenshots placeholder,
architecture diagram (Mermaid), AWS services and why each is used, how to run
and deploy, cost notes, the honesty note about hourly PM2.5, and a Future Scope
section (Bedrock-personalized wording, Polly voice alerts, heatwave alerts for
Track 02, district dashboard). (3) Review the repo for leaked secrets, unused
code and missing `.gitignore` entries. (4) Create docs/DEMO_SCRIPT.md from PRD
section 13. Small tasks, one at a time.
```

**Done when:** a stranger can open the public URL and complete the demo flow; the README is complete; no secrets in git history.

---

### Stretch phases (only after Phase 7 is fully done)

- **Phase 8: "All clear" email** when the tier drops to GREEN/YELLOW (F8).
- **Phase 9: Telegram alerts** via a Lambda and bot token stored as an environment variable (F9).
- **Phase 10: Bedrock wording** behind a feature flag, always falling back to rule-based text (F10).

## 13. Demo video script (3 minutes, recorded)

| Time | Content |
|---|---|
| 0:00-0:30 | The problem: a school learns about severe AQI after children are already outside. Who suffers. |
| 0:30-1:30 | Live demo: add a school, show live AQI and the action plan, toggle to Hindi, press **Simulate severe day**, show the email arriving in English and Hindi. |
| 1:30-2:30 | Architecture diagram: EventBridge, Lambda, DynamoDB, Translate, SNS, API Gateway, Amplify. One sentence per service on what it does. |
| 2:30-3:00 | Impact and scale: works for any school in any city; next step is heatwave alerts and district dashboards. |

Record with the dashboard already loaded, email inbox open in another tab, and the architecture diagram ready.

## 14. Risks and fallbacks

| Risk | Fallback |
|---|---|
| OpenAQ has no nearby station for a city | Increase search radius; demo with a city that has stations; simulate endpoint always works |
| OpenAQ API key or rate-limit trouble | Cache last reading; use simulate for the demo; keep a small seeded sample dataset |
| Translate fails or is unavailable | Fall back to English text and log the error |
| SNS email subscription not confirmed | Show the confirmation note in the UI; confirm your own demo email in advance |
| Bedrock unavailable on a new account | Not a dependency; rule-based advisory is the product |
| Amplify static export issues | Deploy the exported `out/` folder to S3 + CloudFront instead |
| Running low on time | Cut stretch phases first, then polish; never cut Phases 1-6 |

## 15. Definition of done

- [ ] Backend deployed with `sam deploy`; EventBridge schedule producing readings
- [ ] AQI/tier/advisory logic unit-tested
- [ ] Email alert received once per tier rise, with English and Hindi text
- [ ] Dashboard live on a public Amplify URL and works on mobile
- [ ] Simulate button demonstrates the whole flow in under a minute
- [ ] README with architecture diagram, AWS service explanations and future scope
- [ ] 3-minute demo video recorded
- [ ] No secrets committed; billing alarm active