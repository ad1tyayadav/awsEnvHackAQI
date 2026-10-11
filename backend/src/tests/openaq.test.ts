import { test, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchNearestPM25,
  fetchSensorLatest,
  checkFreshOk,
  type FetchLike,
} from '../lib/openaq';

// Tiny stub Response to avoid needing any real network in unit tests.
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response as Response;
}

let lastUrl = '';
const fetchMock = (fn: (url: string, init?: RequestInit) => Promise<Response>): FetchLike =>
  (url, init) => { lastUrl = url; return fn(url, init); };

const KEY = 'test-key';

// --- fetchSensorLatest: shape handling -------------------------------------
test('fetchSensorLatest parses latest value', async () => {
  const f = fetchMock(async () =>
    jsonResponse(200, {
      results: [
        {
          parameter: { name: 'pm25' },
          latest: { value: 112.4, datetime: { utc: '2026-10-10T06:00:00Z' } },
        },
      ],
    })
  );
  const r = await fetchSensorLatest(3920, KEY, f);
  expect(r.value).toBe(112.4);
  expect(r.utc).toBe('2026-10-10T06:00:00Z');
});

test('fetchSensorLatest rejects non-pm25 / bad shapes', async () => {
  const missing = fetchMock(async () => jsonResponse(200, { results: [{ id: 1 }] }));
  await expect(fetchSensorLatest(1, KEY, missing)).rejects.toMatchObject({ reason: 'api_error' });
  const notNumber = fetchMock(async () =>
    jsonResponse(200, { results: [{ parameter: { name: 'pm25' }, latest: { value: 'oops' } }] })
  );
  await expect(fetchSensorLatest(1, KEY, notNumber)).rejects.toMatchObject({ reason: 'api_error' });
});

// --- fetchNearestPM25: the full path ----------------------------------------
beforeEach(() => { lastUrl = ''; });
afterEach(() => { lastUrl = ''; });

const LOCATION_BODY = {
  results: [
    {
      id: 1,
      name: 'Anand Vihar',
      sensors: [{ id: 3920, parameter: { name: 'pm25' } }],
    },
  ],
};

test('fetchNearestPM25 happy path returns fresh reading', async () => {
  const now = Date.now();
  const fresh = new Date(now - 10 * 60 * 1000).toISOString(); // 10 minutes ago

  const f: FetchLike = async (url) => {
    if (url.includes('/v3/locations?coordinates=')) return jsonResponse(200, LOCATION_BODY);
    if (url.includes('/v3/locations/1')) return jsonResponse(200, LOCATION_BODY);
    if (url.includes('/v3/sensors/3920'))
      return jsonResponse(200, {
        results: [{ parameter: { name: 'pm25' }, latest: { value: 103.1, datetime: { utc: fresh } } }],
      });
    throw new Error(`unexpected url ${url}`);
  };

  const r = await fetchNearestPM25(28.6, 77.2, KEY, f);
  expect(r.pm25).toBe(103.1);
  expect(r.stationName).toBe('Anand Vihar');
  expect(r.stationId).toBe(1);
  expect(r.measuredAt).toBe(fresh);
});

test('fetchNearestPM25 throws stale_data when reading older than 96h', async () => {
  const stale = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString(); // > 4 days
  const f: FetchLike = async (url) => {
    if (url.includes('/v3/locations?coordinates=') || url.includes('/v3/locations/'))
      return jsonResponse(200, LOCATION_BODY);
    return jsonResponse(200, {
      results: [{ parameter: { name: 'pm25' }, latest: { value: 50, datetime: { utc: stale } } }],
    });
  };
  await expect(fetchNearestPM25(28.6, 77.2, KEY, f)).rejects.toMatchObject({ reason: 'stale_data' });
});

test('fetchNearestPM25 throws no_station when no nearby station has a pm25 sensor', async () => {
  const f = fetchMock(async () =>
    jsonResponse(200, { results: [{ id: 2, name: 'x', sensors: [{ parameter: { name: 'no2' } }] }] })
  );

  await expect(fetchNearestPM25(28.6, 77.2, KEY, f)).rejects.toMatchObject({ reason: 'no_station' });
});

test('fetchNearestPM25 throws api_error when the locations query is rejected', async () => {
  const f = fetchMock(async () => jsonResponse(401, { detail: 'bad key' }));

  await expect(fetchNearestPM25(28.6, 77.2, KEY, f)).rejects.toMatchObject({ reason: 'api_error' });
});

test('fetchNearestPM25 throws timeout when the network stalls', async () => {
  const f: FetchLike = () =>
    Promise.reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));

  await expect(fetchNearestPM25(28.6, 77.2, KEY, f)).rejects.toMatchObject({ reason: 'timeout' });
});

// --- freshness helper (the live path: it returns, it does not throw) ---------
test('checkFreshOk accepts a recent reading and rejects old or unparseable ones', () => {
  expect(checkFreshOk(new Date(Date.now() - 10 * 60 * 1000).toISOString())).toBe(true);
  expect(checkFreshOk(new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString())).toBe(false);
  expect(checkFreshOk('not-a-date')).toBe(false);
});
