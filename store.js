'use strict';
/* Player accounts kept in memory and saved to one JSON file. Fine for a small site; use a real database to scale past one server. */
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'players.json');
    this.players = new Map();
    this.timer = null;
    fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.error('Could not read player data:', e.message); }
    if (data && data.players) for (const id of Object.keys(data.players)) this.players.set(id, data.players[id]);
    /* A crash in the middle of a match must not cost anyone their stake. */
    let refunded = 0;
    for (const p of this.players.values()) {
      if (p.escrow) { p.coins += p.escrow.stake; p.escrow = null; refunded++; }
    }
    if (refunded) { console.log('Refunded ' + refunded + ' stake(s) from matches interrupted by a restart.'); this.touch(); }
  }

  get(id) { return this.players.get(id); }

  create(id, name) {
    const p = { name, coins: 500, crowns: 0, wins: 0, losses: 0, best: {}, daily: 0, refillAt: 0, created: Date.now(), escrow: null, pending: null };
    this.players.set(id, p);
    this.touch();
    return p;
  }

  touch() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 400);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const out = { v: 1, players: Object.fromEntries(this.players) };
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(out));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('Could not save player data:', e.message); }
  }
}

module.exports = { Store };
