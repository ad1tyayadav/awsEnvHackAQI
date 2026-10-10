# 3-Minute Demo Script (PRD §13)

**Setup before recording:**
- Dashboard already open (`NEXT_PUBLIC_API_URL` pointing at the deployed API).
- Email inbox open in a second tab (subscribed + confirmed beforehand).
- Architecture diagram ready (README mermaid diagram on screen).

## 0:00–0:30 — The problem
- "On a severe air day, children are already outside before anyone checks AQI."
- Show a Delhi winter news headline or poor-AQI photo.
- "Public data exists. Nobody turns it into a *decision for a school*."

## 0:30–1:30 — Live demo
1. Dashboard → click **Add school** → type a name, city Delhi, lat 28.6, lng 77.2, your email. Submit.
2. Select the school → current AQI, tier badge, PM2.5, station name, last updated.
3. Point at the **action plan in English** → click the **हिंदी** toggle → same plan, translated (cached in DynamoDB via Amazon Translate).
4. Press **Simulate severe day** → status flips **RED**, 24-hour trend updates.
5. Switch to the email tab: alert arrived — subject `Air alert: ... is RED (AQI n)`, English plan, Hindi plan, disclaimer. **One email, not ten** — the dedupe rule.

## 1:30–2:30 — Architecture (one line per service)
- **EventBridge** runs fetch every 30 minutes.
- **Lambda** pulls the nearest PM2.5 from **OpenAQ**, computes CPCB **AQI**, maps a risk tier.
- **DynamoDB** stores readings, schools, the advisory cache, alert history.
- On ORANGE/RED escalation the Lambda publishes to **SNS** → email subscribers, bilingual via **Amazon Translate**.
- **API Gateway** serves the **Next.js** dashboard hosted on **Amplify** — the whole thing is one SAM template, no servers.

## 2:30–3:00 — Impact and scale
- "Works for any school in any city — only coordinates in, action plan out."
- "Same engine can run a **heatwave** playbook, voice via **Polly**, and a **district dashboard** for education officers."
- Close: "Schools don't need AQI charts. They need an answer — before the first bell. This gives it."

## Recorded-by checklist
- [ ] Dashboard loaded, school selected pre-recording
- [ ] Email inbox in tab 2, already confirmed
- [ ] Timer visible; stay within ~90 seconds inside the demo section
- [ ] Test email deleted before recording so the arriving one is clearly "new"
