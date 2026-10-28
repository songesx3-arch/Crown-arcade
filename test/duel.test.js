'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-test-'));
process.env.CA_START_IN_MS = '50';
process.env.CA_MATCH_LIMIT_MS = '900';
process.env.CA_GRACE_MS = '350';
process.env.CA_ROOM_TTL_MS = '600';
process.env.CA_MAX_NEW_ACCOUNTS_PER_HOUR = '1000';
process.env.CA_MAX_CONN_PER_IP = '1000';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const server = require('../server');
const { connect, sleep } = require('../testutil/helpers');

let port;
before(async () => { port = await server.start(0); });
after(async () => { await server.stop(); });

async function player(name) {
  const c = await connect(port);
  const w = await c.hello(null, name);
  assert.equal(w.t, 'welcome');
  assert.ok(w.key, 'a new account gets a key');
  c.key = w.key; c.me = w.me;
  return c;
}
async function pair(game = 'stack', stake = 50) {
  const a = await player('Ann'), b = await player('Bob');
  a.send({ t: 'queue', game, stake });
  await a.next('queued');
  b.send({ t: 'queue', game, stake });
  const [ma, mb] = await Promise.all([a.next('match'), b.next('match')]);
  return { a, b, ma, mb };
}

test('new account, then the same key logs back in with the same progress', async () => {
  const a = await player('Zoe');
  assert.equal(a.me.coins, 500);
  assert.equal(a.me.name, 'Zoe');
  a.close();
  await sleep(50);
  const again = await connect(port);
  const w = await again.hello(a.key);
  assert.equal(w.t, 'welcome');
  assert.equal(w.me.name, 'Zoe');
  assert.equal(w.key, undefined, 'the key is only handed out once');
  const bad = await (await connect(port)).hello('x'.repeat(43));
  assert.equal(bad.code, 'unknown_key');
  const junk = await (await connect(port)).hello('short');
  assert.equal(junk.code, 'bad_key');
});

