// Parser tests (task 9.3) using Update fixtures shaped like the Bot API's.
import { test, expect } from 'vitest';
import { parseUpdate, COMMANDS, type TgUpdate } from '../lib/telegram';

const CHAT = { id: 123456789, type: 'private' };

const msg = (over: Partial<import('../lib/telegram').TgMessage>): TgUpdate => ({
  update_id: 1,
  message: { message_id: 10, chat: CHAT, from: { id: 123456789, first_name: 'Asha' }, ...over },
});

test('/start signs a chat up, and any argument after it is ignored', () => {
  // There are no deep links any more: the bot only needs a shared location, so
  // extra words after /start are never interpreted as a payload.
  expect(parseUpdate(msg({ text: '/start' }))).toEqual({ kind: 'start', chatId: CHAT.id });
  expect(parseUpdate(msg({ text: '/start morning_run' }))).toEqual({ kind: 'start', chatId: CHAT.id });
  expect(parseUpdate(msg({ text: '/start@CleanAirBot' }))).toEqual({ kind: 'start', chatId: CHAT.id });
});

test('location message becomes a location intent and carries the first name', () => {
  expect(parseUpdate(msg({ location: { latitude: 28.6139, longitude: 77.209 } }))).toEqual({
    kind: 'location',
    chatId: CHAT.id,
    lat: 28.6139,
    lng: 77.209,
    firstName: 'Asha',
  });
});

test('a location with no sender name still parses (firstName is optional)', () => {
  const update = msg({ location: { latitude: 1, longitude: 2 } });
  delete update.message!.from;

  expect(parseUpdate(update)).toEqual({ kind: 'location', chatId: CHAT.id, lat: 1, lng: 2 });
});

test('every advertised command parses, with and without the @botname suffix', () => {
  // `/start` is not in this list on purpose: it has its own intent (it must be
  // answerable on a chat that has never signed up), so it is covered above.
  for (const command of COMMANDS.filter((c) => c !== 'start')) {
    expect(parseUpdate(msg({ text: `/${command}` }))).toEqual({ kind: 'command', chatId: CHAT.id, command, args: [] });
    expect(parseUpdate(msg({ text: `/${command}@CleanAirBot` }))).toEqual({ kind: 'command', chatId: CHAT.id, command, args: [] });
  }
  expect(parseUpdate(msg({ text: '/status now' }))).toEqual({ kind: 'command', chatId: CHAT.id, command: 'status', args: ['now'] });
});

test('the advertised command list is exactly what the bot answers', () => {
  // Guards against advertising a command the bot ignores (the BotFather menu is
  // built from this list). English-only decision: no /language.
  expect([...COMMANDS]).toEqual(['start', 'status', 'stop', 'help']);
});

test('unknown command is reported as unknown, not as text', () => {
  expect(parseUpdate(msg({ text: '/frobnicate now' }))).toEqual({
    kind: 'command', chatId: CHAT.id, command: 'unknown', args: ['now'],
  });
});

test('a button tap from an older bot version is ignored, not answered', () => {
  const cq = (data?: string): TgUpdate => ({
    update_id: 2,
    callback_query: { id: 'cb1', from: { id: CHAT.id }, message: { message_id: 5, chat: CHAT }, data },
  });
  const ignored = { kind: 'ignored', reason: 'callback query (this bot has no inline buttons)' };
  expect(parseUpdate(cq('lang:en'))).toEqual(ignored);
  expect(parseUpdate(cq('other'))).toEqual(ignored);
  expect(parseUpdate(cq(undefined))).toEqual(ignored);
});

test('plain text becomes a text intent (the Q&A path)', () => {
  expect(parseUpdate(msg({ text: '  Is it safe to play outside?  ' }))).toEqual({
    kind: 'text', chatId: CHAT.id, text: 'Is it safe to play outside?',
  });
});

test('malformed / non-actionable updates are ignored, never thrown', () => {
  expect(parseUpdate(null)).toEqual({ kind: 'ignored', reason: 'no update' });
  expect(parseUpdate(undefined)).toEqual({ kind: 'ignored', reason: 'no update' });
  expect(parseUpdate({ update_id: 3 })).toEqual({ kind: 'ignored', reason: 'no message' });
  expect(parseUpdate(msg({}))).toEqual({ kind: 'ignored', reason: 'non-text, non-location message' });
  expect(parseUpdate({ update_id: 4, callback_query: { id: 'x' } })).toEqual({
    kind: 'ignored', reason: 'callback query (this bot has no inline buttons)',
  });
});
