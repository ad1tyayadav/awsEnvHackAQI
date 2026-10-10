// API Lambda for the dashboard (HTTP API Gateway, Phase 5).
// Endpoints (PRD section 9):
//   POST /schools             create school + subscribe emails to SNS
//   GET  /schools             list schools
//   GET  /schools/{id}/status latest reading + advisory (en/hi) + 24h history
//   POST /schools/{id}/simulate inject a reading and run the shared pipeline
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import {
  putSchool, getSchool, getAllSchools, getRecentReadings,
  type School,
} from '../../lib/db';
import { pm25ToAqi } from '../../lib/aqi';
import { aqiToTier, tierToRepresentativePm25, isTier, type Tier } from '../../lib/tiers';
import { getAdvisory } from '../../lib/advisoryI18n';
import { evaluateSchool } from '../../lib/evaluate';
import { snsApi } from '../../lib/alerts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ApiErr { statusCode: number; error: string }

class ValidationError extends Error implements ApiErr {
  statusCode = 400;
  error = 'validation_error';
  constructor(msg: string) { super(msg); this.error = msg; }
}
class NotFoundError extends Error implements ApiErr {
  statusCode = 404;
  error = 'not_found';
  constructor(msg: string) { super(msg); this.error = msg; }
}

export function json(statusCode: number, body: unknown): { statusCode: number; headers: Record<string, string>; body: string } {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // Phase 7 tightens to Amplify domain
    },
    body: JSON.stringify(body),
  };
}

/** Validates POST /schools input per PRD: name, city, lat range, lng range, <=5 emails, email format. */
export function validateSchoolInput(body: unknown): { name: string; city: string; lat: number; lng: number; contactEmails: string[] } {
  if (typeof body !== 'object' || body === null) throw new ValidationError('body must be a JSON object');
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const city = typeof b.city === 'string' ? b.city.trim() : '';
  const lat = typeof b.lat === 'number' ? b.lat : Number(String(b.lat));
  const lng = typeof b.lng === 'number' ? b.lng : Number(String(b.lng));
  const emails = Array.isArray(b.contactEmails) ? b.contactEmails.filter((e): e is string => typeof e === 'string') : [];

  if (!name) throw new ValidationError('name is required');
  if (!city) throw new ValidationError('city is required');
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new ValidationError('lat must be a number between -90 and 90');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new ValidationError('lng must be a number between -180 and 180');
  if (emails.length === 0) throw new ValidationError('contactEmails must contain at least one email');
  if (emails.length > 5) throw new ValidationError('contactEmails must contain at most 5 emails');
  for (const e of emails) {
    if (!EMAIL_RE.test(e)) throw new ValidationError(`invalid email format: ${e}`);
  }
  return { name, city, lat, lng, contactEmails: emails };
}

function getTopicArn(): string {
  return process.env.ALERT_TOPIC_ARN ?? '';
}

export async function createSchool(input: { name: string; city: string; lat: number; lng: number; contactEmails: string[] }): Promise<School> {
  const schoolId = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const school: School = {
    schoolId,
    name: input.name,
    city: input.city,
    lat: input.lat,
    lng: input.lng,
    contactEmails: input.contactEmails,
    lastAlertTier: null,
    createdAt: new Date().toISOString(),
  };
  await putSchool(school);
  const topicArn = getTopicArn();
  for (const email of input.contactEmails) {
    try {
      if (topicArn) await snsApi.subscribe(topicArn, email, schoolId);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'sns subscribe failed', schoolId, email: email.slice(0, 3) + '***', error: String(err) }));
    }
  }
  return school;
}

