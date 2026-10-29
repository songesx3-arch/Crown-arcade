'use strict';
/*
 * Crown Arcade server: serves the website and runs real-time 1v1 duels over WebSocket.
 *
 * How a duel works
 *   1. Both players join the same game + stake queue (or one makes a room code and the other types it).
 *   2. The server takes both stakes (escrow), picks the random seed and tells both browsers to start.
 *      Both play the exact same board at the same time and see each other's live score.
 *   3. Each browser reports its final score. The server checks it is possible for that much time,
 *      decides the winner, pays out and updates crowns. Coins and crowns only ever change here.
 *   4. For 30 seconds after a duel between two people, either can offer a rematch.
 *
 * Coins are virtual. There is no cash play.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const rules = require('./rules');
const auth = require('./auth');
const { Store } = require('./store');

/* ------------------------------------------------------------------ config */
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const PORT = Number(env('PORT', 3000));
const HOST = env('HOST', '0.0.0.0');
const DATA_DIR = env('DATA_DIR', path.join(__dirname, 'data'));
const TRUST_PROXY = env('TRUST_PROXY', '') === '1';
const GOOGLE_CLIENT_ID = env('GOOGLE_CLIENT_ID', '');
const START_IN_MS = Number(env('CA_START_IN_MS', 3200));         /* countdown before play */
const LIMIT_MS = Number(env('CA_MATCH_LIMIT_MS', 190000));        /* hard cap on a match */
const GRACE_MS = Number(env('CA_GRACE_MS', 60000));               /* time left for the 2nd player once the 1st is done */
const ROOM_TTL_MS = Number(env('CA_ROOM_TTL_MS', 10 * 60 * 1000));
const REMATCH_MS = Number(env('CA_REMATCH_MS', 30000));
const MAX_CONN_PER_IP = Number(env('CA_MAX_CONN_PER_IP', 30));
const MAX_NEW_ACCOUNTS_PER_HOUR = Number(env('CA_MAX_NEW_ACCOUNTS_PER_HOUR', 12));
const BOT_MIN_MS = () => Number(env('CA_QUEUE_BOT_MIN_MS', 15000));
const BOT_MAX_MS = () => Number(env('CA_QUEUE_BOT_MAX_MS', 25000));

const DAY = 86400000;
const KEY_RE = /^[A-Za-z0-9_-]{40,64}$/;
const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOT_NAMES = ['Skylark', 'RexTap', 'Mono', 'JuneBug', 'Orbiter', 'Fennel', 'Quill', 'Marlo', 'TidalWave',
  'Nimbus', 'Pixel', 'Juno', 'Comet', 'Bramble', 'Kestrel', 'Nova', 'Sprocket', 'Velvet'];

/* ------------------------------------------------------------------ state */
const store = new Store(DATA_DIR);
const sessions = new Map();   /* account id -> connected session (one tab per account) */
const queues = new Map();     /* "game:stake" -> waiting entries */
const queued = new Map();     /* account id -> queue entry */
const rooms = new Map();      /* code -> room */
const roomByHost = new Map(); /* account id -> room */
const matches = new Map();    /* match id -> match */
const playerMatch = new Map();/* account id -> match */
const offers = new Map();     /* finished match id -> rematch offer */
const offerOf = new Map();    /* account id -> rematch offer */
const ipConns = new Map();
const ipNewAccounts = new Map();
let jwksFetcher = null;       /* tests only */

/* ------------------------------------------------------------------ helpers */
const now = () => Date.now();
const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');
const leagueName = (crowns) => rules.LEAGUES[rules.leagueIdx(crowns)][0];

function cleanName(raw) {
  let n = typeof raw === 'string' ? raw : '';
  n = n.replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14).trim();
  return n || 'Player' + crypto.randomInt(100, 1000);
}

