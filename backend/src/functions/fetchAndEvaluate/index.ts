// fetchAndEvaluate Lambda handler.
// Phase 2: loads all schools, fetches nearest PM2.5 from OpenAQ, stores readings.
// Phase 3/4 add AQI/tier computation and alerting on top.
import { getAllSchools, putReading } from '../../lib/db';
import { fetchNearestPM25, OpenAqError } from '../../lib/openaq';

interface ApiGatewayEvent {
  body?: string | null;
}

export const handler = async (event: ApiGatewayEvent = {}) => {
  const apiKey = process.env.OPENAQ_API_KEY ?? '';
  const schools = await getAllSchools();
  console.log(JSON.stringify({ msg: 'fetchAndEvaluate start', schools: schools.length }));

  let ok = 0, failed = 0;
  for (const school of schools) {
    try {
      const reading = await fetchNearestPM25(school.lat, school.lng, apiKey);
      await putReading({
        schoolId: school.schoolId,
        ts: reading.measuredAt,
        pm25: reading.pm25,
        source: 'openaq',
        stationName: reading.stationName,
        ttl: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      });
      ok += 1;
      console.log(JSON.stringify({
        msg: 'reading stored', schoolId: school.schoolId,
        pm25: reading.pm25, station: reading.stationName,
      }));
    } catch (err) {
      failed += 1;
      const reason = err instanceof OpenAqError ? `${err.reason}: ${err.detail}` : String(err);
      console.error(JSON.stringify({ msg: 'fetch failed', schoolId: school.schoolId, error: reason }));
    }
  }

  const body = JSON.stringify({ evaluated: schools.length, ok, failed });
  if (event.body !== undefined) return { statusCode: 200, body }; // invoked via API (Phase 5)
  return body; // invoked via EventBridge schedule
};