export function simulateToReading(sim: { tier?: string; pm25?: number }): { pm25: number; ts: string } {
  if (typeof sim !== 'object' || sim === null) throw new ValidationError('body must be a JSON object');
  const s = sim as { tier?: unknown; pm25?: unknown };
  if (typeof s.tier === 'string') {
    if (!isTier(s.tier)) throw new ValidationError(`tier must be one of GREEN, YELLOW, ORANGE, RED`);
    return { pm25: tierToRepresentativePm25(s.tier as Tier), ts: new Date().toISOString() };
  }
  if (typeof s.pm25 === 'number') {
    if (s.pm25 < 0 || s.pm25 > 1000) throw new ValidationError('pm25 must be between 0 and 1000');
    return { pm25: s.pm25, ts: new Date().toISOString() };
  }
  throw new ValidationError('provide either { tier } or { pm25 }');
}

export async function getStatus(id: string): Promise<Record<string, unknown>> {
  const school = await getSchool(id);
  if (!school) throw new NotFoundError(`school ${id} not found`);
  const history = await getRecentReadings(id, 24);
  const latest = history[0] ?? null;
  let advisory: { en: string; hi: string } | null = null;
  if (latest?.tier) {
    const tier = latest.tier as Tier;
    advisory = { en: await getAdvisory('en', tier), hi: await getAdvisory('hi', tier) };
  }
  return { school, latest, advisory, history };
}

export async function simulate(id: string, sim: { tier?: string; pm25?: number }): Promise<Record<string, unknown>> {
  const school = await getSchool(id);
  if (!school) throw new NotFoundError(`school ${id} not found`);
  const { pm25, ts } = simulateToReading(sim);
  const topicArn = getTopicArn();
  const publish = async (schoolId: string, subject: string, body: string) => {
    if (topicArn) await snsApi.publish(topicArn, schoolId, subject, body);
    else console.error(JSON.stringify({ msg: 'no ALERT_TOPIC_ARN set; alert skipped', schoolId }));
  };
  await evaluateSchool(school, pm25, 'simulated', undefined, ts, publish);
  return getStatus(id);
}

async function readJsonBody(event: APIGatewayProxyEventV2 | { body?: string | null }): Promise<unknown> {
  const raw = event.body;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new ValidationError('body is not valid JSON'); }
}

async function route(event: APIGatewayProxyEventV2): Promise<{ statusCode: number; body: string }> {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.requestContext?.http?.path ?? '/';
  const pathParts = path.replace(/\/+$/, '').split('/').filter(Boolean); // e.g. ['schools','sch_x','status']

  if (method === 'POST' && pathParts[0] === 'schools' && pathParts.length === 1) {
    const input = validateSchoolInput(await readJsonBody(event));
    const school = await createSchool(input);
    return { statusCode: 201, body: JSON.stringify(school) };
  }

  if (method === 'GET' && pathParts[0] === 'schools' && pathParts.length === 1) {
    const schools = await getAllSchools();
    return { statusCode: 200, body: JSON.stringify(schools) };
  }

  if (method === 'GET' && pathParts[0] === 'schools' && pathParts[2] === 'status' && pathParts[1]) {
    const status = await getStatus(pathParts[1]);
    return { statusCode: 200, body: JSON.stringify(status) };
  }

  if (method === 'POST' && pathParts[0] === 'schools' && pathParts[2] === 'simulate' && pathParts[1]) {
    const sim = await readJsonBody(event);
    const result = await simulate(pathParts[1], sim as { tier?: string; pm25?: number });
    return { statusCode: 200, body: JSON.stringify(result) };
  }

  return { statusCode: 404, body: JSON.stringify({ error: `no route for ${method} ${path}` }) };
}

export const handler = async (event: APIGatewayProxyEventV2) => {
  try {
    const r = await route(event);
    const withCors = { ...json(r.statusCode, JSON.parse(r.body)) };
    return withCors;
  } catch (err) {
    if (err instanceof ValidationError) return json(400, { error: err.message, statusCode: 400 });
    if (err instanceof NotFoundError) return json(404, { error: err.message, statusCode: 404 });
    console.error(JSON.stringify({ msg: 'unhandled api error', error: String(err) }));
    return json(500, { error: 'internal error', statusCode: 500 });
  }
};
