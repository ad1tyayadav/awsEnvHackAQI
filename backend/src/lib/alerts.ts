// Alert email formatting and SNS publish/subscribe with per-school filter policy.
import { SNSClient, PublishCommand, SubscribeCommand, SetSubscriptionAttributesCommand } from '@aws-sdk/client-sns';
import { DISCLAIMER } from './advisory';
import type { Tier } from './tiers';

let snsClient: SNSClient | null = null;
function getSns(): SNSClient {
  if (!snsClient) snsClient = new SNSClient({});
  return snsClient;
}

/** Overridable in tests. */
export let snsApi: {
  publish: (topicArn: string, schoolId: string, subject: string, body: string) => Promise<void>;
  subscribe: (topicArn: string, email: string, schoolId: string) => Promise<string>;
} = {
  async publish(topicArn, schoolId, subject, body) {
    const res = await getSns().send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: body,
        Subject: subject,
        MessageAttributes: {
          schoolId: { DataType: 'String', StringValue: schoolId },
        },
      })
    );
    console.log(JSON.stringify({ msg: 'sns published', schoolId, messageId: res.MessageId }));
  },
  async subscribe(topicArn, email, schoolId) {
    const sub = await getSns().send(
      new SubscribeCommand({
        TopicArn: topicArn,
        Protocol: 'email',
        Endpoint: email,
        ReturnSubscriptionArn: true,
      })
    );
    const arn = sub.SubscriptionArn ?? '';
    if (arn && arn !== 'pending confirmation') {
      await getSns().send(
        new SetSubscriptionAttributesCommand({
          SubscriptionArn: arn,
          AttributeName: 'FilterPolicy',
          AttributeValue: JSON.stringify({ schoolId: [schoolId] }),
        })
      );
    }
    return arn;
  },
};

export function setSnsApiForTesting(api: Partial<typeof snsApi>): void {
  snsApi = { ...snsApi, ...api } as typeof snsApi;
}

export function formatAlertEmail(
  schoolName: string,
  tier: Tier,
  aqi: number,
  advisoryEn: string,
  advisoryHi: string
): { subject: string; body: string } {
  const subject = `Air alert: ${schoolName} is ${tier} (AQI ${aqi})`;
  const body = [
    `Air quality alert for ${schoolName}`,
    ``,
    `Current AQI: ${aqi} (${tier})`,
    ``,
    `--- Action plan (English) ---`,
    advisoryEn,
    ``,
    `--- कार्य योजना (हिंदी) ---`,
    advisoryHi,
    ``,
    `---`,
    DISCLAIMER,
    `Orders from your local education authority always take priority.`,
  ].join('\n');
  return { subject, body };
}
