// OpenAQ v3 client: nearest-station PM2.5 lookup.
// Docs used: https://docs.openaq.org/using-the-api/geospatial (point+radius query),
// /resources/locations (sensor list + datetimeLast), /resources/latest
// (GET /v3/locations/{id}/latest). Shape confirmed against the live API on
// 2026-10-11, not guessed:
//   - /v3/locations returns each station's `sensors` (id + parameter) and its
//     `datetimeLast` (the freshest measurement at that station).
//   - /v3/locations/{id}/latest returns one row per sensor as
//     { sensorsId, value, datetime } but WITHOUT the parameter name, so a row is
//     matched back to pm25 by `sensorsId`.
// A station keeps several pm25 sensors over its life and old ones stay in the
// list, so this matches by id and takes the newest value; picking the first pm25
// sensor (the old approach) often returned 2018 data from a dead sensor.

export interface Pm25Reading {
  pm25: number;
  stationName: string;
  stationId: number;
  measuredAt: string; // ISO UTC
}

/** Typed errors so callers can message principals clearly. */
export type OpenAqErrorReason =
  | 'no_station'
  | 'stale_data'
  | 'api_error'
  | 'timeout';

export class OpenAqError extends Error {
  reason: OpenAqErrorReason;
  detail: string;
  constructor(reason: OpenAqErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.detail = detail;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RADIUS_M = 25_000; // OpenAQ hard limit (docs: geospatial > point and radius)
const MAX_PROBE = 6; // stations checked per lookup (freshest-reporting first)
/** Tolerate old reporting: live-verified against OpenAQ (2026-10-11), many Indian
 *  CPCB/DPCC sensors land 1-4 days late, so a tight window rejects every station
 *  in a city on a quiet reporting day. Tighten this if the upstream feeds recover. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimal fetch we depend on, so tests can stub it without a real network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface OpenAqSensor {
  id: number;
  parameter?: { name?: string };
}

interface OpenAqLocation {
  id: number;
  name: string;
  distance?: number;
  /** freshest measurement at this station, any parameter */
  datetimeLast?: { utc?: string };
  sensors?: OpenAqSensor[];
}

/** The pm25 sensors a station exposes (0, 1 or several). */
function pm25SensorsOf(loc: OpenAqLocation): OpenAqSensor[] {
  return (loc.sensors ?? []).filter((s) => s?.parameter?.name === 'pm25' && typeof s.id === 'number');
}

/** True when a station list contains a map-able pm25 sensor. */
function hasPm25Sensor(loc: OpenAqLocation): boolean {
  return pm25SensorsOf(loc).length > 0;
}

/** Stations that report most recently first (distance breaks ties). Stations
 *  that stopped reporting years ago are pushed last, so a live reading is
 *  normally found in the first call or two. */
function lastReportedMs(loc: OpenAqLocation): number {
  const t = Date.parse(loc.datetimeLast?.utc ?? '');
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * GET /v3/locations/{id}/latest — the newest value for every sensor at one
 * station. Returns the freshest pm25 reading, or null when the station has no
 * pm25 value at all. Throws OpenAqError only on a transport/HTTP failure.
 */
export async function fetchLocationLatestPm25(
  loc: OpenAqLocation,
  apiKey: string,
  fetchLike: FetchLike = fetch
): Promise<{ value: number; utc: string } | null> {
  const res = await fetchWithTimeout(`https://api.openaq.org/v3/locations/${loc.id}/latest`, apiKey, fetchLike);
  if (!res.ok) throw new OpenAqError('api_error', `latest query HTTP ${res.status}`);
  const body = (await res.json()) as {
    results?: { value?: number; datetime?: { utc?: string }; sensorsId?: number }[];
  };
  const pm25Ids = new Set(pm25SensorsOf(loc).map((s) => s.id));

  let best: { value: number; utc: string } | null = null;
  for (const r of body.results ?? []) {
    if (typeof r.sensorsId !== 'number' || !pm25Ids.has(r.sensorsId)) continue;
    if (typeof r.value !== 'number') continue;
    const utc = r.datetime?.utc;
    if (typeof utc !== 'string' || !Number.isFinite(Date.parse(utc))) continue;
    if (!best || Date.parse(utc) > Date.parse(best.utc)) best = { value: r.value, utc };
  }
  return best;
}

/** Fetch the nearest recent PM2.5 reading (µg/m³) for a coordinate. Throws OpenAqError on any failure.
 *  Strategy (verified against the live OpenAQ API on 2026-10-11): list nearby
 *  stations, check the freshest-reporting ones first via /locations/{id}/latest,
 *  match each value to a live pm25 sensor, and keep the freshest pm25 reading
 *  within 25 km that is recent enough to act on. */
export async function fetchNearestPM25(
  lat: number,
  lng: number,
  apiKey: string,
  fetchLike: FetchLike = fetch
): Promise<Pm25Reading> {
  const res = await fetchWithTimeout(
    `https://api.openaq.org/v3/locations?coordinates=${lat},${lng}&radius=${MAX_RADIUS_M}&limit=25`,
    apiKey,
    fetchLike
  );
  if (!res.ok) throw new OpenAqError('api_error', `locations query HTTP ${res.status}`);
  const body = (await res.json()) as { results?: OpenAqLocation[] };
  const stations = (body.results ?? []).filter(hasPm25Sensor);
  if (stations.length === 0) throw new OpenAqError('no_station', 'no station with a pm25 sensor within radius');

  const candidates = [...stations]
    .sort((a, b) => lastReportedMs(b) - lastReportedMs(a) || (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, MAX_PROBE);

  let best: { pm25: number; utc: string; locId: number; locName: string } | null = null;
  let probeErrors = 0;
  for (const loc of candidates) {
    try {
      const reading = await fetchLocationLatestPm25(loc, apiKey, fetchLike);
      if (!reading || !checkFreshOk(reading.utc)) continue;
      if (!best || Date.parse(reading.utc) > Date.parse(best.utc)) {
        best = { pm25: reading.value, utc: reading.utc, locId: loc.id, locName: loc.name };
      }
      // early exit if super fresh (<35 min old)
      if (Date.now() - Date.parse(reading.utc) < 35 * 60 * 1000) break;
    } catch {
      probeErrors += 1;
    }
  }

  if (probeErrors === candidates.length) {
    // Every station was attempted and every one failed to answer: that is an
    // upstream/service problem, not a quiet station.
    throw new OpenAqError('api_error', `all ${candidates.length} nearby station lookups failed`);
  }
  if (!best) {
    throw new OpenAqError('stale_data', 'all reachable nearby pm25 stations report stale data');
  }
  return { pm25: best.pm25, stationName: best.locName, stationId: best.locId, measuredAt: best.utc };
}

/**
 * The freshness test used on the live path: true when a reading is recent enough
 * to act on. It returns instead of throwing so the probe loop can move on to the
 * next station. The window is 7 days (STALE_MS), not 3: live-verified against
 * OpenAQ (2026-10-11), Indian CPCB/DPCC sensors report 1-4 days late, so a tight
 * window rejects every station in a city that is merely between reporting runs.
 */
export function checkFreshOk(measuredAtUtc: string, now = Date.now()): boolean {
  const t = new Date(measuredAtUtc).getTime();
  return Number.isFinite(t) && now - t <= STALE_MS;
}

async function fetchWithTimeout(url: string, apiKey: string, fetchLike: FetchLike): Promise<Response> {
  try {
    return await fetchLike(url, {
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' }, // docs: v3 auth header
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof OpenAqError) throw err;
    if ((err as { name?: string })?.name === 'TimeoutError') {
      throw new OpenAqError('timeout', `request to ${url} timed out`);
    }
    throw new OpenAqError('api_error', `network failure: ${(err as Error).message}`);
  }
}
