'use strict';
/*
 * Player accounts kept in memory and saved to one JSON file.
 * Fine for a small site; use a real database to scale past one server.
 */
const fs = require('fs');
const path = require('path');
const { START_COINS } = require('./rules');

/* Fields every player has. Older saves are filled in from here on load. */
function defaults(name) {
  return {
    name, coins: START_COINS, crowns: 0, wins: 0, losses: 0, draws: 0,
    streak: 0, bestStreak: 0, best: {}, history: [],
    daily: 0, refillAt: 0, created: Date.now(), seen: Date.now(),
    escrow: null, pending: null, google: null,
  };
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'players.json');
    this.players = new Map();
    this.aliases = new Map();     /* extra sign-in key hashes -> account id (Google sign-in on another device) */
    this.googleIndex = new Map(); /* google user id -> account id */
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not read player data:', e.message);
    }
    if (data && data.players) {
      for (const id of Object.keys(data.players)) {
        const p = Object.assign(defaults('Player'), data.players[id]);
        this.players.set(id, p);
      }
    }
    if (data && data.aliases) for (const k of Object.keys(data.aliases)) this.aliases.set(k, data.aliases[k]);
    for (const [id, p] of this.players) if (p.google) this.googleIndex.set(p.google, id);

    /* A crash in the middle of a match must not cost anyone their stake. */
    let refunded = 0;
    for (const p of this.players.values()) {
      if (p.escrow) { p.coins += p.escrow.stake; p.escrow = null; refunded++; }
    }
    if (refunded) {
      console.log('Refunded ' + refunded + ' stake(s) from matches interrupted by a restart.');
      this.touch();
    }
  }

  get(id) { return this.players.get(id); }

  resolve(keyId) { return this.aliases.get(keyId) || keyId; }

  addAlias(keyId, id) {
    let n = 0;
    for (const v of this.aliases.values()) if (v === id) n++;
    if (n >= 20) return false;
    this.aliases.set(keyId, id);
    this.touch();
    return true;
  }

  linkGoogle(id, sub) {
    this.players.get(id).google = sub;
    this.googleIndex.set(sub, id);
    this.touch();
  }

  create(id, name) {
    const p = defaults(name);
    this.players.set(id, p);
    this.touch();
    return p;
  }

  /* Debounced save: many changes in a burst become one write. */
  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 400);
    if (this.timer.unref) this.timer.unref();
  }

  /* Atomic save: write a temp file, then rename over the real one. */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const out = { v: 2, players: Object.fromEntries(this.players), aliases: Object.fromEntries(this.aliases) };
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Could not save player data:', e.message);
    }
  }
}

module.exports = { Store };
