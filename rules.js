'use strict';
/*
 * Game rules the server enforces. The browser keeps its own copy of the display
 * constants (names, stakes, leagues) in public/js/config.js.
 */

const GAMES = ['orbit', 'stack', 'lane', 'hop'];
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
const CAPS = { orbit: 300, stack: 150, lane: 2000, hop: 100 };
const RATE = { orbit: 30, stack: 8, lane: 100, hop: 10 };
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

/* Crowns gained for a win, given the win streak *including* this win. */
function winCrowns(streak) {
  return WIN_CROWNS + (streak >= STREAK_AT ? STREAK_BONUS : 0);
}

module.exports = {
  GAMES, STAKES, LEAGUES, CAPS, RATE, SLACK_S,
  WIN_CROWNS, LOSS_CROWNS, STREAK_AT, STREAK_BONUS,
  START_COINS, DAILY_COINS, REFILL_COINS, REFILL_EVERY_MS, HISTORY_LEN,
  rng, leagueIdx, plausible, botScore, winCrowns,
};
