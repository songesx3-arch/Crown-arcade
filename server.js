'use strict';
/*
 * Crown Arcade server: serves the website and runs real-time 1v1 duels over WebSocket.
 *
 * How a duel works
 *   1. Both players join the same game + stake queue (or one makes a room code and the other types it).
 *   2. The server takes both stakes, picks the random seed and tells both browsers to start.
 *      Both play the exact same board at the same time and see each other's live score.
 *   3. Each browser reports its final score. The server checks it is possible for that much time,
 *      decides the winner, pays out and updates crowns. Coins and crowns only ever change here.
 *
 * Coins are virtual. There is no cash play.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const rules = require('./rules');
const { Store } = require('./store');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const START_IN_MS = Number(process.env.CA_START_IN_MS || 3200); /* countdown shown before play */
const LIMIT_MS = Number(process.env.CA_MATCH_LIMIT_MS || 190000); /* hard cap on a match */
const GRACE_MS = Number(process.env.CA_GRACE_MS || 60000); /* time left for the second player once the first is done */
const ROOM_TTL_MS = Number(process.env.CA_ROOM_TTL_MS || 10 * 60 * 1000);
const MAX_CONN_PER_IP = Number(process.env.CA_MAX_CONN_PER_IP || 30);
const MAX_NEW_ACCOUNTS_PER_HOUR = Number(process.env.CA_MAX_NEW_ACCOUNTS_PER_HOUR || 12); /* per network address */
const DAY = 86400000;
const KEY_RE = /^[A-Za-z0-9_-]{40,64}$/;
const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PUBLIC_DIR = path.join(__dirname, 'public');

const store = new Store(DATA_DIR);
const sessions = new Map(); /* account id -> connected session (one tab per account) */
const queues = new Map(); /* "game:stake" -> waiting entries */
const queued = new Map(); /* account id -> entry */
const rooms = new Map(); /* code -> room */
const roomByHost = new Map(); /* account id -> room */
const matches = new Map(); /* match id -> match */
const playerMatch = new Map(); /* account id -> match */
const ipConns = new Map();
const ipNewAccounts = new Map();

/* ------------------------------------------------------------------ helpers */
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');
const now = () => Date.now();

function cleanName(raw) {
  let n = typeof raw === 'string' ? raw : '';
  n = n.replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14).trim();
  return n || 'Player' + crypto.randomInt(100, 1000);
}

function view(p) {
  return {
    name: p.name, coins: p.coins, crowns: p.crowns, wins: p.wins, losses: p.losses,
    best: p.best, dailyLeft: Math.max(0, p.daily + DAY - now()), league: rules.LEAGUES[rules.leagueIdx(p.crowns)][0],
  };
}

function sendWs(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendTo(id, obj) {
  const s = sessions.get(id);
  if (s) sendWs(s.ws, obj);
  return !!s;
}
function fail(s, code, msg, extra) {
  sendWs(s.ws, Object.assign({ t: 'error', code, msg }, extra || {}));
}
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function busy(id) {
  return playerMatch.has(id) || queued.has(id) || roomByHost.has(id);
}
function pruneHits(list, windowMs) {
  const cut = now() - windowMs;
  while (list.length && list[0] < cut) list.shift();
  return list;
}

/* ------------------------------------------------------------------ online count */
let lastOnline = -1;
function onlineCount() { return sessions.size; }
function broadcastOnline(force) {
  const n = onlineCount();
  if (!force && n === lastOnline) return;
  lastOnline = n;
  for (const s of sessions.values()) sendWs(s.ws, { t: 'online', n });
}
setInterval(() => broadcastOnline(false), 3000).unref();

/* ------------------------------------------------------------------ matchmaking */
function leaveQueues(id) {
  const e = queued.get(id);
  if (e) {
    const list = queues.get(e.key);
    if (list) { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1); }
    clearTimeout(e.timer);
    queued.delete(id);
  }
  const room = roomByHost.get(id);
  if (room) { rooms.delete(room.code); roomByHost.delete(id); clearTimeout(room.timer); }
}

