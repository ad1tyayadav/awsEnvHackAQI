// fetchAndEvaluate Lambda handler.
// EventBridge (Phase 5) or manual invoke: for every school fetch the nearest
// OpenAQ PM2.5 reading and run the shared evaluate-and-alert path, which stores
// the reading, publishes an SNS alert on tier escalation, and always updates
// the school's lastAlertTier.
import { getAllSchools } from '../../lib/db';
import { fetchNearestPM25, OpenAqError } from '../../lib/openaq';
import { evaluateSchool } from '../../lib/evaluate';
import { snsApi } from '../../lib/alerts';

export const handler = async (event: { body?: string | null } = {}) => {
  const apiKey = process.env.OPENAQ_API_KEY ?? '';
  const topicArn = process.env.ALERT_TOPIC_ARN ?? '';

  const publish = async (schoolId: string, subject: string, body: string) => {
    if (!topicArn) {
      console.error(JSON.stringify({ msg: 'no ALERT_TOPIC_ARN, alert not published', schoolId }));
      return;
    }
    await snsApi.publish(topicArn, schoolId, subject, body);
  };

  const schools = await getAllSchools();
  console.log(JSON.stringify({ msg: 'fetchAndEvaluate start', schools: schools.length }));

  let ok = 0, failed = 0;
  for (const school of schools) {
    try {
      const r = await fetchNearestPM25(school.lat, school.lng, apiKey);
      const result = await evaluateSchool(school, r.pm25, 'openaq', r.stationName, r.measuredAt, publish);
      ok += 1;
      if (!result.alertSent) {
        console.log(JSON.stringify({ msg: 'evaluated', schoolId: school.schoolId, tier: result.tier }));
      }
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
