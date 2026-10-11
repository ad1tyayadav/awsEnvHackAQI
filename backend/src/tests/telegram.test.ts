// Parser tests (task 9.3) using Update fixtures shaped like the Bot API's.
import { test, expect } from 'vitest';
import { parseUpdate, parseStartPayload, parseLangCallback, isLang, type TgUpdate } from '../lib/telegram';

const CHAT = { id: 123456789, type: 'private' };

const msg = (over: Partial<import('../lib/telegram').TgMessage>): TgUpdate => ({
  update_id: 1,
  message: { message_id: 10, chat: CHAT, from: { id: 123456789, first_name: 'Asha' }, ...over },
});

test('/start with no payload', () => {
  expect(parseUpdate(msg({ text: '/start' }))).toEqual({ kind: 'start', chatId: CHAT.id });
});

test('/start with school deep-link payload', () => {
  expect(parseUpdate(msg({ text: '/start school_sch_1728_ab12cd' }))).toEqual({
    kind: 'start',
    chatId: CHAT.id,
    schoolId: 'sch_1728_ab12cd',
    payload: 'school_sch_1728_ab12cd',
  });
});

test('/start drops a payload with bad chars or over 64 chars, but still starts', () => {
  // Telegram deep-link payloads are a single token: only the first word counts.
  expect(parseUpdate(msg({ text: '/start bad!chr' }))).toEqual({ kind: 'start', chatId: CHAT.id });
  const long = 'a'.repeat(65);
  expect(parseUpdate(msg({ text: `/start ${long}` }))).toEqual({ kind: 'start', chatId: CHAT.id });
  // Extra words after a valid payload are ignored, not treated as the payload.
  expect(parseStartPayload('ref extra')).toEqual({ payload: 'ref' });
});

test('/start school_ with empty id falls back to plain start', () => {
  expect(parseStartPayload('school_')).toEqual({ payload: 'school_' });
});

test('location message becomes a location intent', () => {
  expect(parseUpdate(msg({ location: { latitude: 28.6139, longitude: 77.209 } }))).toEqual({
    kind: 'location',
    chatId: CHAT.id,
    lat: 28.6139,
    lng: 77.209,
  });
});

test('commands parse, with and without @botname suffix', () => {
  expect(parseUpdate(msg({ text: '/status' }))).toEqual({ kind: 'command', chatId: CHAT.id, command: 'status', args: [] });
  expect(parseUpdate(msg({ text: '/status@CleanAirBot' }))).toEqual({ kind: 'command', chatId: CHAT.id, command: 'status', args: [] });
  expect(parseUpdate(msg({ text: '/explain RED' }))).toEqual({ kind: 'command', chatId: CHAT.id, command: 'explain', args: ['RED'] });
  expect(parseUpdate(msg({ text: '/language' }))).toEqual({ kind: 'command', chatId: CHAT.id, command: 'language', args: [] });
  expect(parseUpdate(msg({ text: '/stop' }))).toEqual({ kind: 'command', chatId: CHAT.id, command: 'stop', args: [] });
});

test('unknown command is reported as unknown, not as text', () => {
  expect(parseUpdate(msg({ text: '/frobnicate now' }))).toEqual({
    kind: 'command', chatId: CHAT.id, command: 'unknown', args: ['now'],
  });
});

test('language callback buttons (lang:en / lang:hi / bare)', () => {
  const cq = (data?: string): TgUpdate => ({
    update_id: 2,
    callback_query: { id: 'cb1', from: { id: CHAT.id }, message: { message_id: 5, chat: CHAT }, data },
  });
  expect(parseUpdate(cq('lang:en'))).toEqual({ kind: 'language', chatId: CHAT.id, lang: 'en' });
  expect(parseUpdate(cq('lang:hi'))).toEqual({ kind: 'language', chatId: CHAT.id, lang: 'hi' });
  expect(parseUpdate(cq('HI'))).toEqual({ kind: 'language', chatId: CHAT.id, lang: 'hi' });
  expect(parseUpdate(cq('other'))).toEqual({ kind: 'ignored', reason: 'unknown callback data' });
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
  expect(parseUpdate({ update_id: 4, callback_query: { id: 'x' } })).toEqual({ kind: 'ignored', reason: 'callback without chat' });
});

test('isLang and parseLangCallback helpers', () => {
  expect(isLang('en')).toBe(true);
  expect(isLang('hi')).toBe(true);
  expect(isLang('fr')).toBe(false);
  expect(parseLangCallback(undefined)).toBeNull();
  expect(parseLangCallback('lang:fr')).toBeNull();
});