function enqueue(s, game, stake) {
  const key = game + ':' + stake;
  const entry = { id: s.id, key, game, stake, since: now() };
  const list = queues.get(key) || [];
  queues.set(key, list);
  /* pair with the waiting player closest in crowns */
  let best = null, bestGap = Infinity;
  for (const other of list) {
    if (other.id === s.id || !sessions.has(other.id)) continue;
    const gap = Math.abs(store.get(other.id).crowns - store.get(s.id).crowns);
    if (gap < bestGap) { best = other; bestGap = gap; }
  }
  if (best) {
    list.splice(list.indexOf(best), 1);
    clearTimeout(best.timer);
    queued.delete(best.id);
    createMatch(best.id, s.id, game, stake);
    return;
  }
  list.push(entry);
  queued.set(s.id, entry);
  /* nobody to play? after 15-25 seconds a bot steps in (tunable for tests) */
  const lo = Number(process.env.CA_QUEUE_BOT_MIN_MS || 15000), hi = Number(process.env.CA_QUEUE_BOT_MAX_MS || 25000);
  entry.timer = setTimeout(() => {
    if (queued.get(s.id) !== entry) return;
    const sess = sessions.get(s.id);
    leaveQueues(s.id);
    if (sess && canPlay(s.id, stake)) createBotMatch(sess, game, stake);
    else if (sess) sendWs(sess.ws, { t: 'cancelled' });
  }, lo + Math.random() * Math.max(0, hi - lo));
  if (entry.timer.unref) entry.timer.unref();
  sendWs(s.ws, { t: 'queued', game, stake });
}

function canPlay(id, stake) {
  const p = store.get(id);
  return p && sessions.has(id) && p.coins >= stake && !playerMatch.has(id);
}

function createMatch(idA, idB, game, stake) {
  /* the other side may have gone away or spent coins while waiting */
  const okA = canPlay(idA, stake), okB = canPlay(idB, stake);
  if (!okA || !okB) {
    for (const [id, ok] of [[idA, okA], [idB, okB]]) {
      if (!ok) { sendTo(id, { t: 'error', code: 'match_failed', msg: 'The match could not start.' }); }
      else { const s = sessions.get(id); if (s) enqueue(s, game, stake); }
    }
    return;
  }
  const mid = crypto.randomBytes(6).toString('hex');
  const seed = crypto.randomInt(100000, 1000000);
  const startAt = now() + START_IN_MS;
  const m = { id: mid, game, stake, seed, startAt, bot: false, hard: startAt + LIMIT_MS, deadline: startAt + LIMIT_MS, timer: null, done: false, firstDoneAt: 0, players: [] };
  for (const id of [idA, idB]) {
    const p = store.get(id);
    p.coins -= stake;
    p.escrow = { mid, stake };
    m.players.push({ id, res: null, forfeit: false, flagged: false, live: 0, lastProg: 0 });
    playerMatch.set(id, m);
  }
  matches.set(mid, m);
  store.touch();
  armDeadline(m);
  for (let i = 0; i < 2; i++) {
    const me = m.players[i], opp = m.players[1 - i];
    const op = store.get(opp.id);
    sendTo(me.id, {
      t: 'match', mid, game, stake, seed, startIn: START_IN_MS, limitMs: LIMIT_MS, bot: false,
      opp: { name: op.name, crowns: op.crowns }, me: view(store.get(me.id)),
    });
  }
}

function createBotMatch(s, game, stake) {
  const p = store.get(s.id);
  const mid = crypto.randomBytes(6).toString('hex');
  const seed = crypto.randomInt(100000, 1000000);
  const startAt = now() + START_IN_MS;
  const names = ['Skylark', 'RexTap', 'Mono', 'JuneBug', 'Orbit', 'Fennel', 'Quill', 'Marlo', 'TidalWave', 'Nimbus', 'Cobalt', 'Zed'];
  const r = rules.rng(seed ^ 0x5bd1e995);
  const bot = { name: names[Math.floor(r() * names.length)] + Math.floor(r() * 90 + 10), crowns: Math.max(0, p.crowns + Math.floor(r() * 13) - 6) };
  bot.score = rules.botScore(game, seed, p.best[game], p.crowns);
  p.coins -= stake;
  p.escrow = { mid, stake };
  const m = { id: mid, game, stake, seed, startAt, bot, hard: startAt + LIMIT_MS, deadline: startAt + LIMIT_MS, timer: null, done: false, firstDoneAt: 0, players: [{ id: s.id, res: null, forfeit: false, flagged: false, live: 0, lastProg: 0 }] };
  playerMatch.set(s.id, m);
  matches.set(mid, m);
  store.touch();
  armDeadline(m);
  sendWs(s.ws, { t: 'match', mid, game, stake, seed, startIn: START_IN_MS, limitMs: LIMIT_MS, bot: true, opp: { name: bot.name, crowns: bot.crowns }, me: view(p) });
}

