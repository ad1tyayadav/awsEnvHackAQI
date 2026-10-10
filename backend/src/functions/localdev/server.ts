// Local dev server - REAL DATA, no AWS needed. Run with: npx tsx src/functions/localdev/server.ts
// Uses the REAL pipeline modules (openaq.ts, aqi.ts, tiers.ts) and your REAL OpenAQ key.
// DynamoDB -> JSON file; SNS -> console "+ localdb.json alertLog". Same rules, verifiable live.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer, { type Transporter } from 'nodemailer';

import { fetchNearestPM25 } from '../../lib/openaq.js';
import { pm25ToAqi } from '../../lib/aqi.js';
import { aqiToTier, shouldAlert, tierToRepresentativePm25, isTier } from '../../lib/tiers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..'); // d:/codesPlayground/envhack

const ADVISORY_EN: Record<string, string> = {
  GREEN: 'Normal activities. No restrictions.',
  YELLOW: 'Children with asthma or breathing problems should avoid heavy exercise outdoors. Shorten outdoor PE and keep water available.',
  ORANGE: 'Cancel outdoor sports and assemblies. Keep classroom windows closed. Bus children and outdoor-duty staff should wear N95 masks. Keep children with asthma indoors.',
  RED: 'All outdoor activity stopped. Keep everyone indoors with windows closed. N95 masks for travel to and from school. Parents are advised to keep children at home if possible. Follow any official order from the local education authority.',
};
const ADVISORY_HI: Record<string, string> = {
  GREEN: 'सामान्य गतिविधियाँ। कोई प्रतिबंध नहीं।',
  YELLOW: 'दमा या सांस की समस्या वाले बच्चों को बाहर भारी व्यायाम से बचना चाहिए। बाहरी पी.ई. कम करें और पानी उपलब्ध रखें।',
  ORANGE: 'बाहरी खेल और सभाएँ रद्द करें। कक्षा की खिड़कियाँ बंद रखें। बस में आने-जाने वाले बच्चों और बाहर ड्यूटी करने वाले स्टाफ को N95 मास्क पहनना चाहिए। दमा वाले बच्चों को घर के अंदर रखें।',
  RED: 'सभी बाहरी गतिविधियाँ बंद। सभी को खिड़कियाँ बंद करके घर के अंदर रखें। स्कूल आने-जाने के लिए N95 मास्क। माता-पिता को सलाह दी जाती है कि संभव हो तो बच्चों को घर पर रखें। स्थानीय शिक्षा प्राधिकरण के किसी भी आदेश का पालन करें।',
};

function loadApiKey(): string {
  if (process.env.OPENAQ_API_KEY) return process.env.OPENAQ_API_KEY;
  try {
    const txt = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
    const line = txt.split(/\r?\n/).find((l) => /^(openaq|opendata)\s*=/i.test(l));
    if (line) return line.split('=').slice(1).join('=').trim();
  } catch { /* absent */ }
  return '';
}
const OPENAQ_KEY = loadApiKey();

/** Gmail SMTP creds (for REAL alert emails) from env or .env: gmail_user / gmail_app_pass. */
function loadGmail(): { user: string; pass: string } | null {
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASS) return { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS };
  try {
    const txt = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
    let user = '', pass = '';
    for (const l of txt.split(/\r?\n/)) {
      const m = l.match(/^\s*(gmail[_-]?user|gmail[_-]?app[_-]?pass)\s*=\s*(.+)\s*$/i);
      if (!m) continue;
      const k = m[1]!.toLowerCase().replace(/-/g, '_');
      if (k === 'gmail_user') user = m[2]!.trim();
      if (k === 'gmail_app_pass') pass = m[2]!.replace(/\s+/g, '');
    }
    return user && pass ? { user, pass } : null;
  } catch { return null; }
}
const GMAIL = loadGmail();
let mailer: Transporter | null = GMAIL
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 465, secure: true,
      auth: { user: GMAIL.user, pass: GMAIL.pass },
    })
  : null;
async function sendRealEmail(to: string, subject: string, body: string): Promise<boolean> {
  if (!mailer) return false;
  try {
    const info = await mailer.sendMail({ from: `"Clean Air Day-Planner" <${GMAIL!.user}>`, to, subject, text: body });
    console.log(`[localdev] REAL EMAIL SENT to ${to} (id ${info.messageId})`);
    return true;
  } catch (err) {
    console.error(`[localdev] EMAIL FAILED: ${(err as Error).message}`);
    return false;
  }
}

