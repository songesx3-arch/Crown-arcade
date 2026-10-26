'use strict';
/* Game rules the server enforces. The browser keeps its own copy of the display constants (names, stakes, leagues). */

const GAMES = ['orbit', 'stack', 'lane', 'hop'];
const STAKES = [25, 50, 100];
const LEAGUES = [['Bronze', 0], ['Silver', 15], ['Gold', 40], ['Platinum', 80], ['Diamond', 140]];

/* The most a game can ever score, and the most it can gain per second (human-possible, with a lot of headroom). */
const CAPS = { orbit: 302, stack: 150, lane: 2000, hop: 100 };
const RATE = { orbit: 30, stack: 8, lane: 100, hop: 10 };
const SLACK_S = 2.0; /* covers network delay and clock differences between the two players */

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
  if (!Number.isInteger(score) || score < 0) return false;
  if (score > CAPS[game]) return false;
  const t = Math.max(0, elapsedMs) / 1000 + SLACK_S;
  return score <= RATE[game] * t + (game === 'orbit' ? 6 : 3);
}

/* Score for a practice-bot opponent. It aims a few percent above the player's best in that game. */
function botScore(game, seed, best, crowns) {
  const r = rng((seed ^ 0x2f1d3c5) >>> 0);
  const lv = leagueIdx(crowns);
  const prev = best;
  let s;
  if (game === 'orbit') s = Math.min(300, Math.round(prev ? Math.ceil(prev * (1.02 + r() * 0.06)) : 12 + lv * 4 + r() * 14));
  else if (game === 'stack') s = Math.min(150, Math.round(prev ? Math.ceil(prev * (1.02 + r() * 0.06)) : 6 + lv * 2 + r() * 8));
  else if (game === 'hop') s = Math.min(100, Math.round(prev ? Math.ceil(prev * (1.02 + r() * 0.06)) : 8 + lv * 2 + r() * 10));
  else s = Math.min(2000, Math.round(prev ? prev * (1.02 + r() * 0.06) : 500 + lv * 80 + r() * 600));
  return s;
}

module.exports = { GAMES, STAKES, LEAGUES, CAPS, RATE, rng, leagueIdx, plausible, botScore };