function armDeadline(m) {
  clearTimeout(m.timer);
  m.timer = setTimeout(() => resolve(m, 'timeout'), Math.max(0, m.deadline - now()));
}

/* ------------------------------------------------------------------ results */
function resolve(m, reason) {
  if (m.done) return;
  m.done = true;
  clearTimeout(m.timer);
  matches.delete(m.id);
  const [A, B] = m.players;
  const score = (x) => (x && x.res !== null && !x.forfeit && !x.flagged ? x.res : null);
  let sa = score(A), sb = B ? score(B) : m.bot.score;
  /* outcome from A's point of view: 1 win, 0 draw, -1 loss */
  let out;
  if (B) {
    const aOut = A.forfeit || A.flagged, bOut = B.forfeit || B.flagged;
    if (aOut && bOut) out = 0;
    else if (aOut) out = -1;
    else if (bOut) out = 1;
    else if (sa === null && sb === null) out = 0;
    else if (sa === null) out = -1;
    else if (sb === null) out = 1;
    else out = sa > sb ? 1 : sa < sb ? -1 : 0;
  } else {
    if (A.forfeit || A.flagged || sa === null) out = -1;
    else out = sa > sb ? 1 : sa < sb ? -1 : 0;
  }
  const finalize = (me, o, oppScore, oppName, bot, why) => {
    const p = store.get(me.id);
    const before = p.crowns;
    const payout = o === 1 ? m.stake * 2 : o === 0 ? m.stake : 0;
    p.coins += payout;
    p.escrow = null;
    if (o === 1) { p.wins++; p.crowns += 3; } else if (o === -1) { p.losses++; p.crowns = Math.max(0, p.crowns - 1); }
    const mine = score(me);
    if (mine !== null && (p.best[m.game] === undefined || mine > p.best[m.game])) p.best[m.game] = mine;
    playerMatch.delete(me.id);
    const msg = {
      t: 'result', mid: m.id, game: m.game, stake: m.stake, you: mine, opp: oppScore, oppName, bot,
      outcome: o === 1 ? 'win' : o === -1 ? 'loss' : 'draw', reason: why, payout, net: payout - m.stake,
      crownsBefore: before, crownsAfter: p.crowns, crownDelta: p.crowns - before, best: p.best[m.game], me: view(p),
    };
    if (!sendTo(me.id, msg)) p.pending = msg; /* shown next time they connect */
  };
  const nameOf = (x) => (x ? store.get(x.id).name : m.bot.name);
  if (B) {
    const whyFor = (self, other) => (self.flagged ? 'invalid' : self.forfeit ? 'you_left' : other.flagged ? 'opp_invalid' : other.forfeit ? 'opp_left' : (score(self) === null ? 'you_timeout' : score(other) === null ? 'opp_timeout' : 'normal'));
    finalize(A, out, sb, nameOf(B), false, whyFor(A, B));
    finalize(B, -out, sa, nameOf(A), false, whyFor(B, A));
  } else {
    finalize(A, out, m.bot.score, m.bot.name, true, A.flagged ? 'invalid' : A.forfeit ? 'you_left' : sa === null ? 'you_timeout' : 'normal');
  }
  store.touch();
  broadcastOnline(false);
}

