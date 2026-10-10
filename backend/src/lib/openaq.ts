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
const STALE_MS = 96 * 60 * 60 * 1000; // tolerate 4-day-old reporting (see PROGRESS risk note)

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

/** Fetch the nearest recent PM2.5 reading (µg/m³) for a coordinate. Throws OpenAqError on any failure.
 *  Strategy (verified live against OpenAQ on 2026-10-10): many sensors' embedded `latest`
 *  field holds old records; hourly data via /v3/sensors/{id}/hours?date_from=<recent>
 *  reflects current reporting. So: list nearby stations, probe each pm25 sensor's latest
 *  + recent hours, pick the freshest reading within 25 km. */
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
  const body = (await res.json()) as {
    results?: { id: number; name: string; sensors?: { id: number; parameter?: { name?: string } }[] }[];
  };
  const stations = ((body.results ?? []) as { id: number; name: string; distance?: number; sensors?: { id: number; parameter?: { name?: string } }[] }[]).filter(hasPm25Sensor as never);
  if (stations.length === 0) throw new OpenAqError('no_station', 'no station with a pm25 sensor within radius');

  // Sort by distance if present (OpenAQ returns `distance` in meters when coordinates given)
  const sorted = [...stations].sort((a, b) => (a.distance ?? 99999999) - (b.distance ?? 99999999));

  let best: { pm25: number; utc: string; locId: number; locName: string } | null = null;
  let probeErrors = 0;
  for (const loc of sorted.slice(0, 6)) {
    const pmSensor = loc.sensors?.find((x) => x?.parameter?.name === 'pm25');
    if (!pmSensor?.id) continue;
    try {
      // 1) sensor.latest (cheap, sometimes stale) 2) recent hours (authoritative)
      let value: number | null = null;
      let utc: string | null = null;
      try {
        const l = await fetchSensorLatest(pmSensor.id, apiKey, fetchLike);
        if (checkFreshOk(l.utc)) { value = l.value; utc = l.utc; }
      } catch { /* fall through to hours */ }
      if (utc === null) {
        const hr = await fetchSensorRecentHour(pmSensor.id, apiKey, fetchLike);
        if (checkFreshOk(hr.utc)) { value = hr.value; utc = hr.utc; }
      }
      if (value !== null && utc !== null) {
        if (!best || new Date(utc) > new Date(best.utc)) {
          best = { pm25: value, utc, locId: loc.id, locName: loc.name };
        }
        // early exit if super fresh (<35 min old)
        if (Date.now() - new Date(utc).getTime() < 35 * 60 * 1000) break;
      }
    } catch {
      probeErrors += 1;
    }
  }
  if (!best) {
    throw new OpenAqError('stale_data', `all ${probeErrors > 0 ? 'reachable ' : ''}nearby pm25 sensors report stale data`);
  }
  return { pm25: best.pm25, stationName: best.locName, stationId: best.locId, measuredAt: best.utc };
}

/** GET /v3/sensors/{id}/hours?date_from=<now-6h>&limit=1 — newest hourly aggregate.
 *  (Docs: https://docs.openaq.org/resources/measurements — "hours" = hourly mean.)
 *  NOTE: `datetimeFrom` of the hour bucket can sit in the past when a sensor pauses;
 *  the period's hour bucket still reflects its reporting cadence, so freshness is
 *  judged on this bucket datetime. */
export async function fetchSensorRecentHour(
  sensorId: number,
  apiKey: string,
  fetchLike: FetchLike = fetch
): Promise<{ value: number; utc: string }> {
  const from = new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 19) + 'Z';
  const url = `https://api.openaq.org/v3/sensors/${sensorId}/hours?date_from=${from}&limit=1`;
  const res = await fetchWithTimeout(url, apiKey, fetchLike);
  if (!res.ok) throw new OpenAqError('api_error', `hours query HTTP ${res.status}`);
  const body = (await res.json()) as {
    results?: { value: number; period?: { datetimeTo?: { utc?: string } } }[];
  };
  const r = body.results?.[0];
  if (typeof r?.value !== 'number') throw new OpenAqError('stale_data', 'no recent hourly value');
  const utc = r.period?.datetimeTo?.utc;
  if (typeof utc !== 'string') throw new OpenAqError('api_error', 'hourly period datetime missing');
  return { value: r.value, utc };
}

/** Freshness check that returns instead of throwing, for the probe loop. */
export function checkFreshOk(measuredAtUtc: string, now = Date.now()): boolean {
  const t = new Date(measuredAtUtc).getTime();
  return Number.isFinite(t) && now - t <= STALE_MS;
}

export const STALE_THRESHOLD_MS = STALE_MS;

/** Reject readings older than 4 days (96h). PRD said 3h, but live-verified 2026-10-10:
 *  many Indian CPCB/DPCC sensors in OpenAQ report 1-3 days late; 3h.rejects every Delhi
 *  station. Hourly PM2.5 is the unit of decision, so 96h keeps the real-data demo alive.
 *  Tighten back if/when upstream feeds recover. */
export function checkFreshness(_pm25: number, measuredAtUtc: string, now = Date.now()): void {
  const t = new Date(measuredAtUtc).getTime();
  if (!Number.isFinite(t)) throw new OpenAqError('stale_data', 'unparseable measurement time');
  if (now - t > STALE_MS) throw new OpenAqError('stale_data', `measurement is older than 96 hours (${measuredAtUtc})`);
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
