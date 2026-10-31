'use strict';
/*
 * Game rules the server enforces. The browser keeps its own copy of the display
 * constants (names, stakes, leagues) in public/js/config.js.
 */

const GAMES = ['orbit', 'stack', 'lane', 'hop', 'blackjack', 'chaos'];
const STAKES = [25, 50, 100];
const LEAGUES = [['Bronze', 0], ['Silver', 15], ['Gold', 40], ['Platinum', 80], ['Diamond', 140]];

/* Crowns */
const WIN_CROWNS = 3;
const LOSS_CROWNS = 1;
const STREAK_AT = 3;      /* from the 3rd win in a row ... */
const STREAK_BONUS = 1;   /* ... every win earns +1 extra crown */

/* Economy */
const START_COINS = 500;
const DAILY_COINS = 100;
const REFILL_COINS = 500;
const REFILL_EVERY_MS = 5 * 60 * 1000;
const HISTORY_LEN = 12;

/* The most a game can ever score, and the most it can gain per second (human-possible, with headroom). */
/* Generous ceilings only: the games are endless, the per-second RATE below is the real limit. */
const CAPS = { orbit: 300, stack: 100000, lane: 1000000, hop: 100000, blackjack: 600, chaos: 4000 };
const RATE = { orbit: 30, stack: 8, lane: 100, hop: 10, blackjack: 0, chaos: 600 }; /* chaos: one big chain reaction can score a lot at once */
/* Blackjack is scored in chips: you start with 200, bet 20 a hand (40 doubled) over 10 hands. */
const BJ_START = 200, BJ_HANDS = 10, BJ_MAX_SWING = 40;
const SLACK_S = 2.0; /* covers network delay and clock differences between the two players */

/* mulberry32: small, fast, deterministic. The browser uses the identical function. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function leagueIdx(crowns) {
  let idx = 0;
  for (let i = 0; i < LEAGUES.length; i++) if (crowns >= LEAGUES[i][1]) idx = i;
  return idx;
}

/* Is this score possible this long after the match started? Catches made-up numbers, not subtle cheating. */
function plausible(game, score, elapsedMs) {
  if (!GAMES.includes(game)) return false;
  if (!Number.isInteger(score) || score < 0) return false;
  if (score > CAPS[game]) return false;
  const t = Math.max(0, elapsedMs) / 1000 + SLACK_S;
  if (game === 'blackjack') {
    const hands = Math.min(BJ_HANDS, Math.floor(t / 2) + 1); /* a hand takes a few seconds at the very least */
    return score <= BJ_START + BJ_MAX_SWING * hands && score >= Math.max(0, BJ_START - BJ_MAX_SWING * hands);
  }
  return score <= RATE[game] * t + (game === 'orbit' ? 6 : 3);
}

/*
 * Score for a computer opponent. It plays around the player's own best
 * (82% to 108% of it), so a player in form wins a bit more than half the time.
 * New players face an easy target that grows with their league.
 */
const BOT_BASE = {
  orbit: { start: 14, perLeague: 6, spread: 12 },
  stack: { start: 7, perLeague: 3, spread: 6 },
  hop: { start: 9, perLeague: 3, spread: 8 },
  lane: { start: 450, perLeague: 90, spread: 500 },
  blackjack: { start: 185, perLeague: 6, spread: 50 },
  chaos: { start: 150, perLeague: 30, spread: 200 },
};

function botScore(game, seed, best, crowns) {
  const r = rng((seed ^ 0x2f1d3c5) >>> 0);
  const lv = leagueIdx(crowns);
  const b = BOT_BASE[game];
  let s;
  if (best) s = best * (0.82 + r() * 0.26);
  else s = b.start + lv * b.perLeague + r() * b.spread;
  return Math.max(1, Math.min(CAPS[game], Math.round(s)));
}

/*
 * Blitz: play alone for coins. The payout depends on your score against a break-even
 * point that sits a little ABOVE your recent average (average of your last scores in that game,
 * blended with a starting guess until you have a few). Score the break-even and you get your stake
 * back; score less and you get a fraction of it; score more and you win up to 3x.
 */
const BLITZ_BASE = { orbit: 22, stack: 9, lane: 650, hop: 12, blackjack: 195, chaos: 250 };
const BLITZ_EDGE = 1.1, BLITZ_MAX_MULT = 3, BLITZ_PRIOR = 3, RECENT_LEN = 10;

function blitzTarget(game, recent) {
  const base = BLITZ_BASE[game];
  const list = Array.isArray(recent) ? recent.slice(-RECENT_LEN) : [];
  const avg = (list.reduce((a, b) => a + b, 0) + BLITZ_PRIOR * base) / (list.length + BLITZ_PRIOR);
  /* the floor stops anyone lowering their target by throwing games on purpose */
  return Math.max(Math.ceil(avg * BLITZ_EDGE), Math.ceil(base * 0.5));
}

function blitzPayout(stake, score, target) {
  return Math.floor(stake * Math.min(BLITZ_MAX_MULT, Math.max(0, score) / target));
}

/* Crowns gained for a win, given the win streak *including* this win. */
function winCrowns(streak) {
  return WIN_CROWNS + (streak >= STREAK_AT ? STREAK_BONUS : 0);
}

module.exports = {
  GAMES, STAKES, LEAGUES, CAPS, RATE, SLACK_S,
  WIN_CROWNS, LOSS_CROWNS, STREAK_AT, STREAK_BONUS,
  START_COINS, DAILY_COINS, REFILL_COINS, REFILL_EVERY_MS, HISTORY_LEN,
  rng, leagueIdx, plausible, botScore, winCrowns,
  BLITZ_BASE, BLITZ_EDGE, BLITZ_MAX_MULT, RECENT_LEN, BJ_START, BJ_HANDS, blitzTarget, blitzPayout,
};