function handleResult(s, msg) {
  const m = playerMatch.get(s.id);
  if (!m || m.id !== msg.mid || m.done) return fail(s, 'no_match', 'That match is over.');
  const me = m.players.find((x) => x.id === s.id);
  if (me.res !== null || me.forfeit || me.flagged) return;
  const score = msg.score;
  if (!rules.plausible(m.game, score, now() - m.startAt)) {
    me.flagged = true;
    console.warn('Rejected score', score, 'for', m.game, 'after', now() - m.startAt, 'ms');
    return resolve(m, 'invalid');
  }
  me.res = score;
  if (m.bot) return resolve(m, 'done');
  const other = m.players.find((x) => x.id !== s.id);
  if (other.res !== null || other.forfeit) return resolve(m, 'done');
  /* tell the other player the number to beat, and start their clock */
  m.firstDoneAt = now();
  m.deadline = Math.min(m.hard, now() + GRACE_MS);
  armDeadline(m);
  sendTo(other.id, { t: 'opp_done', mid: m.id, score, deadlineIn: m.deadline - now() });
}

function handleProgress(s, msg) {
  const m = playerMatch.get(s.id);
  if (!m || m.id !== msg.mid || m.bot || m.done) return;
  const me = m.players.find((x) => x.id === s.id);
  const t = now();
  if (me.res !== null || t - me.lastProg < 120) return;
  if (!rules.plausible(m.game, msg.score, t - m.startAt)) return;
  me.lastProg = t;
  me.live = msg.score;
  const other = m.players.find((x) => x.id !== s.id);
  sendTo(other.id, { t: 'opp', mid: m.id, score: msg.score });
}

function handleForfeit(s, msg) {
  const m = playerMatch.get(s.id);
  if (!m || m.id !== msg.mid || m.done) return;
  const me = m.players.find((x) => x.id === s.id);
  if (me.res !== null) { sendWs(s.ws, { t: 'waiting', mid: m.id }); return; } /* already finished: just waiting for the other side */
  me.forfeit = true;
  resolve(m, 'forfeit');
}