test('names are cleaned', async () => {
  const a = await player('<b>Hi</b> & "you"  ');
  a.send({ t: 'name', name: '  <script>alert(1)</script>Longname12345678  ' });
  const m = await a.next('me');
  assert.ok(!/[<>&"]/.test(m.me.name));
  assert.ok(m.me.name.length <= 14);
});

test('two players are matched, see the same board and each other live, and the winner is paid', async () => {
  const { a, b, ma, mb } = await pair('stack', 50);
  assert.equal(ma.mid, mb.mid);
  assert.equal(ma.seed, mb.seed, 'same seed for both');
  assert.equal(ma.opp.name, 'Bob');
  assert.equal(mb.opp.name, 'Ann');
  assert.equal(ma.me.coins, 450, 'stake is taken at the start');
  assert.equal(mb.me.coins, 450);
  await sleep(80);
  a.send({ t: 'progress', mid: ma.mid, score: 3 });
  const live = await b.next('opp');
  assert.equal(live.score, 3);
  a.send({ t: 'result', mid: ma.mid, score: 7 });
  const done = await b.next('opp_done');
  assert.equal(done.score, 7);
  assert.ok(done.deadlineIn > 0 && done.deadlineIn <= 350);
  b.send({ t: 'result', mid: mb.mid, score: 4 });
  const [ra, rb] = await Promise.all([a.next('result'), b.next('result')]);
  assert.equal(ra.outcome, 'win'); assert.equal(rb.outcome, 'loss');
  assert.equal(ra.net, 50); assert.equal(rb.net, -50);
  assert.equal(ra.me.coins, 550); assert.equal(rb.me.coins, 450);
  assert.equal(ra.crownDelta, 3); assert.equal(rb.crownDelta, 0, 'crowns cannot go below zero');
  assert.equal(ra.me.crowns, 3);
  assert.equal(ra.opp, 4); assert.equal(rb.opp, 7);
  assert.equal(ra.me.best.stack, 7);
  /* money is conserved: nothing created or destroyed */
  assert.equal(ra.me.coins + rb.me.coins, 1000);
});

test('equal scores are a draw and both get their stake back', async () => {
  const { a, b, ma, mb } = await pair('hop', 25);
  await sleep(80);
  a.send({ t: 'result', mid: ma.mid, score: 5 });
  b.send({ t: 'result', mid: mb.mid, score: 5 });
  const [ra, rb] = await Promise.all([a.next('result'), b.next('result')]);
  assert.equal(ra.outcome, 'draw'); assert.equal(rb.outcome, 'draw');
  assert.equal(ra.me.coins, 500); assert.equal(rb.me.coins, 500);
});

test('an impossible score is rejected and counts as a loss', async () => {
  const { a, b, ma, mb } = await pair('orbit', 25);
  await sleep(80);
  a.send({ t: 'result', mid: ma.mid, score: 999999 });
  const [ra, rb] = await Promise.all([a.next('result'), b.next('result')]);
  assert.equal(ra.outcome, 'loss'); assert.equal(ra.reason, 'invalid');
  assert.equal(rb.outcome, 'win'); assert.equal(rb.reason, 'opp_invalid');
  assert.equal(rb.me.coins, 525);
  /* and the score does not become a "best" */
  assert.equal(ra.me.best.orbit, undefined);
});

test('a score that is too high for the time played is rejected', async () => {
  const { a, b, ma } = await pair('lane', 25);
  a.send({ t: 'result', mid: ma.mid, score: 1900 }); /* 1900 m, instantly */
  const ra = await a.next('result');
  assert.equal(ra.reason, 'invalid');
  await b.next('result');
});

test('forfeiting hands the win to the other player at once', async () => {
  const { a, b, ma } = await pair('stack', 100);
  a.send({ t: 'forfeit', mid: ma.mid });
  const [ra, rb] = await Promise.all([a.next('result'), b.next('result')]);
  assert.equal(ra.outcome, 'loss'); assert.equal(rb.outcome, 'win'); assert.equal(rb.reason, 'opp_left');
  assert.equal(rb.me.coins, 600);
});

test('a player who never reports in loses when the clock runs out', async () => {
  const { a, b, ma } = await pair('stack', 25);
  await sleep(80);
  a.send({ t: 'result', mid: ma.mid, score: 2 });
  const [ra, rb] = await Promise.all([a.next('result', 2500), b.next('result', 2500)]);
  assert.equal(ra.outcome, 'win'); assert.equal(rb.outcome, 'loss'); assert.equal(rb.reason, 'you_timeout');
});

test('if nobody reports, it is a draw and stakes come back', async () => {
  const { a, b } = await pair('stack', 25);
  const [ra, rb] = await Promise.all([a.next('result', 2500), b.next('result', 2500)]);
  assert.equal(ra.outcome, 'draw'); assert.equal(rb.outcome, 'draw');
  assert.equal(ra.me.coins, 500); assert.equal(rb.me.coins, 500);
});

test('a dropped connection can come back and still finish the match', async () => {
  const { a, b, ma, mb } = await pair('stack', 50);
  await sleep(80);
  a.close();
  await sleep(60);
  const a2 = await connect(port);
  const w = await a2.hello(a.key);
  assert.equal(w.active.mid, ma.mid);
  assert.equal(w.active.finished, false);
  a2.send({ t: 'result', mid: ma.mid, score: 6 });
  b.send({ t: 'result', mid: mb.mid, score: 2 });
  const ra = await a2.next('result');
  assert.equal(ra.outcome, 'win');
});

test('a result that arrives while the player is offline is waiting for them on return', async () => {
  const { a, b, ma, mb } = await pair('stack', 50);
  await sleep(80);
  a.send({ t: 'result', mid: ma.mid, score: 6 });
  await b.next('opp_done');
  a.close();
  await sleep(60);
  b.send({ t: 'result', mid: mb.mid, score: 1 });
  await b.next('result');
  const a2 = await connect(port);
  const w = await a2.hello(a.key);
  assert.ok(w.pending, 'result delivered on reconnect');
  assert.equal(w.pending.outcome, 'win');
  assert.equal(w.me.coins, 550);
});

test('practice bot: the server decides the bot score and settles the stake', async () => {
  const a = await player('Solo');
  a.send({ t: 'bot', game: 'stack', stake: 25 });
  const m = await a.next('match');
  assert.equal(m.bot, true);
  assert.equal(m.me.coins, 475);
  await sleep(80);
  a.send({ t: 'result', mid: m.mid, score: 0 });
  const r = await a.next('result');
  assert.equal(r.bot, true);
  assert.ok(r.opp > 0);
  assert.equal(r.outcome, 'loss');
  assert.equal(r.me.coins, 475);
});

test('friend rooms: create a code, a friend joins with it', async () => {
  const a = await player('Host'), b = await player('Guest');
  a.send({ t: 'room_create', game: 'lane', stake: 25 });
  const room = await a.next('room');
  assert.match(room.code, /^[A-Z0-9]{4}$/);
  b.send({ t: 'room_join', code: room.code.toLowerCase() });
  const [ma, mb] = await Promise.all([a.next('match'), b.next('match')]);
  assert.equal(ma.mid, mb.mid);
  assert.equal(ma.game, 'lane');
  b.send({ t: 'forfeit', mid: mb.mid });
  await a.next('result');
  /* the code no longer works */
  const c = await player('Late');
  c.send({ t: 'room_join', code: room.code });
  assert.equal((await c.next('error')).code, 'no_room');
});

test('rooms expire and can be cancelled', async () => {
  const a = await player('Host2');
  a.send({ t: 'room_create', game: 'hop', stake: 25 });
  await a.next('room');
  const e = await a.next('error', 2000);
  assert.equal(e.code, 'room_expired');
  a.send({ t: 'room_create', game: 'hop', stake: 25 });
  const room = await a.next('room');
  a.send({ t: 'cancel' });
  await a.next('cancelled');
  const b = await player('G2');
  b.send({ t: 'room_join', code: room.code });
  assert.equal((await b.next('error')).code, 'no_room');
});

test('you cannot join your own room, use a bad code, or queue twice', async () => {
  const a = await player('Solo2');
  a.send({ t: 'room_create', game: 'hop', stake: 25 });
  const room = await a.next('room');
  a.send({ t: 'room_join', code: room.code });
  assert.equal((await a.next('error')).code, 'own_room');
  a.send({ t: 'room_join', code: '??' });
  assert.equal((await a.next('error')).code, 'bad_code');
  a.send({ t: 'queue', game: 'hop', stake: 25 });
  assert.equal((await a.next('error')).code, 'busy');
  a.send({ t: 'cancel' });
});

test('stakes: invalid values and not enough coins are refused', async () => {
  const a = await player('Broke');
  a.send({ t: 'queue', game: 'stack', stake: 7 });
  assert.equal((await a.next('error')).code, 'bad_request');
  a.send({ t: 'queue', game: 'nope', stake: 25 });
  assert.equal((await a.next('error')).code, 'bad_request');
  a.send({ t: 'queue', game: 'stack', stake: '25' });
  assert.equal((await a.next('error')).code, 'bad_request');
  /* lose everything to a bot, then try to play */
  for (let i = 0; i < 5; i++) {
    a.send({ t: 'bot', game: 'stack', stake: 100 });
    const m = await a.next('match');
    a.send({ t: 'forfeit', mid: m.mid });
    await a.next('result');
  }
  a.send({ t: 'queue', game: 'stack', stake: 25 });
  assert.equal((await a.next('error')).code, 'no_coins');
  a.send({ t: 'refill' });
  assert.equal((await a.next('me')).me.coins, 500);
  a.send({ t: 'refill' });
  assert.equal((await a.next('error')).code, 'no_need');
});

test('leaving the queue works and a queued player is not matched with themselves', async () => {
  const a = await player('Qa');
  a.send({ t: 'queue', game: 'orbit', stake: 25 });
  await a.next('queued');
  a.send({ t: 'cancel' });
  await a.next('cancelled');
  const b = await player('Qb');
  b.send({ t: 'queue', game: 'orbit', stake: 25 });
  await b.next('queued');
  await sleep(120);
  assert.equal(b.has('match'), false, 'nobody to play yet');
  b.send({ t: 'cancel' });
  await b.next('cancelled');
});

test('different games or stakes never pair', async () => {
  const a = await player('P1'), b = await player('P2');
  a.send({ t: 'queue', game: 'orbit', stake: 25 });
  b.send({ t: 'queue', game: 'orbit', stake: 50 });
  await a.next('queued'); await b.next('queued');
  await sleep(120);
  assert.equal(a.has('match') || b.has('match'), false);
  a.send({ t: 'cancel' }); b.send({ t: 'cancel' });
});

test('opening the account in a second tab replaces the first', async () => {
  const a = await player('Twin');
  const a2 = await connect(port);
  const w = await a2.hello(a.key);
  assert.equal(w.t, 'welcome');
  const e = await a.next('error');
  assert.equal(e.code, 'replaced');
});

test('daily bonus works once, reset keeps the daily timer', async () => {
  const a = await player('Daily');
  a.send({ t: 'claim' });
  assert.equal((await a.next('me')).me.coins, 600);
  a.send({ t: 'claim' });
  assert.equal((await a.next('error')).code, 'daily_wait');
  a.send({ t: 'reset' });
  const me = (await a.next('me')).me;
  assert.equal(me.coins, 500);
  a.send({ t: 'claim' });
  assert.equal((await a.next('error')).code, 'daily_wait');
});

test('ladder lists real players who have finished a match', async () => {
  const { a, b, ma, mb } = await pair('stack', 25);
  await sleep(80);
  a.send({ t: 'result', mid: ma.mid, score: 3 });
  b.send({ t: 'result', mid: mb.mid, score: 1 });
  await a.next('result'); await b.next('result');
  a.send({ t: 'ladder' });
  const l = await a.next('ladder');
  assert.ok(l.rows.length >= 1);
  assert.ok(l.rows.some((r) => r.me), 'you appear on the ladder');
  assert.ok(l.rank >= 1);
  assert.ok(l.online >= 2);
});

test('messages before hello, junk, and oversized messages are handled', async () => {
  const c = await connect(port);
  c.send({ t: 'queue', game: 'stack', stake: 25 });
  assert.equal((await c.next('error')).code, 'hello_first');
  c.sendRaw('not json at all');
  c.sendRaw(JSON.stringify([1, 2, 3]));
  c.sendRaw(JSON.stringify({ t: 5 }));
  await sleep(60);
  assert.equal(c.closeCode(), null, 'still connected after junk');
  c.sendRaw(JSON.stringify({ t: 'hello', pad: 'x'.repeat(10000) }));
  await sleep(150);
  assert.equal(c.closeCode(), 1009, 'closed for a message that is too large');
});

test('flooding the server gets the connection closed', async () => {
  const c = await connect(port);
  await c.hello(null, 'Flood');
  for (let i = 0; i < 300; i++) c.send({ t: 'ping' });
  await sleep(200);
  assert.equal(c.closeCode(), 1008);
});

test('a lone queued player is matched with a bot after the wait', async () => {
  process.env.CA_QUEUE_BOT_MIN_MS = '150';
  process.env.CA_QUEUE_BOT_MAX_MS = '250';
  try {
    const a = await player('Lonely');
    a.send({ t: 'queue', game: 'orbit', stake: 25 });
    await a.next('queued');
    const m = await a.next('match');
    assert.equal(m.bot, true);
  } finally {
    delete process.env.CA_QUEUE_BOT_MIN_MS;
    delete process.env.CA_QUEUE_BOT_MAX_MS;
  }
});

test('cancelling a queue stops the bot fallback', async () => {
  process.env.CA_QUEUE_BOT_MIN_MS = '150';
  process.env.CA_QUEUE_BOT_MAX_MS = '200';
  try {
    const a = await player('Canceller');
    a.send({ t: 'queue', game: 'orbit', stake: 25 });
    await a.next('queued');
    a.send({ t: 'cancel' });
    await a.next('cancelled');
    await sleep(400);
    a.send({ t: 'ladder' });
    const l = await a.next('ladder');
    assert.ok(l);
  } finally {
    delete process.env.CA_QUEUE_BOT_MIN_MS;
    delete process.env.CA_QUEUE_BOT_MAX_MS;
  }
});

const crypto = require('crypto');
function signToken(priv, kid, claims) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b({ alg: 'RS256', kid, typ: 'JWT' }) + '.' + b(claims);
  return data + '.' + crypto.sign('RSA-SHA256', Buffer.from(data), priv).toString('base64url');
}
test('google sign-in links, switches devices, and rejects bad tokens', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid: 'k1' });
  server._setJwksFetcher(async () => [jwk]);
  const good = (sub, extra) => signToken(privateKey, 'k1', Object.assign({ iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, sub, exp: Math.floor(Date.now() / 1000) + 600 }, extra));
  const a = await player('GoogleA');
  a.send({ t: 'google', credential: good('sub-1') });
  const linked = await a.next('linked');
  assert.equal(linked.me.google, true);
  /* a second device (new guest account) signs in with the same Google account and gets a key for the first account */
  const b = await player('GoogleB');
  b.send({ t: 'google', credential: good('sub-1') });
  const sw = await b.next('switch');
  assert.ok(sw.key && sw.key.length >= 40);
  const c = await connect(port);
  const w = await c.hello(sw.key);
  assert.equal(w.t, 'welcome');
  assert.equal(w.me.name, 'GoogleA');
  assert.equal(w.me.google, true);
  /* forged / wrong-audience / expired tokens are refused */
  const d = await player('GoogleD');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  for (const bad of [signToken(other, 'k1', { iss: 'https://accounts.google.com', aud: process.env.GOOGLE_CLIENT_ID, sub: 'x', exp: 9999999999 }),
    good('sub-2', { aud: 'someone-else' }), good('sub-3', { exp: 1000 }), 'garbage']) {
    d.send({ t: 'google', credential: bad });
    const e = await d.next('error');
    assert.equal(e.code, 'google_bad');
  }
  server._setJwksFetcher(null);
});
