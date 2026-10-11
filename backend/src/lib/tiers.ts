// AQI -> action tier mapping and alert dedupe rule (PRD section 6). Pure functions.
export type Tier = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';

const TIER_RANK: Record<Tier, number> = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3 };

export function isTier(v: string): v is Tier {
  return v === 'GREEN' || v === 'YELLOW' || v === 'ORANGE' || v === 'RED';
}

/** GREEN <=100, YELLOW 101-200, ORANGE 201-300, RED 301+. */
export function aqiToTier(aqi: number): Tier {
  if (!Number.isInteger(aqi) || aqi < 0 || aqi > 500) {
    throw new RangeError(`aqi must be an integer in 0..500, got ${aqi}`);
  }
  if (aqi <= 100) return 'GREEN';
  if (aqi <= 200) return 'YELLOW';
  if (aqi <= 300) return 'ORANGE';
  return 'RED';
}

/**
 * PRD dedupe rule: alert only when the new tier is ORANGE or RED and is an
 * escalation over the previous tier (strictly higher rank). Same tier and any
 * recovery (RED->ORANGE/GREEN) sends no alert; recovery is handled separately.
 */
export function shouldAlert(previousTier: Tier | null, newTier: Tier): boolean {
  if (newTier !== 'ORANGE' && newTier !== 'RED') return false;
  const prevRank = previousTier ? TIER_RANK[previousTier] : -1;
  return TIER_RANK[newTier] > prevRank;
}
