'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { test } = require('node:test');
const assert = require('node:assert');
const { connect, sleep } = require('../testutil/helpers');

function get(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: method || 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function launch(dataDir, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(port), DATA_DIR: dataDir, CA_START_IN_MS: '50', HOST: '127.0.0.1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('running on')) resolve(child); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (c) => reject(new Error('server exited early: ' + c + ' ' + out)));
    setTimeout(() => reject(new Error('server did not start: ' + out)), 5000);
  });
}
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

test('the website is served, with safe headers, and cannot read other files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-http-'));
  const port = await freePort();
  const child = await launch(dir, port);
  try {
    const home = await get(port, '/');
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /text\/html/);
    assert.match(home.body, /Crown Arcade/);
    assert.match(home.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(home.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(port, '/healthz')).body, 'ok');
    assert.equal((await get(port, '/index.html', 'HEAD')).status, 200);
    for (const bad of ['/../server.js', '/..%2fserver.js', '/%2e%2e/package.json', '/../../etc/passwd', '/data/players.json', '/nope.html', '//etc/passwd']) {
      const r = await get(port, bad);
      assert.ok(r.status === 404 || r.status === 400, bad + ' -> ' + r.status);
      assert.ok(!/"dependencies"|root:|players/.test(r.body), bad + ' leaked content');
    }
    assert.equal((await get(port, '/', 'POST')).status, 405);
  } finally { child.kill(); }
});

test('accounts survive a restart, and a crash mid-match refunds both stakes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crown-persist-'));
  const port = await freePort();
  let child = await launch(dir, port);
  const a = await connect(port), b = await connect(port);
  const wa = await a.hello(null, 'Alice'), wb = await b.hello(null, 'Bobby');
  a.send({ t: 'claim' });
  await a.next('me');
  a.send({ t: 'queue', game: 'stack', stake: 100 });
  b.send({ t: 'queue', game: 'stack', stake: 100 });
  const ma = await a.next('match');
  assert.equal(ma.me.coins, 500, 'Alice: 500 + 100 bonus - 100 stake');
  await sleep(700); /* let the server save */
  child.kill('SIGKILL'); /* crash, no clean shutdown */
  await new Promise((r) => child.on('exit', r));
  child = await launch(dir, port);
  try {
    const a2 = await connect(port), b2 = await connect(port);
    const ra = await a2.hello(wa.key), rb = await b2.hello(wb.key);
    assert.equal(ra.me.name, 'Alice');
    assert.equal(ra.me.coins, 600, 'stake returned, bonus kept');
    assert.equal(rb.me.coins, 500, 'stake returned');
    assert.equal(ra.active, undefined, 'no ghost match');
  } finally { child.kill(); }
});
