import { test, expect, beforeEach, afterEach } from 'vitest';
import {
  fetchNearestPM25,
  fetchLocationLatestPm25,
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
const agoIso = (hours: number): string => new Date(Date.now() - hours * 3600 * 1000).toISOString();

/** One station as /v3/locations returns it: pm25 sensor ids + when it last reported. */
function station(input: {
  id: number;
  name: string;
  pm25Sensors: number[];
  datetimeLast?: string;
  distance: number;
}): unknown {
  return {
    id: input.id,
    name: input.name,
    distance: input.distance,
    ...(input.datetimeLast ? { datetimeLast: { utc: input.datetimeLast } } : {}),
    sensors: input.pm25Sensors.map((sid) => ({ id: sid, parameter: { name: 'pm25' } })),
  };
}

/** One /v3/locations/{id}/latest result row (no parameter name, matched by sensorsId). */
function latestRow(sensorsId: number, value: number, utc: string): unknown {
  return { sensorsId, value, datetime: { utc } };
}

const KEYWORD = 'Anand Vihar';

// --- fetchLocationLatestPm25: matching rows back to the live pm25 sensor -----
beforeEach(() => { lastUrl = ''; });
afterEach(() => { lastUrl = ''; });

test('fetchLocationLatestPm25 matches a pm25 sensor by id and returns its newest value', async () => {
  const fresh = agoIso(1);
  const other = agoIso(1);
  const f = fetchMock(async () =>
    jsonResponse(200, {
      results: [
        latestRow(1, 999, agoIso(500)), // dead sensor, older
        latestRow(2, 55, fresh), // live pm25 sensor
        latestRow(3, 400, other), // some other parameter
      ],
    })
  );
  const loc = { id: 17, name: 'R K Puram', sensors: [{ id: 1, parameter: { name: 'pm25' } }, { id: 2, parameter: { name: 'pm25' } }] };

  const r = await fetchLocationLatestPm25(loc, KEY, f);

  expect(lastUrl).toContain('/v3/locations/17/latest');
  expect(r).toEqual({ value: 55, utc: fresh });
});

test('fetchLocationLatestPm25 returns null when nothing maps to a pm25 sensor', async () => {
  const f = fetchMock(async () => jsonResponse(200, { results: [latestRow(3, 400, agoIso(1))] }));
  const loc = { id: 17, name: 'R K Puram', sensors: [{ id: 1, parameter: { name: 'pm25' } }] };

  expect(await fetchLocationLatestPm25(loc, KEY, f)).toBeNull();
});

// --- fetchNearestPM25: the full path ----------------------------------------
const LOCATIONS_BODY = { results: [station({ id: 1, name: 'Anand Vihar', pm25Sensors: [3920], datetimeLast: agoIso(1), distance: 1200 })] };

test('fetchNearestPM25 happy path returns a fresh reading', async () => {
  const fresh = agoIso(1);
  const f: FetchLike = async (url) => {
    if (url.includes('/v3/locations?coordinates=')) return jsonResponse(200, LOCATIONS_BODY);
    if (url.includes('/v3/locations/1/latest')) return jsonResponse(200, { results: [latestRow(3920, 103.1, fresh)] });
    throw new Error(`unexpected url ${url}`);
  };

  const r = await fetchNearestPM25(28.6, 77.2, KEY, f);

  expect(r.pm25).toBe(103.1);
  expect(r.stationName).toBe('Anand Vihar');
  expect(r.stationId).toBe(1);
  expect(r.measuredAt).toBe(fresh);
});

test('fetchNearestPM25 prefers the live pm25 sensor over a dead one at the same station', async () => {
  // The old code took the FIRST pm25 sensor, which can be years dead.
  const fresh = agoIso(2);
  const body = { results: [station({ id: 1, name: KEYWORD, pm25Sensors: [35, 12234787], datetimeLast: fresh, distance: 900 })] };
  const f: FetchLike = async (url) => {
    if (url.includes('/v3/locations?coordinates=')) return jsonResponse(200, body);
    if (url.includes('/v3/locations/1/latest'))
      return jsonResponse(200, { results: [latestRow(35, 201, '2018-02-21T21:15:00Z'), latestRow(12234787, 80, fresh)] });
    throw new Error(`unexpected url ${url}`);
  };

  const r = await fetchNearestPM25(28.6, 77.2, KEY, f);

  expect(r.pm25).toBe(80);
  expect(r.measuredAt).toBe(fresh);
});

test('fetchNearestPM25 picks the freshest station when the nearest one has gone quiet', async () => {
  // Nearest station last reported years ago; one 6 km away has fresh data.
  const body = {
    results: [
      station({ id: 1, name: 'Quiet station', pm25Sensors: [10], datetimeLast: '2018-02-21T21:15:00Z', distance: 500 }),
      station({ id: 2, name: 'Live station', pm25Sensors: [20], datetimeLast: agoIso(1), distance: 6000 }),
    ],
  };
  const f: FetchLike = async (url) => {
    if (url.includes('/v3/locations?coordinates=')) return jsonResponse(200, body);
    if (url.includes('/v3/locations/2/latest')) return jsonResponse(200, { results: [latestRow(20, 64, agoIso(1))] });
    throw new Error(`unexpected url ${url}`);
  };

  const r = await fetchNearestPM25(28.6, 77.2, KEY, f);

  expect(r.stationName).toBe('Live station');
  expect(r.pm25).toBe(64);
});

test('fetchNearestPM25 throws stale_data when every reachable reading is older than the window', async () => {
  const old = agoIso(300); // > 7 days
  const body = { results: [station({ id: 1, name: KEYWORD, pm25Sensors: [3920], datetimeLast: old, distance: 500 })] };
  const f: FetchLike = async (url) => {
    if (url.includes('/v3/locations?coordinates=')) return jsonResponse(200, body);
    return jsonResponse(200, { results: [latestRow(3920, 50, old)] });
  };

  await expect(fetchNearestPM25(28.6, 77.2, KEY, f)).rejects.toMatchObject({ reason: 'stale_data' });
});

test('fetchNearestPM25 throws api_error (not stale_data) when every station lookup fails', async () => {
  const body = { results: [station({ id: 1, name: KEYWORD, pm25Sensors: [3920], datetimeLast: agoIso(1), distance: 500 })] };
  const f: FetchLike = async (url) => {
    if (url.includes('/v3/locations?coordinates=')) return jsonResponse(200, body);
    return jsonResponse(500, { detail: 'boom' });
  };

  await expect(fetchNearestPM25(28.6, 77.2, KEY, f)).rejects.toMatchObject({ reason: 'api_error' });
});

test('fetchNearestPM25 throws no_station when no nearby station has a pm25 sensor', async () => {
  const f = fetchMock(async () =>
    jsonResponse(200, { results: [{ id: 2, name: 'x', sensors: [{ id: 1, parameter: { name: 'no2' } }] }] })
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
  // a few days late is still usable (Indian sensors routinely lag) ...
  expect(checkFreshOk(new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString())).toBe(true);
  // ... but a reading from last month is not.
  expect(checkFreshOk(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())).toBe(false);
  expect(checkFreshOk('not-a-date')).toBe(false);
});
