# Demo Instructions (for judges, both formats)

## What this product does (30-second version)
Schools shouldn't need to read AQI charts. They add their school once, get a clear bilingual
action plan, and automatically receive an email alert the moment the air escalates to
ORANGE or RED. A "Simulate severe day" button proves the whole pipeline instantly.

---

## Format 1: Laptop demo (2 minutes, no internet needed)

```bash
cd frontend
npx serve out -l 3333     # or any port; open http://localhost:3333
```

1. Dashboard opens in **Demo mode** (blue badge top-right shows "Demo mode · same rules, in-browser").
2. Click **Add school** → any name (e.g. "DL Public School"), city "Delhi", lat 28.6, lng 77.2,
   your email → **Add school**.
3. The school appears in the list. Click it → current AQI, PM2.5, station, tier badge show up
   (real CPCB math, real OpenAQ-shaped data, real bilingual advisories).
4. Action plan shows in **English**. Click **हिंदी** toggle → same plan in Hindi.
5. Press **Simulate severe day** → status flips **RED**, 24-hour trend updates, and a preview of
   the **alert email** (English + Hindi + disclaimer) pops up — exactly what AWS SNS sends.
6. Click × to close. Demo done. Judges see the full product story in 2 minutes.

## Format 2: Public URL (qr-code / browser demo)

Two options, depending on how far along the deploy is:

### Option A (works today, any laptop with internet) — one-time setup:
Deploy the static output to any free static host that works before AWS is unblocked:

```bash
cd frontend
npm install -g vercel@latest    #或 use netlify-cli, surge, etc. if preferred
vercel --prod                   # accept defaults, keep project name memorable
```

Vercel/Netlify/Surge all serve the `out/` folder as-is. Doesn't need the AWS backend —
demo mode kicks in because `NEXT_PUBLIC_API_URL` is empty.

### Option B (once AWS deploy is unlocked) — real backend:
```bash
# in backend/
sam deploy                      # uses backend/samconfig.toml
# copy ApiBaseUrl from the output

# in frontend/
NEXT_PUBLIC_API_URL=<ApiBaseUrl> npm run build
vercel --prod                    # same as above but now with live data
```

---

## What to say to the judges (60-second script)

> "Schools find out about bad air too late. This product turns public AQI data into a
> decision for a school — automatically, in English and Hindi.
>
> Here's the flow: add your school once… see current AQI and tier badge… the action plan
> changes with language toggle… and when the air escalates, the principal gets an email
> alert — once, not repeatedly — with the plan in both languages.
>
> Press **Simulate severe day** — that's the same pipeline judges would run on a real bad day.
>
> In the deployed backend everything runs on AWS: EventBridge triggers a Lambda every
> 30 min, which hits OpenAQ for the nearest PM2.5 monitor, computes the CPCB AQI, and the
> Escalation logic fires SNS email alerts with **Amazon Translate** doing Hindi, cached in
> DynamoDB so it runs once per tier. One SAM template = whole backend. Serverless, so it
> stays in free tier."

## FAQ answers judges might ask

| Question | Answer |
|---|---|
| Where's the data from? | OpenAQ free API, which aggregates Indian CPCB + state monitors. Deployed mode calls it every 30 min via EventBridge → Lambda. Demo mode seeds realistic values exhibiting the same shapes. |
| Is the AQI "real"? | Same CPCB PM2.5 breakpoints + linear interpolation, identical math in both modes. Demo mode is just data-source-replaced. |
| How does Hindi work? | Amazon Translate, cached per tier in DynamoDB so it costs ~nothing. Demo mode uses the same rule-based fallback text. |
| What if there's no station nearby? | The deployed pipeline errors gracefully (logged), the school shows "no reading yet", and the **simulate** button still proves the alert pipeline. |
| Why email, not SMS? | SNS email is free + no DLT registration. SMS via SNS needs distr-reg rules in India; future scope lists Telegram/WhatsApp. |
| What's the cost? | ~₹0. Everything is serverless/on-demand, inside the AWS free tier. A $5 Budgets alarm is configured. |
