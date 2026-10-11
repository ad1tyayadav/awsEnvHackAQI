// Telegram subscribers data access (Phase 9R, task 9R.3).
// One row per chat that ever pressed /start. The partition key is `chatId`
// (stored as a STRING: Telegram ids have up to 52 significant bits, which does
// not always survive a JS number round-trip safely in DynamoDB).
//
// A subscriber's `locKey` is their coordinates snapped to a ~2 km grid. The
// scheduler groups subscribers by locKey so one OpenAQ lookup serves everyone
// in the same neighbourhood (task 9R.7) instead of one call per person.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/** Grid step in degrees. 0.02 deg is roughly 2.2 km north-south in India. */
export const LOC_KEY_PRECISION = 0.02;

export interface Subscriber {
  chatId: string;
  firstName?: string;
  /** last shared location; absent until the user shares one */
  lat?: number;
  lng?: number;
  locKey?: string;
  active: boolean;
  /** true once Telegram says the user blocked the bot (403) */
  blocked: boolean;
  /** last tier we alerted this subscriber about, for de-duplication */
  lastAlertTier: string | null;
  createdAt: string;
  updatedAt: string;
}

const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({}),
  { marshallOptions: { removeUndefinedValues: true } }
);

export function subscribersTable(): string {
  const name = process.env.SUBSCRIBERS_TABLE;
  if (!name) throw new Error('missing environment variable SUBSCRIBERS_TABLE');
  return name;
}

/**
 * Snaps a coordinate pair onto the shared ~2 km grid, e.g. 28.6139,77.2090 ->
 * "28.62,77.20". Pure. Two points in the same cell return the same key, which
 * is what lets the fan-out fetch OpenAQ once per neighbourhood.
 */
export function locKeyFor(lat: number, lng: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`locKeyFor needs finite coordinates (got lat=${lat} lng=${lng})`);
  }
  const snap = (n: number): string => {
    const s = (Math.round(n / LOC_KEY_PRECISION) * LOC_KEY_PRECISION).toFixed(2);
    return s === '-0.00' ? '0.00' : s; // avoid a leading -0 that would split the same cell
  };
  return `${snap(lat)},${snap(lng)}`;
}

/** Pure grouping used by the scheduler fan-out. */
export function groupByLocKey(subscribers: Subscriber[]): Map<string, Subscriber[]> {
  const groups = new Map<string, Subscriber[]>();
  for (const sub of subscribers) {
    if (!sub.locKey) continue; // no location yet: nothing to monitor for them
    const list = groups.get(sub.locKey);
    if (list) list.push(sub);
    else groups.set(sub.locKey, [sub]);
  }
  return groups;
}

/**
 * Creates or updates the subscriber for this chat. Idempotent by construction:
 * the key is the chatId, so /start twice updates one row instead of adding a
 * second. `createdAt` is preserved with if_not_exists. Also re-activates a
 * subscriber who previously used /stop, and clears a stale `blocked` flag
 * (they cannot have reached us if they had really blocked us).
 */
export async function upsertCitizen(input: {
  chatId: string;
  firstName?: string;
  lat: number;
  lng: number;
}): Promise<void> {
  const now = new Date().toISOString();
  const values: Record<string, unknown> = {
    ':lat': input.lat,
    ':lng': input.lng,
    ':locKey': locKeyFor(input.lat, input.lng),
    ':now': now,
    ':true': true,
    ':false': false,
  };
  let expression =
    'SET lat = :lat, lng = :lng, locKey = :locKey, active = :true, blocked = :false, ' +
    'updatedAt = :now, createdAt = if_not_exists(createdAt, :now)';
  if (input.firstName) {
    expression += ', firstName = :firstName';
    values[':firstName'] = input.firstName;
  }

  await doc.send(
    new UpdateCommand({
      TableName: subscribersTable(),
      Key: { chatId: input.chatId },
      UpdateExpression: expression,
      ExpressionAttributeValues: values,
    })
  );
}

/** Reads one subscriber, or null when the chat has never used /start. */
export async function getSubscriber(chatId: string): Promise<Subscriber | null> {
  const res = await doc.send(new GetCommand({ TableName: subscribersTable(), Key: { chatId } }));
  return (res.Item as Subscriber) ?? null;
}

/**
 * Every subscriber we should monitor: active and not blocked. A Scan with a
 * filter is fine at this scale (a hackathon demo has tens of rows, on-demand
 * billing, no hot partition) and saves an index we do not need.
 */
export async function listActiveCitizens(): Promise<Subscriber[]> {
  const table = subscribersTable();
  const out: Subscriber[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: '#a = :true AND #b = :false',
        ExpressionAttributeNames: { '#a': 'active', '#b': 'blocked' },
        ExpressionAttributeValues: { ':true': true, ':false': false },
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      })
    );
    out.push(...((res.Items as Subscriber[]) ?? []));
    startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return out;
}

/** Remembers the last tier we alerted this chat about (de-duplication). */
export async function setLastAlertTier(chatId: string, tier: string | null): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: subscribersTable(),
      Key: { chatId },
      UpdateExpression: 'SET lastAlertTier = :tier, updatedAt = :now',
      ExpressionAttributeValues: { ':tier': tier, ':now': new Date().toISOString() },
    })
  );
}

/** /stop sets active = false; /start sets it back to true. */
export async function setActive(chatId: string, active: boolean): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: subscribersTable(),
      Key: { chatId },
      UpdateExpression: 'SET active = :active, updatedAt = :now',
      ExpressionAttributeValues: { ':active': active, ':now': new Date().toISOString() },
    })
  );
}

/** Telegram told us the user blocked the bot: stop trying to send. */
export async function markBlocked(chatId: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: subscribersTable(),
      Key: { chatId },
      UpdateExpression: 'SET blocked = :true, updatedAt = :now',
      ExpressionAttributeValues: { ':true': true, ':now': new Date().toISOString() },
    })
  );
}
