// OpenAQ v3 client: nearest-station PM2.5 lookup.
// Docs used: https://docs.openaq.org/using-the-api/geospatial (point+radius query),
// /resources/sensors (sensor.latest.value), /resources/latest (datetime shape).
// API shape was confirmed from official docs on 2026-10-10, not guessed.

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
const STALE_MS = 3 * 60 * 60 * 1000; // PRD: data older than 3 hours is stale

/** Minimal fetch we depend on, so tests can stub it without a real network. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** True when a station list contains a map-able pm25 sensor. */
function hasPm25Sensor(location: unknown): boolean {
  const loc = location as { sensors?: { parameter?: { name?: string } }[] };
  return (
    Array.isArray(loc?.sensors) &&
    loc.sensors.some((s) => s?.parameter?.name === 'pm25')
  );
}

/**
 * Fetch the nearest location with a pm25 sensor using the point+radius query:
 *   GET /v3/locations?coordinates=<lat>,<lng>&radius=<m>
 * (coordinates param is latitude,longitude per docs; radius max 25,000 m)
 */
export async function findNearestPm25Location(
  lat: number,
  lng: number,
  apiKey: string,
  radiusM = MAX_RADIUS_M,
  fetchLike: FetchLike = fetch
): Promise<{ id: number; name: string }> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new OpenAqError('api_error', `invalid coordinates lat=${lat} lng=${lng}`);
  }

  const url =
    `https://api.openaq.org/v3/locations` +
    `?coordinates=${lat},${lng}&radius=${radiusM}`; // docs: coordinates = lat,lng

  const res = await fetchWithTimeout(url, apiKey, fetchLike);
  if (!res.ok) throw new OpenAqError('api_error', `locations query HTTP ${res.status}`);

  const body = (await res.json()) as { results?: unknown[] };
  const results = Array.isArray(body.results) ? body.results : [];
  const station = results.find(hasPm25Sensor);

  if (!station) throw new OpenAqError('no_station', 'no station with a pm25 sensor within radius');
  const s = station as { id: number; name: string };
  return { id: s.id, name: s.name };
}

/** GET /v3/sensors/{id} — the sensor record embeds `latest` (datetime, value). */
export async function fetchSensorLatest(
  sensorId: number,
  apiKey: string,
  fetchLike: FetchLike = fetch
): Promise<{ value: number; utc: string }> {
  const res = await fetchWithTimeout(`https://api.openaq.org/v3/sensors/${sensorId}`, apiKey, fetchLike);
  if (!res.ok) throw new OpenAqError('api_error', `sensors query HTTP ${res.status}`);
  const body = (await res.json()) as { results?: unknown[] };
  const r = body.results?.[0] as
    | { latest?: { value: number; datetime?: { utc?: string } }; parameter?: { name?: string } }
    | undefined;
  if (!r?.latest) throw new OpenAqError('api_error', 'sensor response missing latest');
  if (r.parameter?.name !== 'pm25') throw new OpenAqError('api_error', 'sensor is not pm25');
  if (typeof r.latest.value !== 'number') throw new OpenAqError('api_error', 'latest value not a number');
  const utc = r.latest.datetime?.utc;
  if (typeof utc !== 'string') throw new OpenAqError('api_error', 'latest datetime missing');
  return { value: r.latest.value, utc };
}

/** Fetch the nearest recent PM2.5 reading (µg/m³) for a coordinate. Throws OpenAqError on any failure. */
export async function fetchNearestPM25(
  lat: number,
  lng: number,
  apiKey: string,
  fetchLike: FetchLike = fetch
): Promise<Pm25Reading> {
  const station = await findNearestPm25Location(lat, lng, apiKey, MAX_RADIUS_M, fetchLike);

  // Find the location's pm25 sensor id from the /locations response we already have.
  const res = await fetchWithTimeout(
    `https://api.openaq.org/v3/locations/${station.id}`,
    apiKey,
    fetchLike
  );
  if (!res.ok) throw new OpenAqError('api_error', `location detail HTTP ${res.status}`);
  const body = (await res.json()) as { results?: unknown[] };
  const loc = body.results?.[0] as { sensors?: { id: number; parameter?: { name?: string } }[] } | undefined;
  const sensor = loc?.sensors?.find((s) => s?.parameter?.name === 'pm25');
  if (!sensor) throw new OpenAqError('no_station', 'nearest station has no pm25 sensor');
  if (!sensor.id) throw new OpenAqError('api_error', 'pm25 sensor id missing');

  const { value, utc } = await fetchSensorLatest(sensor.id, apiKey, fetchLike);
  checkFreshness(value, utc);

  return { pm25: value, stationName: station.name, stationId: station.id, measuredAt: utc };
}

/** Reject readings older than 3 hours (PRD phase 2 requirement). */
export function checkFreshness(_pm25: number, measuredAtUtc: string, now = Date.now()): void {
  const t = new Date(measuredAtUtc).getTime();
  if (!Number.isFinite(t)) throw new OpenAqError('stale_data', 'unparseable measurement time');
  if (now - t > STALE_MS) throw new OpenAqError('stale_data', `measurement is older than 3 hours (${measuredAtUtc})`);
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
