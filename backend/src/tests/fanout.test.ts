// Tests for the citizen alert fan-out (Phase 9R, task 9R.7).
// Deps are injected, so there is no AWS, no OpenAQ and no Telegram here.
import { test, expect } from 'vitest';
import { runCitizenFanout, type FanoutDeps } from '../lib/fanout';
import { OpenAqError, type Pm25Reading } from '../lib/openaq';
import type { Subscriber } from '../lib/subscribers';

const reading = (pm25: number, stationName = 'DPCC Anand Vihar'): Pm25Reading => ({
  pm25,
  stationName,
  stationId: 1,
  measuredAt: '2026-10-11T06:00:00Z',
});

// pm25 105 -> AQI 249 -> ORANGE; 180 -> 346 -> RED; 25 -> <=50 -> GREEN
const ORANGE = reading(105);
const RED = reading(180);
const GREEN = reading(25);

const sub = (chatId: string, locKey: string, lastAlertTier: string | null = null, lat = 28.61, lng = 77.2): Subscriber => ({
  chatId, locKey, lat, lng, active: true, blocked: false, lastAlertTier,
  createdAt: 't', updatedAt: 't',
});

function fakeDeps(options: {
  subscribers: Subscriber[];
  reading?: Pm25Reading | 'fail';
  sendFails?: 'blocked' | 'network';
} = { subscribers: [] }) {
  const sent: { chatId: string | number; text: string }[] = [];
  const fetched: { lat: number; lng: number }[] = [];
  const tierWrites: { chatId: string; tier: string | null }[] = [];
  const blockedMarked: string[] = [];

  const deps: FanoutDeps = {
    tg: {
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        if (options.sendFails === 'blocked') return { ok: false, sent: 0, error: 'blocked', blocked: true };
        if (options.sendFails === 'network') return { ok: false, sent: 0, error: 'network', blocked: false };
        return { ok: true, sent: 1, messageIds: [1] };
      },
    },
    listActiveCitizens: async () => options.subscribers,
    fetchPm25: async (lat, lng) => {
      fetched.push({ lat, lng });
      if (options.reading === 'fail') throw new OpenAqError('no_station', 'no station within 25 km');
      return options.reading ?? ORANGE;
    },
    setLastAlertTier: async (chatId, tier) => {
      tierWrites.push({ chatId, tier });
    },
    markBlocked: async (chatId) => {
      blockedMarked.push(chatId);
    },
  };

  return { deps, sent, fetched, tierWrites, blockedMarked };
}

test('three neighbours on one bad day cost ONE OpenAQ call and send THREE alerts', async () => {
  const { deps, sent, fetched, tierWrites } = fakeDeps({
    subscribers: [sub('1', 'A'), sub('2', 'A'), sub('3', 'A')],
    reading: RED,
  });

  const summary = await runCitizenFanout(deps);

  expect(fetched).toHaveLength(1); // the whole point: one lookup, not three
  expect(sent).toHaveLength(3);
  expect(tierWrites).toEqual([
    { chatId: '1', tier: 'RED' },
    { chatId: '2', tier: 'RED' },
    { chatId: '3', tier: 'RED' },
  ]);
  expect(summary).toEqual({
    groups: 1, openAqFetches: 1, skippedGroups: 0, subscribers: 3,
    alertsSent: 3, blocked: 0, sendFailures: 0,
  });
});

test('a second run on the same bad day alerts nobody (the user is never spammed)', async () => {
  const { deps, sent } = fakeDeps({
    subscribers: [sub('1', 'A', 'RED'), sub('2', 'A', 'RED'), sub('3', 'A', 'RED')],
    reading: RED,
  });

  const summary = await runCitizenFanout(deps);

  expect(sent).toHaveLength(0);
  expect(summary.alertsSent).toBe(0);
});

test('an escalation from YELLOW to RED does alert', async () => {
  const { deps, sent } = fakeDeps({ subscribers: [sub('1', 'A', 'YELLOW')], reading: RED });

  const summary = await runCitizenFanout(deps);

  expect(sent).toHaveLength(1);
  expect(summary.alertsSent).toBe(1);
});