/* What a player is allowed to see about their own account. */
function view(p) {
  return {
    name: p.name, coins: p.coins, crowns: p.crowns,
    wins: p.wins, losses: p.losses, draws: p.draws,
    streak: p.streak, bestStreak: p.bestStreak,
    best: p.best, history: p.history, google: !!p.google,
    dailyLeft: Math.max(0, p.daily + DAY - now()),
    refillLeft: Math.max(0, p.refillAt + rules.REFILL_EVERY_MS - now()),
    league: leagueName(p.crowns),
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

const validGame = (g) => typeof g === 'string' && rules.GAMES.includes(g);
const validStake = (x) => Number.isInteger(x) && rules.STAKES.includes(x);

/* ------------------------------------------------------------------ online count */
let lastOnline = -1;
const onlineCount = () => sessions.size;

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

function canPlay(id, stake) {
  const p = store.get(id);
  return !!p && sessions.has(id) && p.coins >= stake && !playerMatch.has(id);
}

function enqueue(s, game, stake) {
  const key = game + ':' + stake;
  const list = queues.get(key) || [];
  queues.set(key, list);

  /* pair with the waiting player closest in crowns */
  const myCrowns = store.get(s.id).crowns;
  let best = null, bestGap = Infinity;
  for (const other of list) {
    if (other.id === s.id || !sessions.has(other.id)) continue;
    const gap = Math.abs(store.get(other.id).crowns - myCrowns);
    if (gap < bestGap) { best = other; bestGap = gap; }
  }
  if (best) {
    list.splice(list.indexOf(best), 1);
    clearTimeout(best.timer);
    queued.delete(best.id);
    createMatch(best.id, s.id, game, stake);
    return;
  }

  const entry = { id: s.id, key, game, stake, since: now(), timer: null };
  list.push(entry);
  queued.set(s.id, entry);

  /* nobody to play? after 15-25 seconds a computer opponent steps in */
  const lo = BOT_MIN_MS(), hi = BOT_MAX_MS();
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

function newMatch(game, stake, bot) {
  const startAt = now() + START_IN_MS;
  return {
    id: crypto.randomBytes(6).toString('hex'),
    game, stake, bot,
    seed: crypto.randomInt(100000, 1000000),
    startAt, hard: startAt + LIMIT_MS, deadline: startAt + LIMIT_MS,
    players: [], timer: null, done: false,
  };
}

function takeStake(m, id) {
  const p = store.get(id);
  p.coins -= m.stake;
  p.escrow = { mid: m.id, stake: m.stake };
  m.players.push({ id, res: null, forfeit: false, flagged: false, live: 0, lastProg: 0 });
  playerMatch.set(id, m);
}

function createMatch(idA, idB, game, stake) {
  /* either side may have gone away or spent coins while waiting */
  const okA = canPlay(idA, stake), okB = canPlay(idB, stake);
  if (!okA || !okB) {
    for (const [id, ok] of [[idA, okA], [idB, okB]]) {
      if (!ok) sendTo(id, { t: 'error', code: 'match_failed', msg: 'The match could not start.' });
      else { const s = sessions.get(id); if (s) enqueue(s, game, stake); }
    }
    return;
  }
  const m = newMatch(game, stake, false);
  takeStake(m, idA);
  takeStake(m, idB);
  matches.set(m.id, m);
  store.touch();
  armDeadline(m);
  for (let i = 0; i < 2; i++) {
    const me = store.get(m.players[i].id), op = store.get(m.players[1 - i].id);
    sendTo(m.players[i].id, {
      t: 'match', mid: m.id, game, stake, seed: m.seed, startIn: START_IN_MS, limitMs: LIMIT_MS, bot: false,
      opp: { name: op.name, crowns: op.crowns, streak: op.streak }, me: view(me),
    });
  }
}

function createBotMatch(s, game, stake) {
  const p = store.get(s.id);
  const m = newMatch(game, stake, null);
  const r = rules.rng(m.seed ^ 0x5bd1e995);
  m.bot = {
    name: BOT_NAMES[Math.floor(r() * BOT_NAMES.length)] + Math.floor(r() * 90 + 10),
    crowns: Math.max(0, p.crowns + Math.floor(r() * 9) - 4),
    score: rules.botScore(game, m.seed, p.best[game], p.crowns),
  };
  takeStake(m, s.id);
  matches.set(m.id, m);
  store.touch();
  armDeadline(m);
  sendWs(s.ws, {
    t: 'match', mid: m.id, game, stake, seed: m.seed, startIn: START_IN_MS, limitMs: LIMIT_MS, bot: true,
    opp: { name: m.bot.name, crowns: m.bot.crowns, streak: 0 }, me: view(p),
  });
}

function armDeadline(m) {
  clearTimeout(m.timer);
  m.timer = setTimeout(() => resolve(m, 'timeout'), Math.max(0, m.deadline - now()));
  if (m.timer.unref) m.timer.unref();
}

/* ------------------------------------------------------------------ results */
const outcomeWord = (o) => (o === 1 ? 'win' : o === -1 ? 'loss' : 'draw');

function resolve(m) {
  if (m.done) return;
  m.done = true;
  clearTimeout(m.timer);
  matches.delete(m.id);

  const [A, B] = m.players;
  const out_ = (x) => x.forfeit || x.flagged;
  const score = (x) => (x && x.res !== null && !out_(x) ? x.res : null);
  const sa = score(A);
  const sb = B ? score(B) : m.bot.score;

  /* outcome from A's point of view: 1 win, 0 draw, -1 loss */
  let out;
  if (B) {
    if (out_(A) && out_(B)) out = 0;
    else if (out_(A)) out = -1;
    else if (out_(B)) out = 1;
    else if (sa === null && sb === null) out = 0;
    else if (sa === null) out = -1;
    else if (sb === null) out = 1;
    else out = sa > sb ? 1 : sa < sb ? -1 : 0;
  } else {
    out = out_(A) || sa === null ? -1 : sa > sb ? 1 : sa < sb ? -1 : 0;
  }

  const why = (self, other) => {
    if (self.flagged) return 'invalid';
    if (self.forfeit) return 'you_left';
    if (other && other.flagged) return 'opp_invalid';
    if (other && other.forfeit) return 'opp_left';
    if (self.res === null) return 'timeout';
    if (other && other.res === null) return 'opp_timeout';
    return 'score';
  };

  const finalize = (me, o, oppScore, oppName, bot, reason) => {
    const p = store.get(me.id);
    const before = p.crowns;
    const payout = o === 1 ? m.stake * 2 : o === 0 ? m.stake : 0;
    p.coins += payout;
    p.escrow = null;
    if (o === 1) {
      p.wins++; p.streak++;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      p.crowns += rules.winCrowns(p.streak);
    } else if (o === -1) {
      p.losses++; p.streak = 0;
      p.crowns = Math.max(0, p.crowns - rules.LOSS_CROWNS);
    } else {
      p.draws++;
    }
    const mine = score(me);
    const newBest = mine !== null && (p.best[m.game] === undefined || mine > p.best[m.game]);
    if (newBest) p.best[m.game] = mine;
    p.history.unshift({
      at: now(), game: m.game, stake: m.stake, outcome: outcomeWord(o),
      you: mine, opp: oppScore, oppName, bot, net: payout - m.stake,
    });
    p.history.length = Math.min(p.history.length, rules.HISTORY_LEN);
    playerMatch.delete(me.id);

    const msg = {
      t: 'result', mid: m.id, game: m.game, stake: m.stake, you: mine, opp: oppScore, oppName, bot,
      outcome: outcomeWord(o), reason, payout, net: payout - m.stake,
      crownsBefore: before, crownsAfter: p.crowns, crownDelta: p.crowns - before,
      streak: p.streak, best: p.best[m.game], newBest, rematch: !bot && !!B ? REMATCH_MS : 0, me: view(p),
    };
    if (!sendTo(me.id, msg)) p.pending = msg; /* shown next time they connect */
  };

  const nameOf = (x) => store.get(x.id).name;
  if (B) {
    finalize(A, out, sb, nameOf(B), false, why(A, B));
    finalize(B, -out, sa, nameOf(A), false, why(B, A));
    openRematch(m, A.id, B.id);
  } else {
    finalize(A, out, m.bot.score, m.bot.name, true, why(A, null));
  }
  store.touch();
}

function handleResult(s, msg) {
  const m = playerMatch.get(s.id);
  if (!m || m.id !== msg.mid || m.done) return fail(s, 'no_match', 'That match is over.');
  const me = m.players.find((x) => x.id === s.id);
  if (me.res !== null || me.forfeit || me.flagged) return;

  if (!rules.plausible(m.game, msg.score, now() - m.startAt)) {
    me.flagged = true;
    console.warn('Rejected score', msg.score, 'for', m.game, 'after', now() - m.startAt, 'ms');
    return resolve(m);
  }
  me.res = msg.score;
  if (m.bot) return resolve(m);

  const other = m.players.find((x) => x.id !== s.id);
  if (other.res !== null || other.forfeit || other.flagged) return resolve(m);

  /* tell the other player the number to beat, and start their clock */
  m.deadline = Math.min(m.hard, now() + GRACE_MS);
  armDeadline(m);
  sendTo(other.id, { t: 'opp_done', mid: m.id, score: msg.score, deadlineIn: m.deadline - now() });
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
  if (me.res !== null) return sendWs(s.ws, { t: 'waiting', mid: m.id }); /* already finished */
  me.forfeit = true;
  resolve(m);
}

/* ------------------------------------------------------------------ rematch */
function openRematch(m, a, b) {
  const offer = { mid: m.id, ids: [a, b], game: m.game, stake: m.stake, want: new Set(), timer: null };
  offer.timer = setTimeout(() => closeRematch(offer, 'expired'), REMATCH_MS);
  if (offer.timer.unref) offer.timer.unref();
  offers.set(m.id, offer);
  for (const id of offer.ids) {
    const old = offerOf.get(id);
    if (old && old !== offer) closeRematch(old, 'gone');
    offerOf.set(id, offer);
  }
}

function closeRematch(offer, why) {
  if (offers.get(offer.mid) !== offer) return;
  offers.delete(offer.mid);
  clearTimeout(offer.timer);
  for (const id of offer.ids) {
    if (offerOf.get(id) === offer) offerOf.delete(id);
    if (why !== 'started') sendTo(id, { t: 'rematch_off', mid: offer.mid, why });
  }
}

function dropRematch(id) {
  const offer = offerOf.get(id);
  if (offer) closeRematch(offer, 'declined');
}

function handleRematch(s, msg) {
  const offer = offers.get(msg.mid);
  if (!offer || !offer.ids.includes(s.id)) return fail(s, 'no_rematch', 'That rematch is no longer available.');
  if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
  if (store.get(s.id).coins < offer.stake) return fail(s, 'no_coins', 'Not enough coins for a rematch.');
  offer.want.add(s.id);
  const other = offer.ids.find((x) => x !== s.id);
  if (offer.want.size === 2) {
    closeRematch(offer, 'started');
    return createMatch(offer.ids[0], offer.ids[1], offer.game, offer.stake);
  }
  if (!sessions.has(other)) return closeRematch(offer, 'gone');
  sendTo(other, { t: 'rematch_offer', mid: offer.mid, name: store.get(s.id).name, stake: offer.stake, game: offer.game });
  sendWs(s.ws, { t: 'rematch_wait', mid: offer.mid });
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

function createRoom(s, game, stake) {
  if (rooms.size >= 5000) return fail(s, 'busy', 'Too many open rooms right now.');
  const code = newCode();
  if (!code) return fail(s, 'busy', 'Try again in a moment.');
  const room = { code, hostId: s.id, game, stake, timer: null };
  room.timer = setTimeout(() => {
    if (rooms.get(code) !== room) return;
    rooms.delete(code);
    roomByHost.delete(room.hostId);
    sendTo(room.hostId, { t: 'cancelled', why: 'room_expired' });
  }, ROOM_TTL_MS);
  if (room.timer.unref) room.timer.unref();
  rooms.set(code, room);
  roomByHost.set(s.id, room);
  sendWs(s.ws, { t: 'room', code, game, stake });
}

function joinRoom(s, p, raw) {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{4}$/.test(code)) return fail(s, 'bad_code', 'Room codes are 4 letters or numbers.');
  const room = rooms.get(code);
  if (room && room.hostId === s.id) return fail(s, 'own_room', 'That is your own room. Share the code with a friend.');
  if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
  if (!room || !sessions.has(room.hostId)) return fail(s, 'no_room', 'No open room with that code.');
  if (p.coins < room.stake) return fail(s, 'no_coins', 'You need ' + room.stake + ' coins to join that room.');
  if (store.get(room.hostId).coins < room.stake) return fail(s, 'no_room', 'The host no longer has enough coins.');
  rooms.delete(code);
  roomByHost.delete(room.hostId);
  clearTimeout(room.timer);
  createMatch(room.hostId, s.id, room.game, room.stake);
}

/* ------------------------------------------------------------------ ladder */
let ladderCache = { at: 0, rows: [] };

function ladder(myId) {
  if (now() - ladderCache.at > 5000) {
    const rows = [];
    for (const [id, p] of store.players) {
      if (p.wins + p.losses + p.draws > 0) rows.push({ id, name: p.name, crowns: p.crowns, wins: p.wins, streak: p.streak });
    }
    rows.sort((a, b) => b.crowns - a.crowns || b.wins - a.wins || (a.name < b.name ? -1 : 1));
    ladderCache = { at: now(), rows };
  }
  const rows = ladderCache.rows;
  const top = rows.slice(0, 25).map((r, i) => ({
    pos: i + 1, name: r.name, crowns: r.crowns, league: leagueName(r.crowns), streak: r.streak, me: r.id === myId,
  }));
  const idx = rows.findIndex((r) => r.id === myId);
  return { rows: top, rank: idx >= 0 ? idx + 1 : null, total: rows.length, online: onlineCount() };
}

/* ------------------------------------------------------------------ accounts */
function handleHello(s, msg) {
  if (s.id) return;
  let key = msg.key, id, p, isNew = false;

  if (key !== undefined && key !== null) {
    if (typeof key !== 'string' || !KEY_RE.test(key)) return fail(s, 'bad_key', 'That account key is not valid.');
    id = store.resolve(hashKey(key));
    p = store.get(id);
    if (!p) return fail(s, 'unknown_key', 'This server does not know that account key.');
  } else {
    const hits = pruneHits(ipNewAccounts.get(s.ip) || [], 3600000);
    ipNewAccounts.set(s.ip, hits);
    if (hits.length >= MAX_NEW_ACCOUNTS_PER_HOUR) {
      fail(s, 'rate', 'Too many new accounts from your network. Try again later.');
      return s.ws.close(1008, 'rate');
    }
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

  const welcome = { t: 'welcome', v: 2, me: view(p), online: onlineCount(), stakes: rules.STAKES };
  if (isNew) welcome.key = key;
  const m = playerMatch.get(id);
  if (m) {
    const mine = m.players.find((x) => x.id === id);
    const other = m.players.find((x) => x.id !== id);
    welcome.active = {
      mid: m.id, game: m.game, stake: m.stake, finished: mine.res !== null, bot: !!m.bot,
      oppName: other ? store.get(other.id).name : m.bot.name,
    };
  }
  if (p.pending) { welcome.pending = p.pending; p.pending = null; store.touch(); }
  sendWs(s.ws, welcome);
  broadcastOnline(true);
}

async function handleGoogle(s, credential) {
  let g;
  try {
    g = await auth.verifyGoogleIdToken(credential, { clientId: GOOGLE_CLIENT_ID, fetchJwks: jwksFetcher || undefined });
  } catch (e) {
    return fail(s, 'google_bad', 'Google sign-in could not be verified. Try again.');
  }
  if (!s.id || sessions.get(s.id) !== s || playerMatch.has(s.id)) return;
  const existing = store.googleIndex.get(g.sub);
  const me = store.get(s.id);
  if (!existing) {
    store.linkGoogle(s.id, g.sub);
    return sendWs(s.ws, { t: 'linked', me: view(me) });
  }
  if (existing === s.id) return sendWs(s.ws, { t: 'linked', me: view(me) });
  /* this Google account already has a player: hand this device a fresh key for it */
  const key = crypto.randomBytes(32).toString('base64url');
  if (!store.addAlias(hashKey(key), existing)) return fail(s, 'google_bad', 'That account has too many signed-in devices.');
  sendWs(s.ws, { t: 'switch', key });
}

/* ------------------------------------------------------------------ message handling */
function guardStart(s, p, game, stake) {
  if (!validGame(game) || !validStake(stake)) { fail(s, 'bad_request', 'Pick a game and a stake.'); return false; }
  if (busy(s.id)) { fail(s, 'busy', 'Finish what you are doing first.'); return false; }
  if (p.coins < stake) { fail(s, 'no_coins', 'Not enough coins for that stake.'); return false; }
  return true;
}

function handle(s, msg) {
  if (msg.t === 'ping') return sendWs(s.ws, { t: 'pong' });
  if (msg.t === 'hello') return handleHello(s, msg);
  if (!s.id) return fail(s, 'hello_first', 'Say hello first.');
  const p = store.get(s.id);

  switch (msg.t) {
    case 'queue':
      if (!guardStart(s, p, msg.game, msg.stake)) return;
      dropRematch(s.id);
      return enqueue(s, msg.game, msg.stake);
    case 'bot':
      if (!guardStart(s, p, msg.game, msg.stake)) return;
      dropRematch(s.id);
      return createBotMatch(s, msg.game, msg.stake);
    case 'room_create':
      if (!guardStart(s, p, msg.game, msg.stake)) return;
      dropRematch(s.id);
      return createRoom(s, msg.game, msg.stake);
    case 'room_join':
      dropRematch(s.id);
      return joinRoom(s, p, msg.code);
    case 'cancel':
      leaveQueues(s.id);
      return sendWs(s.ws, { t: 'cancelled' });
    case 'progress': return handleProgress(s, msg);
    case 'result': return handleResult(s, msg);
    case 'forfeit': return handleForfeit(s, msg);
    case 'rematch': return handleRematch(s, msg);
    case 'rematch_no': {
      const offer = offers.get(msg.mid);
      if (offer && offer.ids.includes(s.id)) closeRematch(offer, 'declined');
      return;
    }
    case 'name':
      p.name = cleanName(msg.name);
      store.touch();
      return sendWs(s.ws, { t: 'me', me: view(p) });
    case 'claim': {
      if (p.daily + DAY - now() > 0) return fail(s, 'daily_wait', 'Your daily bonus is not ready yet.', { me: view(p) });
      p.coins += rules.DAILY_COINS;
      p.daily = now();
      store.touch();
      return sendWs(s.ws, { t: 'me', me: view(p), gift: rules.DAILY_COINS });
    }
    case 'refill': {
      if (p.coins >= rules.STAKES[0]) return fail(s, 'no_need', 'You still have enough coins to play.');
      const wait = p.refillAt + rules.REFILL_EVERY_MS - now();
      if (wait > 0) return fail(s, 'refill_wait', 'You can refill again in ' + Math.ceil(wait / 60000) + ' min.');
      p.coins += rules.REFILL_COINS;
      p.refillAt = now();
      store.touch();
      return sendWs(s.ws, { t: 'me', me: view(p), gift: rules.REFILL_COINS });
    }
    case 'reset':
      if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
      Object.assign(p, {
        coins: rules.START_COINS, crowns: 0, wins: 0, losses: 0, draws: 0,
        streak: 0, bestStreak: 0, best: {}, history: [],
      });
      store.touch();
      return sendWs(s.ws, { t: 'me', me: view(p) });
    case 'ladder':
      return sendWs(s.ws, Object.assign({ t: 'ladder' }, ladder(s.id)));
    case 'google':
      if (!GOOGLE_CLIENT_ID) return fail(s, 'google_off', 'Google sign-in is not set up on this server.');
      if (busy(s.id)) return fail(s, 'busy', 'Finish what you are doing first.');
      return handleGoogle(s, msg.credential);
    default:
      return fail(s, 'bad_request', 'Unknown message.');
  }
}

function onClose(s) {
  const n = (ipConns.get(s.ip) || 1) - 1;
  if (n <= 0) ipConns.delete(s.ip); else ipConns.set(s.ip, n);
  if (s.id && sessions.get(s.id) === s) {
    sessions.delete(s.id);
    leaveQueues(s.id);
    dropRematch(s.id);
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
  "script-src 'self' https://cdnjs.cloudflare.com https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss: https://accounts.google.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function baseHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': CSP,
  };
}

const httpServer = http.createServer((req, res) => {
  const headers = baseHeaders();
  const reply = (code, type, body, extra) => {
    res.writeHead(code, Object.assign({ 'Content-Type': type }, headers, extra || {}));
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'text/plain', 'Method not allowed', { Allow: 'GET, HEAD' });

  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return reply(400, 'text/plain', 'Bad request'); }

  const base = env('PUBLIC_URL', '').replace(/\/+$/, '');
  if (pathname === '/healthz') return reply(200, 'text/plain', 'ok');
  if (pathname === '/config.json') {
    return reply(200, 'application/json; charset=utf-8', JSON.stringify({ googleClientId: GOOGLE_CLIENT_ID || null }), { 'Cache-Control': 'no-cache' });
  }
  if (pathname === '/robots.txt') {
    return reply(200, 'text/plain; charset=utf-8', 'User-agent: *\nAllow: /\n' + (base ? 'Sitemap: ' + base + '/sitemap.xml\n' : ''));
  }
  if (pathname === '/sitemap.xml' && base) {
    return reply(200, 'application/xml; charset=utf-8',
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>' +
      base + '/</loc></url></urlset>\n');
  }

  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return reply(404, 'text/plain', 'Not found');

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return reply(404, 'text/plain', 'Not found');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    }, headers));
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

/* ------------------------------------------------------------------ WebSocket */
const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 4096 });

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const ip = clientIp(req);
  const count = (ipConns.get(ip) || 0) + 1;
  ipConns.set(ip, count);
  const s = { ws, ip, id: null, tokens: 80, refillAt: now(), replaced: false };
  if (count > MAX_CONN_PER_IP) { ws.close(1013, 'busy'); onClose(s); return; }

  const helloTimer = setTimeout(() => { if (!s.id) ws.close(1008, 'hello timeout'); }, 10000);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    /* token bucket: 40 messages a second, bursts of 80 */
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

/* ------------------------------------------------------------------ start and stop */
function start(port) {
  return new Promise((ok) => {
    httpServer.listen(port === undefined ? PORT : port, HOST, () => ok(httpServer.address().port));
  });
}

function stop() {
  return new Promise((ok) => {
    clearInterval(heartbeat);
    store.flush();
    for (const ws of wss.clients) ws.terminate();
    for (const m of matches.values()) clearTimeout(m.timer);
    for (const o of offers.values()) clearTimeout(o.timer);
    wss.close(() => httpServer.close(() => ok()));
  });
}

if (require.main === module) {
  start().then((port) => console.log('Crown Arcade is running on http://localhost:' + port));
  const bye = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

module.exports = { start, stop, store, _setJwksFetcher: (f) => { jwksFetcher = f; } };