/* ------------------------------------------------------------------ rooms */
function newCode() {
  for (let tries = 0; tries < 50; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}

/* ------------------------------------------------------------------ message handling */
function validGame(g) { return typeof g === 'string' && rules.GAMES.includes(g); }
function validStake(x) { return Number.isInteger(x) && rules.STAKES.includes(x); }

function handle(s, msg) {
  if (msg.t === 'ping') return sendWs(s.ws, { t: 'pong' });
  if (msg.t === 'hello') return handleHello(s, msg);
  if (!s.id) return fail(s, 'hello_first', 'Say hello first.');
  const p = store.get(s.id);
  switch (msg.t) {
    case 'queue': {
      if (!validGame(msg.game) || !validStake(msg.stake)) return fail(s, 'bad_request', 'Pick a game and a stake.');
      if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
      if (p.coins < msg.stake) return fail(s, 'no_coins', 'Not enough coins for that stake.');
      return enqueue(s, msg.game, msg.stake);
    }
    case 'bot': {
      if (!validGame(msg.game) || !validStake(msg.stake)) return fail(s, 'bad_request', 'Pick a game and a stake.');
      if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
      if (p.coins < msg.stake) return fail(s, 'no_coins', 'Not enough coins for that stake.');
      return createBotMatch(s, msg.game, msg.stake);
    }
    case 'cancel': {
      leaveQueues(s.id);
      return sendWs(s.ws, { t: 'cancelled' });
    }
    case 'room_create': {
      if (!validGame(msg.game) || !validStake(msg.stake)) return fail(s, 'bad_request', 'Pick a game and a stake.');
      if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
      if (p.coins < msg.stake) return fail(s, 'no_coins', 'Not enough coins for that stake.');
      if (rooms.size >= 5000) return fail(s, 'busy', 'Too many open rooms right now.');
      const code = newCode();
      if (!code) return fail(s, 'busy', 'Try again in a moment.');
      const room = { code, hostId: s.id, game: msg.game, stake: msg.stake, timer: null };
      room.timer = setTimeout(() => {
        if (rooms.get(code) === room) { rooms.delete(code); roomByHost.delete(room.hostId); sendTo(room.hostId, { t: 'error', code: 'room_expired', msg: 'That room expired.' }); }
      }, ROOM_TTL_MS);
      if (room.timer.unref) room.timer.unref();
      rooms.set(code, room);
      roomByHost.set(s.id, room);
      return sendWs(s.ws, { t: 'room', code, game: room.game, stake: room.stake });
    }
    case 'room_join': {
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      if (!/^[A-Z0-9]{4}$/.test(code)) return fail(s, 'bad_code', 'Room codes are 4 letters or numbers.');
      const room = rooms.get(code);
      if (room && room.hostId === s.id) return fail(s, 'own_room', 'That is your own room. Share the code with a friend.');
      if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
      if (!room || !sessions.has(room.hostId)) return fail(s, 'no_room', 'No open room with that code.');
      if (p.coins < room.stake) return fail(s, 'no_coins', 'You need ' + room.stake + ' coins to join that room.');
      if (store.get(room.hostId).coins < room.stake) return fail(s, 'no_room', 'The host no longer has enough coins.');
      rooms.delete(code); roomByHost.delete(room.hostId); clearTimeout(room.timer);
      return createMatch(room.hostId, s.id, room.game, room.stake);
    }
    case 'progress': return handleProgress(s, msg);
    case 'result': return handleResult(s, msg);
    case 'forfeit': return handleForfeit(s, msg);
    case 'name': {
      p.name = cleanName(msg.name);
      store.touch();
      return sendWs(s.ws, { t: 'me', me: view(p) });
    }
    case 'claim': {
      const left = p.daily + DAY - now();
      if (left > 0) return fail(s, 'daily_wait', 'Your daily bonus is not ready yet.', { me: view(p) });
      p.coins += 100; p.daily = now();
      store.touch();
      return sendWs(s.ws, { t: 'me', me: view(p) });
    }
    case 'refill': {
      if (p.coins >= rules.STAKES[0]) return fail(s, 'no_need', 'You still have enough coins to play.');
      const wait = p.refillAt + 5 * 60000 - now();
      if (wait > 0) return fail(s, 'refill_wait', 'You can refill again in ' + Math.ceil(wait / 60000) + ' min.');
      p.coins += 500; p.refillAt = now();
      store.touch();
      return sendWs(s.ws, { t: 'me', me: view(p) });
    }
    case 'reset': {
      if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
      p.coins = 500; p.crowns = 0; p.wins = 0; p.losses = 0; p.best = {};
      store.touch();
      return sendWs(s.ws, { t: 'me', me: view(p) });
    }
    case 'ladder': return sendWs(s.ws, Object.assign({ t: 'ladder' }, ladder(s.id)));
    default: return fail(s, 'bad_request', 'Unknown message.');
  }
}

let ladderCache = { at: 0, rows: [] };
function ladder(myId) {
  if (now() - ladderCache.at > 5000) {
    const rows = [];
    for (const [id, p] of store.players) if (p.wins + p.losses > 0) rows.push({ id, name: p.name, crowns: p.crowns, wins: p.wins });
    rows.sort((a, b) => b.crowns - a.crowns || b.wins - a.wins || (a.name < b.name ? -1 : 1));
    ladderCache = { at: now(), rows };
  }
  const rows = ladderCache.rows;
  const top = rows.slice(0, 25).map((r, i) => ({ pos: i + 1, name: r.name, crowns: r.crowns, league: rules.LEAGUES[rules.leagueIdx(r.crowns)][0], me: r.id === myId }));
  const idx = rows.findIndex((r) => r.id === myId);
  return { rows: top, rank: idx >= 0 ? idx + 1 : null, total: rows.length, online: onlineCount() };
}

function handleHello(s, msg) {
  if (s.id) return;
  let key = msg.key, id, p, isNew = false;
  if (key !== undefined && key !== null) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return fail(s, 'bad_key', 'That account key is not valid.');
    id = hashKey(key);
    p = store.get(id);
    if (!p) return fail(s, 'unknown_key', 'This server does not know that account key.');
  } else {
    const hits = pruneHits(ipNewAccounts.get(s.ip) || [], 3600000);
    ipNewAccounts.set(s.ip, hits);
    if (hits.length >= MAX_NEW_ACCOUNTS_PER_HOUR) { fail(s, 'rate', 'Too many new accounts from your network. Try again later.'); return s.ws.close(1008, 'rate'); }
    hits.push(now());
    key = crypto.randomBytes(32).toString('base64url');
    id = hashKey(key);
    p = store.create(id, cleanName(msg.name));
    isNew = true;
  }
  /* one open tab per account: the newest takes over */
  const old = sessions.get(id);
  if (old && old.ws !== s.ws) {
    old.replaced = true;
    sendWs(old.ws, { t: 'error', code: 'replaced', msg: 'This account was opened in another tab.' });
    leaveQueues(id);
    sessions.delete(id);
    try { old.ws.close(4000, 'replaced'); } catch (e) { /* already closed */ }
  }
  s.id = id;
  sessions.set(id, s);
  p.seen = now();
  const m = playerMatch.get(id);
  const welcome = { t: 'welcome', v: 1, me: view(p), online: onlineCount(), stakes: rules.STAKES };
  if (isNew) welcome.key = key;
  if (m) {
    const mine = m.players.find((x) => x.id === id);
    const other = m.players.find((x) => x.id !== id);
    welcome.active = { mid: m.id, game: m.game, stake: m.stake, finished: mine.res !== null, bot: !!m.bot, oppName: other ? store.get(other.id).name : m.bot.name };
  }
  if (p.pending) { welcome.pending = p.pending; p.pending = null; store.touch(); }
  sendWs(s.ws, welcome);
  broadcastOnline(true);
}