interface SchoolRow {
  schoolId: string; name: string; city: string; lat: number; lng: number;
  contactEmails?: string[]; lastAlertTier?: string | null; createdAt?: string;
}
interface ReadingRow {
  schoolId: string; ts: string; pm25: number; aqi: number; category: string;
  tier: string; source: 'openaq' | 'simulated'; stationName?: string;
}
interface Store {
  schools: SchoolRow[];
  readings: Record<string, ReadingRow[]>;
  alertLog: { ts: string; schoolId: string; subject: string; body: string }[];
}

const DB_FILE = path.join(__dirname, 'localdb.json');
function loadDb(): Store {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) as Store; }
  catch { return { schools: [], readings: {}, alertLog: [] }; }
}
function saveDb(s: Store): void { fs.writeFileSync(DB_FILE, JSON.stringify(s, null, 2)); }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(res: http.ServerResponse, status: number, msg: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: msg, statusCode: status }));
}
function ok(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve(null); } });
  });
}
function formatAlertEmail(name: string, tier: string, aqi: number): { subject: string; body: string } {
  const subject = `Air alert: ${name} is ${tier} (AQI ${aqi})`;
  const body = [
    `Air quality alert for ${name}`, ``,
    `Current AQI: ${aqi} (${tier})`, ``,
    `--- Action plan (English) ---`, ADVISORY_EN[tier], ``,
    `--- कार्य योजना (हिंदी) ---`, ADVISORY_HI[tier], ``,
    `---`,
    `Advisories are guidance based on hourly PM2.5 estimates and do not replace official orders from local authorities.`,
  ].join('\n');
  return { subject, body };
}
function evaluateAndMaybeAlert(s: Store, school: SchoolRow, pm25: number, source: 'openaq' | 'simulated', stationName: string | undefined, ts: string): Promise<string | null> {
  const { aqi, category } = pm25ToAqi(pm25);
  const tier = aqiToTier(aqi);
  const reading: ReadingRow = { schoolId: school.schoolId, ts, pm25, aqi, category, tier, source, stationName };
  (s.readings[school.schoolId] ??= []).unshift(reading);
  let alertSubject: string | null = null;
  let emailPromise: Promise<unknown> = Promise.resolve();
  if (shouldAlert((school.lastAlertTier ?? null) as never, tier)) {
    const { subject, body } = formatAlertEmail(school.name, tier, aqi);
    s.alertLog.push({ ts, schoolId: school.schoolId, subject, body });
    console.log(`\n=== ALERT ===\nTo: ${(school.contactEmails ?? []).join(', ')}\nSubject: ${subject}\n${body}\n===\n`);
    const emailTargets = school.contactEmails ?? [];
    alertSubject = subject;
    emailPromise = Promise.all(emailTargets.map((to) => sendRealEmail(to, subject, body)))
      .then((results) => {
        if (results.every((r) => r === false) && emailTargets.length > 0) {
          console.log('[localdev] (No SMTP configured - set gmail_user / gmail_app_pass in .env to actually SEND. Alert only logged above.)');
        }
      });
  }
  school.lastAlertTier = tier; // always update (PRD dedupe rule)
  return emailPromise.then(() => alertSubject);
}
function getStatus(s: Store, id: string) {
  const school = s.schools.find((x) => x.schoolId === id);
  if (!school) return null;
  const history = (s.readings[id] ?? []).sort((a, b) => b.ts.localeCompare(a.ts));
  const latest = history[0] ?? null;
  const advisory = latest
    ? { en: ADVISORY_EN[latest.tier] ?? '', hi: ADVISORY_HI[latest.tier] ?? '' }
    : null;
  return { school, latest, advisory, history: history.slice(0, 24), alertCount: s.alertLog.filter((a) => a.schoolId === id).length };
}

