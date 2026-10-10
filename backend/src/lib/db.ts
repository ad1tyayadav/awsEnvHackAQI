// DynamoDB helpers (AWS SDK v3 DocumentClient). Table names come from Lambda
// environment variables - never hard-coded - so tests can point them anywhere.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

export interface School {
  schoolId: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  contactEmails?: string[];
  lastAlertTier?: string | null;
  createdAt?: string;
}

export interface Reading {
  schoolId: string;
  ts: string; // ISO UTC
  pm25: number;
  aqi?: number;
  category?: string;
  tier?: string;
  source: 'openaq' | 'simulated';
  stationName?: string;
  ttl?: number; // epoch seconds
}

export interface AlertRow {
  schoolId: string;
  ts: string;
  tier: string;
  aqi: number;
  subject: string;
  channel: 'email';
}

const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({}),
  { marshallOptions: { removeUndefinedValues: true } }
);

async function env(name: string): Promise<string> {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

export async function schoolsTable(): Promise<string> { return env('SCHOOLS_TABLE'); }
export async function readingsTable(): Promise<string> { return env('READINGS_TABLE'); }
export async function advisoryTable(): Promise<string> { return env('ADVISORY_TABLE'); }
export async function alertsTable(): Promise<string> { return env('ALERTS_TABLE'); }

export async function putSchool(school: School): Promise<void> {
  await doc.send(new PutCommand({ TableName: await schoolsTable(), Item: school }));
}

export async function getSchool(schoolId: string): Promise<School | null> {
  const res = await doc.send(new GetCommand({ TableName: await schoolsTable(), Key: { schoolId } }));
  return (res.Item as School) ?? null;
}

export async function getAllSchools(): Promise<School[]> {
  const res = await doc.send(new ScanCommand({ TableName: await schoolsTable() }));
  return (res.Items as School[]) ?? [];
}

export async function putReading(reading: Reading): Promise<void> {
  await doc.send(new PutCommand({ TableName: await readingsTable(), Item: reading }));
}

/** Last `hours` of readings for a school, newest first. */
export async function getRecentReadings(schoolId: string, hours = 24): Promise<Reading[]> {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const res = await doc.send(
    new QueryCommand({
      TableName: await readingsTable(),
      KeyConditionExpression: '#s = :id AND #t >= :since',
      ExpressionAttributeNames: { '#s': 'schoolId', '#t': 'ts' },
      ExpressionAttributeValues: { ':id': schoolId, ':since': since },
      ScanIndexForward: false, // SK `ts` desc => newest first
    })
  );
  return (res.Items as Reading[]) ?? [];
}

export async function putAlertRow(alert: AlertRow): Promise<void> {
  await doc.send(new PutCommand({ TableName: await alertsTable(), Item: alert }));
}

export async function getAdvisoryCached(key: string): Promise<string | null> {
  const res = await doc.send(new GetCommand({ TableName: await advisoryTable(), Key: { key } }));
  const item = res.Item as { text?: string } | undefined;
  return item?.text ?? null;
}

export async function putAdvisoryCached(key: string, text: string): Promise<void> {
  await doc.send(
    new PutCommand({
      TableName: await advisoryTable(),
      Item: { key, text, updatedAt: new Date().toISOString() },
    })
  );
}

/** Always called after an evaluation, alert or not (PRD dedupe rule, section 6). */
export async function updateSchoolLastAlertTier(schoolId: string, tier: string | null): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: await schoolsTable(),
      Key: { schoolId },
      UpdateExpression: 'SET lastAlertTier = :t',
      ExpressionAttributeValues: { ':t': tier },
    })
  );
}
