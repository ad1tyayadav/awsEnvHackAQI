// Tests for alert email formatting and SNS publish/subscribe (all mocked).
import { test, expect, beforeEach, vi } from 'vitest';

const publishMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-sns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sns')>();
  return {
    ...actual,
    SNSClient: vi.fn(() => ({ send: (cmd: { constructor: { name: string }; input: unknown }) => {
      if (cmd.constructor.name === 'PublishCommand') return publishMock(cmd.input);
      if (cmd.constructor.name === 'SubscribeCommand') return subscribeMock(cmd.input);
      return Promise.resolve({});
    } })),
  };
});

beforeEach(() => {
  publishMock.mockReset();
  subscribeMock.mockReset();
});

const { formatAlertEmail } = await import('../lib/alerts');

test('alert email subject and bilingual body format', () => {
  const { subject, body } = formatAlertEmail(
    'DL Public School',
    'RED',
    342,
    'All outdoor activity stopped.',
    'सभी बाहरी गतिविधियाँ बंद।'
  );
  expect(subject).toBe('Air alert: DL Public School is RED (AQI 342)');
  expect(body).toContain('All outdoor activity stopped.');
  expect(body).toContain('सभी बाहरी गतिविधियाँ बंद।');
  expect(body).toMatch(/guidance/); // disclaimer
  expect(body).toMatch(/local education authority/i);
});