const PORT = Number(process.env.PORT || 3001);
http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const s = loadDb();
  const parts = p.split('/').filter(Boolean);
  const id = parts[1];

  try {
    if (req.method === 'POST' && p === '/schools') {
      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (!body) return bad(res, 400, 'body is not valid JSON');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const city = typeof body.city === 'string' ? body.city.trim() : '';
      const lat = typeof body.lat === 'number' ? body.lat : NaN;
      const lng = typeof body.lng === 'number' ? body.lng : NaN;
      const emails = Array.isArray(body.contactEmails) ? (body.contactEmails as unknown[]).filter((e): e is string => typeof e === 'string') : [];
      if (!name) return bad(res, 400, 'name is required');
      if (!city) return bad(res, 400, 'city is required');
      if (!Number.isFinite(lat) || lat < -90 || lat > 90) return bad(res, 400, 'lat must be in [-90,90]');
      if (!Number.isFinite(lng) || lng < -180 || lng > 180) return bad(res, 400, 'lng must be in [-180,180]');
      if (emails.length === 0 || emails.length > 5) return bad(res, 400, '1 to 5 contactEmails required');
      if (emails.some((e) => !EMAIL_RE.test(e))) return bad(res, 400, `invalid email`);

      let first: ReadingRow | null = null;
      try {
        const r = await fetchNearestPM25(lat, lng, OPENAQ_KEY);
        const { aqi, category } = pm25ToAqi(r.pm25);
        first = { schoolId: '', ts: r.measuredAt, pm25: r.pm25, aqi, category, tier: aqiToTier(aqi), source: 'openaq', stationName: r.stationName };
      } catch (err) {
        console.warn(`[localdev] initial OpenAQ fetch failed: ${(err as Error).message}`);
      }

      const schoolId = `sch_${Date.now().toString(36)}`;
      const school: SchoolRow = { schoolId, name, city, lat, lng, contactEmails: emails, lastAlertTier: null, createdAt: new Date().toISOString() };
      s.schools.push(school);
      if (first) { first.schoolId = schoolId; s.readings[schoolId] = [first]; }
      saveDb(s);
      return ok(res, 201, school);
    }

    if (req.method === 'GET' && p === '/schools') return ok(res, 200, s.schools);

    if (req.method === 'GET' && parts[0] === 'schools' && parts[2] === 'status' && id) {
      const st = getStatus(s, id);
      return st ? ok(res, 200, st) : bad(res, 404, `school ${id} not found`);
    }

    if (req.method === 'GET' && parts[0] === 'schools' && parts[2] === 'refresh' && id) {
      const st0 = getStatus(s, id);
      if (!st0) return bad(res, 404, `school ${id} not found`);
      try {
        const r = await fetchNearestPM25(st0.school.lat, st0.school.lng, OPENAQ_KEY);
        const subject = evaluateAndMaybeAlert(s, st0.school, r.pm25, 'openaq', r.stationName, r.measuredAt);
        saveDb(s);
        return ok(res, 200, { ...getStatus(s, id)!, alertFired: subject !== null });
      } catch (err) {
        return bad(res, 502, `OpenAQ fetch failed: ${(err as Error).message}`);
      }
    }

    if (req.method === 'POST' && parts[0] === 'schools' && parts[2] === 'simulate' && id) {
      const st0 = getStatus(s, id);
      if (!st0) return bad(res, 404, `school ${id} not found`);
      const body = (await readBody(req)) as { tier?: string; pm25?: number } | null;
      if (!body) return bad(res, 400, 'body is not valid JSON');
      let pm25: number;
      if (typeof body.tier === 'string') {
        if (!isTier(body.tier)) return bad(res, 400, 'tier must be GREEN|YELLOW|ORANGE|RED');
        pm25 = tierToRepresentativePm25(body.tier as 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED');
      } else if (typeof body.pm25 === 'number') {
        if (body.pm25 < 0 || body.pm25 > 1000) return bad(res, 400, 'pm25 0-1000');
        pm25 = body.pm25;
      } else return bad(res, 400, 'provide tier or pm25');
      const subject = evaluateAndMaybeAlert(s, st0.school, pm25, 'simulated', undefined, new Date().toISOString());
      saveDb(s);
      return ok(res, 200, { ...getStatus(s, id)!, alertFired: subject !== null });
    }

    return bad(res, 404, `no route ${req.method} ${p}`);
  } catch (err) {
    console.error('[localdev] error:', err);
    return bad(res, 500, 'internal error');
  }
}).listen(PORT, () => {
  console.log(`[localdev] REAL-DATA server on http://localhost:${PORT}`);
  console.log('[localdev] store: ' + DB_FILE);
  console.log('[localdev] alerts: printed here + saved alertLog (this is what SNS would email)');
  console.log(`[localdev] OpenAQ key: ${OPENAQ_KEY ? 'loaded' : 'MISSING - put openaq=<key> in repo .env'}`);
  console.log(`[localdev] Gmail SMTP: ${GMAIL ? `configured for ${GMAIL.user} (REAL EMAILS WILL SEND)` : 'not configured - alerts only logged to console'}`);
});
