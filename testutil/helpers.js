'use strict';
const WebSocket = require('ws');

/* A tiny test client: collects every message so tests can wait for a specific one. */
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const inbox = [];
    const waiters = [];
    let closed = null;
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        const idx = inbox.findIndex(w.test);
        if (idx >= 0) { const m = inbox.splice(idx, 1)[0]; waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(m); }
      }
    });
    ws.on('close', (code) => { closed = code; for (const w of waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('closed ' + code + ' while waiting for ' + w.label)); } });
    ws.on('error', reject);
    ws.on('open', () => {
      const c = {
        ws, inbox,
        send: (o) => ws.send(JSON.stringify(o)),
        sendRaw: (x) => ws.send(x),
        closeCode: () => closed,
        next(type, ms) {
          const test = typeof type === 'function' ? type : (m) => m.t === type;
          const idx = inbox.findIndex(test);
          if (idx >= 0) return Promise.resolve(inbox.splice(idx, 1)[0]);
          return new Promise((res, rej) => {
            const w = { test, resolve: res, reject: rej, label: String(type) };
            w.timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('timeout waiting for ' + w.label + '; inbox=' + JSON.stringify(inbox))); }, ms || 3000);
            waiters.push(w);
          });
        },
        has: (type) => inbox.some((m) => m.t === type),
        close: () => ws.close(),
        async hello(key, name) {
          c.send(key ? { t: 'hello', key } : { t: 'hello', name });
          return c.next((m) => m.t === 'welcome' || m.t === 'error');
        },
      };
      resolve(c);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { connect, sleep };
