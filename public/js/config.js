/* Shared constants and tiny helpers. Everything hangs off one global: CA. */
(function () {
  'use strict';
  var CA = (window.CA = window.CA || {});
  CA.games = {}; /* game modules register here */

  /* Display copies of the server rules (rules.js is the source of truth). */
  CA.STAKES = [25, 50, 100];
  CA.LEAGUES = [['Bronze', 0], ['Silver', 15], ['Gold', 40], ['Platinum', 80], ['Diamond', 140]];
  CA.LEAGUE_COLORS = ['#e09a5b', '#c9d3e6', '#ffc93c', '#6ee7ff', '#c4a3ff'];
  CA.WIN_CROWNS = 3;
  CA.STREAK_AT = 3;

  CA.GAMES = {
    orbit: { name: 'Orbit Tap', unit: 'pts', label: 'Points', skill: 'Timing', is3d: false,
      blurb: 'Tap as a bar crosses the gate.',
      tip: 'Tap when a bar crosses the gate at the top. Small bars score more. Dead-centre taps score a Perfect bonus.' },
    stack: { name: 'Stack', unit: 'floors', label: 'Floors', skill: 'Precision', is3d: true,
      blurb: 'Drop blocks. Build the tallest tower.',
      tip: 'Tap to drop the sliding block. Overhang is cut off. Four perfect drops in a row grow the block back.' },
    lane: { name: 'Lane Dash', unit: 'm', label: 'Distance', skill: 'Reflex', is3d: true,
      blurb: 'Dodge traffic at full throttle.',
      tip: 'Swipe, tap a side or use the arrow keys to switch lanes. It only gets faster.' },
    hop: { name: 'Road Hop', unit: 'rows', label: 'Rows', skill: 'Nerve', is3d: true,
      blurb: 'Cross roads, rivers and logs.',
      tip: 'Tap to hop forward, swipe to turn. Ride logs, land on lily pads, and keep moving: the edge is coming.' },
  };
  CA.GAMES.blackjack = { name: 'Blackjack', unit: 'chips', label: 'Chips', skill: 'Nerve', is3d: false,
    blurb: 'Ten hands. Finish with the most chips.',
    tip: 'Hit, stand or double. You start with 200 chips and bet 20 a hand. Both players get the same shuffled cards.' };
  CA.GAMES.chaos = { name: 'Chaos Cannon', unit: 'pts', label: 'Points', skill: 'Aim', is3d: false,
    blurb: 'Ten shots. Chain the explosions.',
    tip: 'Tap to fire the sweeping cannon. TNT and mega bombs set off their neighbours, and every step of a chain is worth more.' };
  CA.GKEYS = ['orbit', 'stack', 'lane', 'hop', 'blackjack', 'chaos'];

  /* mulberry32, identical to the server, so both players get the same board. */
  CA.rng = function (seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* Cheap integer hash for decoration that must look random but stay stable. */
  CA.hash = function (n) {
    n = (Math.imul(n | 0, 1103515245) + 12345) >>> 0;
    return (n ^ (n >>> 16)) >>> 0;
  };

  CA.leagueIdx = function (c) {
    var i = 0;
    for (var k = 0; k < CA.LEAGUES.length; k++) if (c >= CA.LEAGUES[k][1]) i = k;
    return i;
  };

  CA.fmt = function (game, v) {
    if (v === null || v === undefined) return '–';
    var g = CA.GAMES[game];
    if (g.unit === 'm') return v + ' m';
    return v + ' ' + (v === 1 ? g.unit.replace(/s$/, '') : g.unit);
  };

  CA.esc = function (t) {
    return String(t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  CA.$ = function (id) { return document.getElementById(id); };

  CA.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };

  CA.ago = function (t) {
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  };

  CA.reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
})();
