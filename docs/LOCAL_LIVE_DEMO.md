# Live-Data Local Demo (no AWS deploy needed)

Runs the **real backend logic** (same `openaq.ts` → `pm25ToAqi` → tier/dedupe code the
deployed Lambda uses) with your **real OpenAQ key**, but without any AWS service:
DynamoDB is swapped for a JSON file, SNS for a console alert log.

## One-time setup
1. Repo root `.env` must contain `opendata=<your-key>` (already present).
2. `cd backend && npm install` once for `tsx`.

## Start (two terminals)

```bash
# terminal 1 — live-data API (port 3001)
cd backend
npx tsx src/functions/localdev/server.ts

# terminal 2 — dashboard pointed at the live-data server, REBUILT with API URL
cd frontend
set NEXT_PUBLIC_API_URL=http://localhost:3001     # Windows CMD
# (bash: export NEXT_PUBLIC_API_URL=http://localhost:3001)
npm run build
npx serve out -l 3333
```

Open **http://localhost:3333** — the blue "Demo mode" badge is GONE; the dashboard now
talks to the local server with **real OpenAQ data**.

## What's real, what's simulated
| Piece | State |
|---|---|
| PM2.5 reading | **REAL** — nearest DPCC/CPCB/IMD station within 25 km, freshest of ~6 probed sensors |
| AQI (CPCB breakpoints) | **REAL** math, shared code path |
| Tier + dedupe | **REAL** logic, same `shouldAlert` as deployed |
| Advisory | **REAL** English + Hindi text (same strings as deployed translate target) |
| Storage | JSON file `backend/src/functions/localdev/localdb.json` (DynamoDB in deploy) |
| Alert delivery | printed to the server console + saved in `alertLog` (SNS email in deploy) |
| Scheduled 30-min fetch | Manual: `GET /schools/{id}/refresh` hits OpenAQ exactly like EventBridge would |

## Judge-facing flow (2 min)
1. Add a Delhi school → real station data appears instantly.
2. Click school → AQI, tier badge, station name, source = "Live".
3. Toggle हिंदी — real bilingual action plan.
4. **Simulate severe day** → RED + alert email preview (this is exactly what SNS sends).
5. Optional: show the server console — the alert email and the real OpenAQ fetch log lines.

## Honest answers for judges
- "Station data 1-3 days delayed for some DPCC sensors upstream — we take the freshest
  reading of any nearby station and show its timestamp. Timestamps are always visible."
- "Deployed version: identical logic; JSON file becomes DynamoDB and the console alert
  becomes a real SNS email."

## Limitations
- Simulate data is still injected (that's the PRD F7 demo affordance, same in deploy).
- Alert emails land in the local console (no SMTP); in deploy they're SNS emails.