test('clean air sends nothing but still records the tier, so the next rise is measured correctly', async () => {
  const { deps, sent, tierWrites } = fakeDeps({ subscribers: [sub('1', 'A', 'RED')], reading: GREEN });

  const summary = await runCitizenFanout(deps);

  expect(sent).toHaveLength(0);
  expect(summary.alertsSent).toBe(0);
  expect(tierWrites).toEqual([{ chatId: '1', tier: 'GREEN' }]);
});

test('each neighbourhood gets its own lookup, and only bad ones alert', async () => {
  const deps2 = fakeDeps({
    subscribers: [sub('1', 'A'), sub('2', 'B'), sub('3', 'B')],
    reading: ORANGE,
  });

  const summary = await runCitizenFanout(deps2.deps);

  expect(deps2.fetched).toHaveLength(2);
  expect(deps2.sent).toHaveLength(3);
  expect(summary.openAqFetches).toBe(2);
});

test('one unreachable station does not stop the other neighbourhoods', async () => {
  // Group A fails; group B has a readable station. Both must be attempted, and
  // only A is recorded as skipped.
  const mixed = fakeDeps({ subscribers: [sub('1', 'A'), sub('2', 'B')], reading: RED });
  let call = 0;
  const originalFetch = mixed.deps.fetchPm25;
  mixed.deps.fetchPm25 = async (lat, lng) => {
    call += 1;
    if (call === 1) throw new OpenAqError('no_station', 'nothing nearby');
    return originalFetch(lat, lng);
  };

  const summary = await runCitizenFanout(mixed.deps);

  expect(summary.groups).toBe(2);
  expect(summary.skippedGroups).toBe(1);
  expect(summary.alertsSent).toBe(1);
  expect(mixed.fetched).toHaveLength(1);
});

test('a group with no stored coordinates is skipped instead of fetched blindly', async () => {
  const noCoords = sub('1', 'A');
  delete noCoords.lat;
  delete noCoords.lng;
  const { deps, fetched } = fakeDeps({ subscribers: [noCoords], reading: RED });

  const summary = await runCitizenFanout(deps);

  expect(fetched).toHaveLength(0);
  expect(summary.skippedGroups).toBe(1);
});

test('a blocked user is marked blocked and not recorded as alerted', async () => {
  const { deps, blockedMarked, tierWrites } = fakeDeps({ subscribers: [sub('1', 'A')], reading: RED, sendFails: 'blocked' });

  const summary = await runCitizenFanout(deps);

  expect(blockedMarked).toEqual(['1']);
  expect(tierWrites).toHaveLength(0);
  expect(summary.blocked).toBe(1);
  expect(summary.alertsSent).toBe(0);
});

test('a transient send failure leaves the tier unset so the next run retries it', async () => {
  const { deps, tierWrites } = fakeDeps({ subscribers: [sub('1', 'A')], reading: RED, sendFails: 'network' });

  const summary = await runCitizenFanout(deps);

  expect(summary.sendFailures).toBe(1);
  expect(summary.alertsSent).toBe(0);
  expect(tierWrites).toHaveLength(0); // nothing recorded -> the alert is not lost
});

test('the alert text carries the tier, the reading and the action plan', async () => {
  const { deps, sent } = fakeDeps({ subscribers: [sub('1', 'A')], reading: RED });

  await runCitizenFanout(deps);

  const text = sent[0]!.text;
  expect(text).toContain('RED');
  expect(text).toContain('AQI 346');
  expect(text).toContain('PM2.5 180');
  expect(text).toContain('DPCC Anand Vihar');
  expect(text).toContain('06:00 UTC');
  expect(text).toContain('Stay indoors with windows closed');
  expect(text).toContain('do not replace official orders');
});

test('nobody to monitor is a cheap no-op', async () => {
  const { deps, fetched } = fakeDeps({ subscribers: [] });

  const summary = await runCitizenFanout(deps);

  expect(fetched).toHaveLength(0);
  expect(summary).toEqual({
    groups: 0, openAqFetches: 0, skippedGroups: 0, subscribers: 0,
    alertsSent: 0, blocked: 0, sendFailures: 0,
  });
});
