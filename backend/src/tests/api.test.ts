// API endpoint tests. DB and SNS fully mocked; exercises validation, routes, simulate path.
import { test, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  putSchool: vi.fn().mockResolvedValue(undefined),
  getSchool: vi.fn().mockResolvedValue(null),
  getAllSchools: vi.fn().mockResolvedValue([]),
  getRecentReadings: vi.fn().mockResolvedValue([]),
  putReading: vi.fn().mockResolvedValue(undefined),
  updateSchoolLastAlertTier: vi.fn().mockResolvedValue(undefined),
  putAlertRow: vi.fn().mockResolvedValue(undefined),
  getAdvisoryCached: vi.fn().mockResolvedValue(null),
  putAdvisoryCached: vi.fn().mockResolvedValue(undefined),
}));

const snsMock = vi.hoisted(() => ({
  publish: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn().mockResolvedValue('arn:aws:sns:ap-south-1:123:topic/subid'),
}));

beforeEach(() => {
  for (const m of Object.values(dbMock)) m.mockReset();
  dbMock.putSchool.mockResolvedValue(undefined);
  dbMock.getSchool.mockResolvedValue(null);
  dbMock.getAllSchools.mockResolvedValue([]);
  dbMock.getRecentReadings.mockResolvedValue([]);
  snsMock.publish.mockClear();
  snsMock.subscribe.mockClear();
  snsMock.subscribe.mockResolvedValue('arn:aws:sns:ap-south-1:123:topic/subid');
  process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:ap-south-1:123:topic';
});

vi.mock('../lib/db', () => dbMock);
vi.mock('../lib/alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/alerts')>();
  return { ...actual, snsApi: snsMock };
});
// freeze Hindi advisory so no Translate needed in tests
vi.doMock('../lib/advisoryI18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/advisoryI18n')>();
  return { ...actual, getAdvisory: async () => 'hindi-text-mock' };
});

const mod = await import('../functions/api');

const mkEvent = (method: string, path: string, body?: unknown) => ({
  requestContext: { http: { method, path } },
  body: body === undefined ? undefined : JSON.stringify(body),
}) as never as Parameters<typeof mod.handler>[0];

test('POST /schools creates school with id, subscribes each email', async () => {
  const res = await mod.handler(mkEvent('POST', '/schools', {
    name: 'PS 1', city: 'Delhi', lat: 28.6, lng: 77.2, contactEmails: ['a@x.com', 'b@x.com'],
  }));
  expect(res.statusCode).toBe(201);
  const created = JSON.parse(res.body);
  expect(created.schoolId).toMatch(/^sch_/);
  expect(created.lastAlertTier).toBeNull();
  expect(dbMock.putSchool).toHaveBeenCalledTimes(1);
  expect(snsMock.subscribe).toHaveBeenCalledTimes(2);
  expect(snsMock.subscribe.mock.calls[0]![2]).toBe(created.schoolId);
});

test('POST /schools rejects bad lat, missing name, >5 emails, bad email format', async () => {
  const bad = [
    { name: 'x', city: 'y', lat: 95, lng: 77, contactEmails: ['a@x.com'] }, // lat
    { city: 'y', lat: 10, lng: 77, contactEmails: ['a@x.com'] }, // no name
    { name: 'x', city: 'y', lat: 10, lng: 77, contactEmails: ['a@x.com','b@x.com','c@x.com','d@x.com','e@x.com','f@x.com'] }, // >5
    { name: 'x', city: 'y', lat: 10, lng: 77, contactEmails: ['notanemail'] }, // format
    { name: 'x', city: 'y', lat: 10, lng: 77, contactEmails: [] }, // empty
  ];
  for (const body of bad) {
    const res = await mod.handler(mkEvent('POST', '/schools', body));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/\w/);
  }
  expect(dbMock.putSchool).not.toHaveBeenCalled();
});

test('GET /schools returns list', async () => {
  dbMock.getAllSchools.mockResolvedValue([{ schoolId: 'a', name: 'A' }]);
  const res = await mod.handler(mkEvent('GET', '/schools'));
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)[0].schoolId).toBe('a');
});

test('GET /schools/{id}/status returns 404 for missing school', async () => {
  const res = await mod.handler(mkEvent('GET', '/schools/missing/status'));
  expect(res.statusCode).toBe(404);
});

test('GET /schools/{id}/status returns latest+advisory+history', async () => {
  dbMock.getSchool.mockResolvedValue({ schoolId: 's1', name: 'T', city: 'Delhi', lat: 28, lng: 77 });
  dbMock.getRecentReadings.mockResolvedValue([
    { schoolId: 's1', ts: 't1', pm25: 180, aqi: 329, category: 'Very Poor', tier: 'RED', source: 'simulated' },
  ]);
  const res = await mod.handler(mkEvent('GET', '/schools/s1/status'));
  expect(res.statusCode).toBe(200);
  const parsed = JSON.parse(res.body);
  expect(parsed.latest.tier).toBe('RED');
  expect(parsed.advisory.hi).toBe('hindi-text-mock');
  expect(parsed.history).toHaveLength(1);
});

test('simulate accepts tier and pm25, rejects garbage; runs shared pipeline', async () => {
  dbMock.getSchool.mockResolvedValue({ schoolId: 's1', name: 'T', city: 'D', lat: 28, lng: 77, lastAlertTier: null });
  dbMock.getRecentReadings.mockResolvedValue([
    { schoolId: 's1', ts: 'now', pm25: 180, aqi: 329, category: 'Very Poor', tier: 'RED', source: 'simulated' },
  ]);
  const res = await mod.handler(mkEvent('POST', '/schools/s1/simulate', { tier: 'RED' }));
  expect(res.statusCode).toBe(200);
  expect(snsMock.publish).toHaveBeenCalledTimes(1); // shared evaluate path fires alert
  const parsed = JSON.parse(res.body);
  expect(parsed.latest.tier).toBe('RED');
  expect(dbMock.updateSchoolLastAlertTier).toHaveBeenCalledWith('s1', 'RED');

  const res2 = await mod.handler(mkEvent('POST', '/schools/s1/simulate', { pm25: 42 }));
  expect(res2.statusCode).toBe(200);

  const bad = await mod.handler(mkEvent('POST', '/schools/s1/simulate', { tier: 'PURPLE' }));
  expect(bad.statusCode).toBe(400);
  const noBody = await mod.handler(mkEvent('POST', '/schools/s1/simulate', {}));
  expect(noBody.statusCode).toBe(400);
});

test('simulate on missing school returns 404', async () => {
  const res = await mod.handler(mkEvent('POST', '/schools/nope/simulate', { tier: 'RED' }));
  expect(res.statusCode).toBe(404);
});

test('unknown routes return 404 with JSON error', async () => {
  const res = await mod.handler(mkEvent('DELETE', '/schools'));
  expect(res.statusCode).toBe(404);
});
