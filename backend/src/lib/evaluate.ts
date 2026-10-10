// Shared evaluate-and-alert path used by BOTH the scheduled fetch and the
// simulate endpoint (PRD section 5: do not duplicate this logic).
import { putReading, updateSchoolLastAlertTier, putAlertRow, type School, type Reading } from './db';
import { pm25ToAqi } from './aqi';
import { aqiToTier, shouldAlert, type Tier } from './tiers';
import { getAdvisory } from './advisoryI18n';
import { formatAlertEmail } from './alerts';

export interface EvaluateResult {
  schoolId: string;
  ts: string;
  pm25: number;
  aqi: number;
  category: string;
  tier: Tier;
  source: 'openaq' | 'simulated';
  stationName?: string;
  alertSent: boolean;
}

export async function evaluateSchool(
  school: School,
  pm25: number,
  source: 'openaq' | 'simulated',
  stationName: string | undefined,
  measuredAt: string,
  publishFn: (schoolId: string, subject: string, body: string) => Promise<void>,
  now = new Date()
): Promise<EvaluateResult> {
  const { aqi, category } = pm25ToAqi(pm25);
  const tier = aqiToTier(aqi);
  const ts = measuredAt;

  const reading: Reading = {
    schoolId: school.schoolId,
    ts,
    pm25,
    aqi,
    category,
    tier,
    source,
    stationName,
    ttl: Math.floor(now.getTime() / 1000) + 7 * 24 * 3600,
  };
  await putReading(reading);

  let alertSent = false;
  if (shouldAlert((school.lastAlertTier as Tier | undefined) ?? null, tier)) {
    const advisoryEn = await getAdvisory('en', tier);
    const advisoryHi = await getAdvisory('hi', tier);
    const { subject, body } = formatAlertEmail(school.name, tier, aqi, advisoryEn, advisoryHi);
    await publishFn(school.schoolId, subject, body);
    await putAlertRow({
      schoolId: school.schoolId,
      ts,
      tier,
      aqi,
      subject,
      channel: 'email',
    });
    alertSent = true;
    console.log(JSON.stringify({ msg: 'alert sent', schoolId: school.schoolId, tier, aqi }));
  }

  // PRD: always update lastAlertTier after evaluation, alert or not.
  await updateSchoolLastAlertTier(school.schoolId, tier);

  return { schoolId: school.schoolId, ts, pm25, aqi, category, tier, source, stationName, alertSent };
}
