// Citizen alert fan-out (Phase 9R, task 9R.7).
//
// This is what makes the bot automatic: on every scheduled run we take all
// active subscribers, bucket them by their ~2 km locKey, and fetch OpenAQ ONCE
// per bucket. Everyone in a bucket gets the same reading, so a thousand users
// in one neighbourhood still cost one API call.
//
// Alerting uses the same rule as the schools path: `shouldAlert` fires only on
// an escalation into ORANGE or RED, and each subscriber carries their own
// `lastAlertTier`, so nobody is told twice about the same bad day.
import { pm25ToAqi } from './aqi';
import { formatAlert } from './bot';
import { OpenAqError, type Pm25Reading } from './openaq';
import { groupByLocKey, type Subscriber } from './subscribers';
import type { TgClient } from './telegram';
import { aqiToTier, isTier, shouldAlert, type Tier } from './tiers';

export interface FanoutDeps {
  tg: TgClient;
  listActiveCitizens(): Promise<Subscriber[]>;
  fetchPm25(lat: number, lng: number): Promise<Pm25Reading>;
  setLastAlertTier(chatId: string, tier: string | null): Promise<void>;
  markBlocked(chatId: string): Promise<void>;
}

export interface FanoutSummary {
  /** neighbourhoods we tried to monitor (= number of OpenAQ lookups) */
  groups: number;
  openAqFetches: number;
  skippedGroups: number;
  subscribers: number;
  alertsSent: number;
  blocked: number;
  sendFailures: number;
}

/**
 * Runs one monitoring cycle. Never throws for a single bad group or a single
 * failed send: one unreachable station or one blocked user must not stop the
 * rest of the neighbourhoods from being alerted.
 */
export async function runCitizenFanout(deps: FanoutDeps): Promise<FanoutSummary> {
  const subscribers = await deps.listActiveCitizens();
  const groups = groupByLocKey(subscribers);

  const summary: FanoutSummary = {
    groups: groups.size,
    openAqFetches: 0,
    skippedGroups: 0,
    subscribers: subscribers.length,
    alertsSent: 0,
    blocked: 0,
    sendFailures: 0,
  };

  for (const [locKey, members] of groups) {
    // Any member's coordinates can stand in for the whole cell.
    const anchor = members.find((m) => typeof m.lat === 'number' && typeof m.lng === 'number');
    if (!anchor) {
      summary.skippedGroups += 1;
      console.warn(JSON.stringify({ msg: 'fanout group has no usable coordinates', locKey }));
      continue;
    }

    let reading: Pm25Reading;
    try {
      reading = await deps.fetchPm25(anchor.lat as number, anchor.lng as number);
      summary.openAqFetches += 1;
    } catch (err) {
      summary.skippedGroups += 1;
      const reason = err instanceof OpenAqError ? `${err.reason}: ${err.detail}` : String(err);
      console.warn(JSON.stringify({ msg: 'fanout group fetch failed', locKey, error: reason }));
      continue;
    }

    const { aqi } = pm25ToAqi(reading.pm25);
    const tier: Tier = aqiToTier(aqi);
    const alertText = formatAlert(tier, aqi, reading);
    let alerts = 0;
    let skipped = 0;

    for (const sub of members) {
      const previous: Tier | null = isTier(sub.lastAlertTier ?? '') ? (sub.lastAlertTier as Tier) : null;

      if (!shouldAlert(previous, tier)) {
        // Either the air is fine or we have already told them about this level.
        // Keep the record current so the NEXT rise is measured against today.
        await deps.setLastAlertTier(sub.chatId, tier);
        skipped += 1;
        continue;
      }

      const res = await deps.tg.sendMessage(sub.chatId, alertText);
      if (res.ok) {
        await deps.setLastAlertTier(sub.chatId, tier);
        summary.alertsSent += 1;
        alerts += 1;
      } else if (res.blocked) {
        await deps.markBlocked(sub.chatId);
        summary.blocked += 1;
      } else {
        // Deliberately do NOT record the tier: the next run retries this alert
        // instead of silently losing it.
        summary.sendFailures += 1;
        console.error(JSON.stringify({ msg: 'fanout send failed', chatId: sub.chatId, error: res.error }));
      }
    }

    console.log(
      JSON.stringify({ msg: 'fanout group done', locKey, tier, aqi, members: members.length, alerts, skipped })
    );
  }

  console.log(JSON.stringify({ msg: 'fanout summary', ...summary }));
  return summary;
}
