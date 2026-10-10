// Bilingual advisory (PRD phase 4): 'en' from code; 'hi' from Amazon Translate,
// cached in AdvisoryCacheTable; on Translate failure falls back to English.
import { getAdvisoryCached, putAdvisoryCached } from './db';
import { getAdvisoryText } from './advisory';
import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import type { Tier } from './tiers';

export type Lang = 'en' | 'hi';

let translateClient: TranslateClient | null = null;
function getTranslateClient(): TranslateClient {
  if (!translateClient) translateClient = new TranslateClient({});
  return translateClient;
}

/** Overridable for tests. */
export let translateTextApi: (text: string) => Promise<string> = async (text) => {
  const client = getTranslateClient();
  const res = await client.send(
    new TranslateTextCommand({
      Text: text,
      SourceLanguageCode: 'en',
      TargetLanguageCode: 'hi',
    })
  );
  return res.TranslatedText ?? '';
};

export function setTranslateApiForTesting(fn: (text: string) => Promise<string>): void {
  translateTextApi = fn;
}

export async function getAdvisory(lang: Lang, tier: Tier): Promise<string> {
  const english = getAdvisoryText(tier);
  if (lang === 'en') return english;

  const cacheKey = `${tier}#hi`;
  const cached = await getAdvisoryCached(cacheKey);
  if (cached) return cached;

  try {
    const hindi = await translateTextApi(english);
    if (!hindi) throw new Error('empty translation');
    await putAdvisoryCached(cacheKey, hindi);
    return hindi;
  } catch (err) {
    console.error(JSON.stringify({ msg: 'translate failed, using English fallback', tier, error: String(err) }));
    return english;
  }
}
