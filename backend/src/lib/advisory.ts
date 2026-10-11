// Plain-language action plan per tier, written for a member of the public.
// Pure function: no AWS, no network. The wording is deliberately non-medical —
// sensitive groups are told to limit exertion and anything health-related is
// left to a doctor or an official advisory.
import type { Tier } from './tiers';

const ADVISORY_EN: Record<Tier, string> = {
  GREEN: 'Air is clean. Normal outdoor activity is fine.',
  YELLOW:
    'Most people can carry on as usual. If you have asthma, a heart or lung condition, or you are pregnant, limit long or heavy outdoor exertion.',
  ORANGE:
    'Avoid heavy outdoor exertion — running, cycling, outdoor workouts. Keep windows closed on busy roads and wear an N95 mask outdoors if you can.',
  RED: 'Stay indoors with windows closed and avoid outdoor exertion. Wear an N95 mask if you must travel. Follow any official advisory from your local authority.',
};

export function getAdvisoryText(tier: Tier): string {
  const text = ADVISORY_EN[tier];
  if (!text) throw new Error(`unknown tier: ${tier}`);
  return text;
}

export const DISCLAIMER =
  'Advisories are guidance based on hourly PM2.5 estimates and do not replace official orders from local authorities.';
