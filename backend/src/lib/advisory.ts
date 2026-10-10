// English action plan per tier (exact wording from PRD section 6). Pure function.
import type { Tier } from './tiers';

const ADVISORY_EN: Record<Tier, string> = {
  GREEN: 'Normal activities. No restrictions.',
  YELLOW:
    'Children with asthma or breathing problems should avoid heavy exercise outdoors. Shorten outdoor PE and keep water available.',
  ORANGE:
    'Cancel outdoor sports and assemblies. Keep classroom windows closed. Bus children and outdoor-duty staff should wear N95 masks. Keep children with asthma indoors.',
  RED: 'All outdoor activity stopped. Keep everyone indoors with windows closed. N95 masks for travel to and from school. Parents are advised to keep children at home if possible. Follow any official order from the local education authority.',
};

export function getAdvisoryText(tier: Tier): string {
  const text = ADVISORY_EN[tier];
  if (!text) throw new Error(`unknown tier: ${tier}`);
  return text;
}

export const DISCLAIMER =
  'Advisories are guidance based on hourly PM2.5 estimates and do not replace official orders from local authorities.';
