'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-test-'));
Object.assign(process.env, {
  DATA_DIR: DATA, CA_START_IN_MS: '0', CA_QUEUE_BOT_MIN_MS: '150', CA_QUEUE_BOT_MAX_MS: '200',
  CA_GRACE_MS: '400', CA_REMATCH_MS: '1500', CA_MAX_NEW_ACCOUNTS_PER_HOUR: '100',
});

const WebSocket = require('ws');
const server = require('../server');
const rules = require('../rules');
let port;

/* A tiny client that queues incoming messages and lets a test wait for a type. */
function client() {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  const inbox = [], waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].ok(m); else inbox.push(m);
  });
  const c = {
    ws,
    send: (o) => ws.send(JSON.stringify(o)),
    next: (t, ms = 2000) => new Promise((ok, no) => {
      const i = inbox.findIndex((m) => m.t === t);
      if (i >= 0) return ok(inbox.splice(i, 1)[0]);
      const timer = setTimeout(() => no(new Error('timeout waiting for ' + t)), ms);
      waiters.push({ t, ok: (m) => { clearTimeout(timer); ok(m); } });
    }),
    close: () => ws.close(),
  };
  c.open = new Promise((ok) => ws.on('open', ok));
  return c;
}

async function guest(name) {
  const c = client();
  await c.open;
  c.send({ t: 'hello', name });
  c.welcome = await c.next('welcome');
  return c;
}

test.before(async () => { port = await server.start(0); });
test.after(async () => { await server.stop(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('new guests get a key and 500 coins', async () => {
  const a = await guest('Ann');
  assert.match(a.welcome.key, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(a.welcome.me.coins, 500);
  assert.strictEqual(a.welcome.me.name, 'Ann');
  a.close();
});

test('two players in the same queue duel; winner takes the pot and crowns', async () => {
  const a = await guest('Ann'), b = await guest('Ben');
  a.send({ t: 'queue', game: 'stack', stake: 50 });
  await a.next('queued');
  b.send({ t: 'queue', game: 'stack', stake: 50 });
  const ma = await a.next('match'), mb = await b.next('match');
  assert.strictEqual(ma.seed, mb.seed);
  assert.strictEqual(ma.me.coins, 450);

  a.send({ t: 'progress', mid: ma.mid, score: 1 });
  assert.strictEqual((await b.next('opp')).score, 1);

  await new Promise((r) => setTimeout(r, 300));
  a.send({ t: 'result', mid: ma.mid, score: 2 });
  const od = await b.next('opp_done');
  assert.strictEqual(od.score, 2);
  b.send({ t: 'result', mid: mb.mid, score: 1 });
  const ra = await a.next('result'), rb = await b.next('result');
  assert.strictEqual(ra.outcome, 'win');
  assert.strictEqual(ra.payout, 100);
  assert.strictEqual(ra.me.coins, 550);
  assert.strictEqual(ra.crownDelta, 3);
  assert.strictEqual(rb.outcome, 'loss');
  assert.strictEqual(rb.me.coins, 450);
  assert.strictEqual(rb.crownDelta, 0); /* never below 0 */
  assert.strictEqual(ra.me.history[0].oppName, 'Ben');
  assert.ok(ra.rematch > 0);
  a.close(); b.close();
});

test('rematch starts a new duel when both accept', async () => {
  const a = await guest('Cat'), b = await guest('Dan');
  a.send({ t: 'room_create', game: 'orbit', stake: 25 });
  const room = await a.next('room');
  b.send({ t: 'room_join', code: room.code });
  const ma = await a.next('match'); await b.next('match');
  a.send({ t: 'forfeit', mid: ma.mid });
  const ra = await a.next('result'); await b.next('result');
  assert.strictEqual(ra.reason, 'you_left');

  a.send({ t: 'rematch', mid: ma.mid });
  await a.next('rematch_wait');
  const offer = await b.next('rematch_offer');
  assert.strictEqual(offer.name, 'Cat');
  b.send({ t: 'rematch', mid: ma.mid });
  const m2 = await a.next('match');
  assert.notStrictEqual(m2.mid, ma.mid);
  assert.strictEqual(m2.game, 'orbit');
  await b.next('match');
  a.close(); b.close();
});

test('a lonely queue gets a computer opponent', async () => {
  const a = await guest('Eve');
  a.send({ t: 'queue', game: 'hop', stake: 25 });
  await a.next('queued');
  const m = await a.next('match', 3000);
  assert.strictEqual(m.bot, true);
  a.send({ t: 'result', mid: m.mid, score: 0 });
  const r = await a.next('result');
  assert.strictEqual(r.outcome, 'loss');
  assert.strictEqual(r.me.coins, 475);
  a.close();
});

test('impossible scores are rejected and lose', async () => {
  const a = await guest('Fay');
  a.send({ t: 'bot', game: 'lane', stake: 25 });
  const m = await a.next('match');
  a.send({ t: 'result', mid: m.mid, score: 1999 });
  const r = await a.next('result');
  assert.strictEqual(r.reason, 'invalid');
  assert.strictEqual(r.outcome, 'loss');
  a.close();
});

test('win streak earns a bonus crown from the third win', () => {
  assert.strictEqual(rules.winCrowns(1), 3);
  assert.strictEqual(rules.winCrowns(2), 3);
  assert.strictEqual(rules.winCrowns(3), 4);
});

test('reconnecting with the key restores the account and the live match', async () => {
  const a = await guest('Gus');
  const key = a.welcome.key;
  a.send({ t: 'bot', game: 'orbit', stake: 50 });
  const m = await a.next('match');
  a.close();
  await new Promise((r) => setTimeout(r, 100));
  const a2 = client();
  await a2.open;
  a2.send({ t: 'hello', key });
  const w = await a2.next('welcome');
  assert.strictEqual(w.me.name, 'Gus');
  assert.strictEqual(w.active.mid, m.mid);
  a2.send({ t: 'forfeit', mid: m.mid });
  const r = await a2.next('result');
  assert.strictEqual(r.outcome, 'loss');
  a2.close();
});

test('stakes held in escrow are refunded after a crash', () => {
  const { Store } = require('../store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-crash-'));
  fs.writeFileSync(path.join(dir, 'players.json'), JSON.stringify({
    v: 1, players: { x: { name: 'Hal', coins: 400, escrow: { mid: 'm', stake: 100 } } }, aliases: {},
  }));
  const st = new Store(dir);
  assert.strictEqual(st.get('x').coins, 500);
  assert.strictEqual(st.get('x').escrow, null);
  assert.deepStrictEqual(st.get('x').history, []);
  st.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('plausibility rules', () => {
  assert.strictEqual(rules.plausible('orbit', 10, 1000), true);
  assert.strictEqual(rules.plausible('orbit', 301, 999999), false);
  assert.strictEqual(rules.plausible('stack', 1.5, 9999), false);
  assert.strictEqual(rules.plausible('nope', 1, 9999), false);
  const s = rules.botScore('stack', 123456, 40, 50);
  assert.ok(s >= 32 && s <= 44);
});

test('static files are served with security headers and no traversal', async () => {
  const res = await fetch('http://127.0.0.1:' + port + '/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  const bad = await fetch('http://127.0.0.1:' + port + '/..%2fserver.js');
  assert.strictEqual(bad.status, 404);
});
