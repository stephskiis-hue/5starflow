// TextNow Watch: parser, urgency, draft scoring and the channel rules. Pure functions only (no database).
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeMessage, harvest, e164, toIso, last10, maskPath, shapeOf, CHALLENGE_RE } = require('../lib/textnow');
const { urgentCheck, agreementScore } = require('../ai/textnow');
const { classifyConversation } = require('../ai/comms');

const ago = (min) => new Date(Date.now() - min * 60000);
const inMsg = (body, min) => ({ direction: 'in', body, at: ago(min), source: 'inbound', sentiment: null });
const outMsg = (body, min) => ({ direction: 'out', body, at: ago(min), source: 'owner', status: 'sent' });

test('e164 / last10: formats become one number, short codes are skipped', () => {
  assert.equal(e164('(204) 555-1234'), '+12045551234');
  assert.equal(e164('12045551234'), '+12045551234');
  assert.equal(e164('12345'), null);
  assert.equal(last10('+1 (204) 555-1234'), '2045551234');
});

test('normalizeMessage: accepts the TextNow field variants and rejects non-messages', () => {
  const a = normalizeMessage({ id: 7, contact_value: '+12045551234', message_direction: 1, message: 'hi', date: '2026-10-10T10:00:00Z' });
  assert.deepEqual([a.id, a.direction, a.body, a.media], ['7', 'in', 'hi', false]);
  const b = normalizeMessage({ messageId: 8, contactValue: '204-555-1234', direction: 'outgoing', text: 'yo', attachments: [{}] });
  assert.deepEqual([b.id, b.direction, b.media], ['8', 'out', true]);
  assert.equal(normalizeMessage({ id: 1 }), null);
  assert.equal(normalizeMessage(null), null);
});

test('harvest: finds messages anywhere in nested JSON', () => {
  const into = new Map();
  harvest({ result: { threads: [{ messages: [{ id: 1, contact_value: '+12045551234', direction: 'in', message: 'a' }] }] } }, into);
  assert.equal(into.size, 1);
});

test('toIso: ISO, epoch seconds and epoch milliseconds', () => {
  assert.equal(toIso('2026-10-10T10:00:00Z'), '2026-10-10T10:00:00.000Z');
  assert.equal(toIso(1760090400), toIso(1760090400000));
  assert.equal(toIso('garbage'), null);
  assert.equal(toIso(null), null);
});

test('urgentCheck: the few things worth an immediate text', () => {
  assert.match(urgentCheck('Can you cancel tomorrow please'), /cancel/);
  assert.match(urgentCheck('skip this Thursday'), /cancel/);
  assert.match(urgentCheck('tomorrow we need to skip'), /cancel/);
  assert.match(urgentCheck('you damaged my fence'), /complaint|damage/);
  assert.match(urgentCheck('I want a refund'), /complaint/);
  assert.match(urgentCheck('it is an emergency, tree down'), /urgent/);
});

test('urgentCheck: ordinary texts stay quiet for the summary', () => {
  assert.equal(urgentCheck('Thanks for today!'), null);
  assert.equal(urgentCheck('See you Friday'), null);
  assert.equal(urgentCheck('How much for a quote?'), null);
  assert.equal(urgentCheck(''), null);
});

test('agreementScore: same outcome matches, different day is downgraded, no draft is not scored', () => {
  assert.equal(agreementScore('Sounds good, we will skip Thursday and see you next week!', 'No problem, skipping Thursday. See you next week'), 'match');
  assert.equal(agreementScore('We can come Thursday at 9am', 'How about Friday morning?'), 'miss');
  assert.equal(agreementScore('Hi Mike, happy to quote. What is the address?', 'Hi Mike, happy to quote. What is the address?'), 'match');
  assert.equal(agreementScore('', 'ok'), null);
  assert.equal(agreementScore('We will be there Monday', ''), null);
});

test('classifyConversation: bare CANCEL is an opt-out on Twilio but a visit request on TextNow', () => {
  const sms = classifyConversation([inMsg('cancel', 30)]);
  assert.equal(sms.state, 'RESOLVED');
  assert.equal(sms.reason, 'opt-out');
  const tnc = classifyConversation([inMsg('cancel', 30)], Date.now(), { channel: 'textnow' });
  assert.notEqual(tnc.reason, 'opt-out');
  assert.notEqual(tnc.state, 'RESOLVED');
});

test('classifyConversation: STOP is an opt-out on both channels, and an owner reply answers a TextNow thread', () => {
  assert.equal(classifyConversation([inMsg('stop', 30)], Date.now(), { channel: 'textnow' }).reason, 'opt-out');
  const answered = classifyConversation([inMsg('Can you skip tomorrow?', 60), outMsg('Sure, skipping it', 30)], Date.now(), { channel: 'textnow' });
  assert.equal(answered.state, 'WAITING_ON_CUSTOMER');
});

test('maskPath: ids, numbers and the account name are masked; query values are dropped', () => {
  const a = maskPath('https://www.textnow.com/api/users/stephskiis/messages?page_size=100&start_message_id=998877&token=abc');
  assert.deepEqual(a, { host: 'www.textnow.com', path: '/api/users/:user/messages', query: ['page_size', 'start_message_id', 'token'] });
  assert.equal(maskPath('/messaging/+12045551234').path, '/messaging/:n');
  assert.equal(maskPath('/api/v3/conversations/3f2a9c1e-77aa-4b1c-9d00-aabbccddeeff/x').path, '/api/v3/conversations/:id/x');
  assert.equal(maskPath('/thread/dana@example.com').path, '/thread/:n');
  assert.ok(!JSON.stringify(a).includes('stephskiis') && !JSON.stringify(a).includes('998877'));
});

test('shapeOf: keeps key names and types, never a value', () => {
  const body = { messages: [{ id: 5, message: 'secret text', contact_value: '+12045551234', read: true, '+12045551234': { a: 1 } }], next: null };
  const shape = shapeOf(body);
  const out = JSON.stringify(shape);
  assert.deepEqual(shape.messages.item.message, 'string');
  assert.equal(shape.messages._array, 1);
  for (const leak of ['secret text', '2045551234']) assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.ok(out.includes(':key'));
});

test('CHALLENGE_RE: spots bot checks but not an ordinary inbox', () => {
  assert.ok(CHALLENGE_RE.test('Just a moment... checking your browser'));
  assert.ok(CHALLENGE_RE.test('Please verify you are human'));
  assert.ok(!CHALLENGE_RE.test('Messages Calls Voicemail New conversation'));
});