function onClose(s) {
  const n = (ipConns.get(s.ip) || 1) - 1;
  if (n <= 0) ipConns.delete(s.ip); else ipConns.set(s.ip, n);
  if (s.id && sessions.get(s.id) === s) {
    sessions.delete(s.id);
    leaveQueues(s.id);
    broadcastOnline(false);
  }
}

/* ------------------------------------------------------------------ HTTP: the website */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const httpServer = http.createServer((req, res) => {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, Object.assign({ Allow: 'GET, HEAD' }, headers)); return res.end(); }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400, headers); return res.end('Bad request'); }
  if (pathname === '/healthz') { res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain' }, headers)); return res.end('ok'); }
  const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (pathname === '/robots.txt') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers));
    return res.end('User-agent: *\nAllow: /\n' + (base ? 'Sitemap: ' + base + '/sitemap.xml\n' : ''));
  }
  if (pathname === '/sitemap.xml' && base) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/xml; charset=utf-8' }, headers));
    return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' + base + '/</loc></url></urlset>\n');
  }
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404, headers); return res.end('Not found'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, headers)); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const h = Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' }, headers);
    res.writeHead(200, h);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

/* ------------------------------------------------------------------ WebSocket */
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const count = (ipConns.get(ip) || 0) + 1;
  ipConns.set(ip, count);
  const s = { ws, ip, id: null, tokens: 80, refillAt: now(), replaced: false };
  if (count > MAX_CONN_PER_IP) { ws.close(1013, 'busy'); onClose(s); return; }
  const helloTimer = setTimeout(() => { if (!s.id) ws.close(1008, 'hello timeout'); }, 10000);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const t = now();
    s.tokens = Math.min(80, s.tokens + ((t - s.refillAt) / 1000) * 40);
    s.refillAt = t;
    if (--s.tokens < 0) return ws.close(1008, 'slow down');
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    try { handle(s, msg); } catch (e) { console.error('Handler error:', e); }
  });
  ws.on('close', () => { clearTimeout(helloTimer); onClose(s); });
  ws.on('error', () => {});
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);
heartbeat.unref();
wss.on('connection', (ws) => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

/* ------------------------------------------------------------------ start and stop */
function start(port) {
  return new Promise((resolveStart) => {
    httpServer.listen(port === undefined ? PORT : port, HOST, () => resolveStart(httpServer.address().port));
  });
}

function stop() {
  return new Promise((resolveStop) => {
    clearInterval(heartbeat);
    store.flush();
    for (const ws of wss.clients) ws.terminate();
    for (const m of matches.values()) clearTimeout(m.timer);
    wss.close(() => httpServer.close(() => resolveStop()));
  });
}

if (require.main === module) {
  start().then((port) => console.log('Crown Arcade is running on http://localhost:' + port));
  const bye = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { start, stop, store };
