// fetchAndEvaluate Lambda handler — the citizen alert scheduler (Phase 9R).
//
// EventBridge runs this every 30 minutes. It buckets every active Telegram
// subscriber by their ~2 km neighbourhood, reads OpenAQ ONCE per neighbourhood,
// and messages the people whose air just escalated into ORANGE or RED.
//
// The evaluate-and-alert rules themselves live in lib/fanout.ts and are shared
// with nothing else, so there is exactly one copy of the decision logic.
import { runCitizenFanout } from '../../lib/fanout';
import { fetchNearestPM25 } from '../../lib/openaq';
import { listActiveCitizens, markBlocked, setLastAlertTier } from '../../lib/subscribers';
import { createTgClient } from '../../lib/telegram';

export const handler = async (event: { body?: string | null } = {}) => {
  const summary = await runCitizenFanout({
    tg: createTgClient(process.env.TELEGRAM_BOT_TOKEN ?? ''),
    listActiveCitizens,
    setLastAlertTier,
    markBlocked,
    fetchPm25: (lat, lng) => fetchNearestPM25(lat, lng, process.env.OPENAQ_API_KEY ?? ''),
  });

  const body = JSON.stringify({ citizens: summary });
  if (event.body !== undefined) return { statusCode: 200, body }; // invoked via API
  return body; // invoked via the EventBridge schedule
};
