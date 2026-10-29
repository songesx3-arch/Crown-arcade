/*
 * Road Hop (three.js)
 * Hop a chicken forward across grass, roads and rivers. Cars kill, water drowns,
 * logs carry you sideways, lily pads stay still. The camera keeps creeping forward,
 * so standing around is not safe either. Score is the furthest row reached.
 *
 * Every row is generated from the match seed and every moving thing is a pure function
 * of time since the start, so both players face exactly the same traffic.
 */
(function () {
  'use strict';
  var CA = window.CA, K;

  CA.games.hop = function (api) {
    K = CA.three;
    var W = 360, H = 520, COLS = 9, CAP = 100, P = 24, HOP_T = 0.12, EDGE = 0.35;

    api.fit(W / H);
    var ren = K.renderer(api.canvas, W, H);
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x86d0f5);
    scene.fog = new THREE.Fog(0x86d0f5, 14, 30);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x5a7aa0, 0.62));
    var sun = new THREE.DirectionalLight(0xfff1d6, 0.5);
    sun.position.set(-5, 10, 4);
    scene.add(sun);
    var camera = new THREE.PerspectiveCamera(52, W / H, 0.1, 80);
    var owned = [];
    function own(x) { owned.push(x); return x; }

    var seed = api.seed, cache = {};
    var CAR_COLORS = [0xffc93c, 0xff5d8f, 0x5ad8ff, 0xb892ff, 0xff8a3d, 0x3ee6a0];

    /* ---------------------------------------------------------------- level */
    /* row types: g grass (trees), r road (cars), w water (sub: moving logs, or still lily pads) */
    function getRow(i) {
      if (cache[i]) return cache[i];
      var q = CA.rng((seed + i * 7919) >>> 0), row, c;
      var u = q(), v = q(), pt = i > 0 ? getRow(i - 1) : null;
      var ws = pt && pt.t === 'w' ? pt.ws : 0, kind = 'g';
      if (i > 5 && ws < 3 && v < (ws ? 0.5 : 0.2)) kind = 'w';
      else if (i > 2 && u < (pt && pt.t === 'r' ? 0.55 : 0.72)) kind = 'r';

      if (kind === 'r') {
        row = { t: 'r', dir: q() < 0.5 ? -1 : 1, n: 3 + (q() < 0.5 ? 1 : 0), off: q() * P };
        row.speed = (1.8 + q() * 2.0) * (1 + Math.min(i, 60) * 0.015);
        row.kind = ((i * 37 + (seed % 97)) % 7 + 7) % 7;
        row.len = [1.5, 1.5, 1.5, 1.5, 2.8, 2.8, 1.9][row.kind];
        if (row.len > 2) row.n = 3;
      } else if (kind === 'w') {
        row = { t: 'w', ws: ws + 1, sub: ws ? (pt.sub === 'logs' ? 'pads' : 'logs') : (q() < 0.5 ? 'logs' : 'pads') };
        if (row.sub === 'logs') {
          row.dir = q() < 0.5 ? -1 : 1; row.n = 4; row.len = 2.6 + q() * 1.2;
          row.speed = (1.3 + q() * 1.3) * (1 + Math.min(i, 60) * 0.01); row.off = q() * P;
        } else {
          row.pads = []; var np = 0;
          for (c = 0; c < COLS; c++) { var pd = q() < 0.62; row.pads.push(pd); if (pd) np++; }
          for (var guard = 0; np < 5 && guard < 200; guard++) { var cc = Math.floor(q() * COLS); if (!row.pads[cc]) { row.pads[cc] = true; np++; } }
        }
      } else {
        row = { t: 'g', tr: [] };
        var clear = 0;
        for (c = 0; c < COLS; c++) { var tree = i > 2 && q() < 0.2; row.tr.push(tree); if (!tree) clear++; }
        if (clear < 4) row.tr = row.tr.map(function () { return false; });
      }
      cache[i] = row;
      return row;
    }

    /* x positions of the cars or logs in a row at time t (seconds since the start) */
    function movers(row, t) {
      var out = [];
      for (var k = 0; k < row.n; k++) out.push(((row.off + k * P / row.n + row.dir * row.speed * t) % P + P) % P - P / 2);
      return out;
    }

    /* ---------------------------------------------------------------- props */
    var G = {
      trunk: K.geo('hopTrunk', function () { return new THREE.BoxGeometry(0.22, 0.5, 0.22); }),
      pad: K.geo('hopPad', function () { return new THREE.CylinderGeometry(0.44, 0.44, 0.08, 24); }),
      wheel: K.geo('hopWheel', function () { var g = new THREE.CylinderGeometry(0.2, 0.2, 0.16, 14); g.rotateX(Math.PI / 2); return g; }),
      log: K.geo('hopLogEnd', function () { var g = new THREE.CylinderGeometry(0.3, 0.3, 0.06, 16); g.rotateZ(Math.PI / 2); return g; }),
    };

    function tree(g, x, h) {
      K.mesh(G.trunk, K.lam(0x8a5a33), x, 0.25, 0, g);
      K.rb(0.8, 0.5 + h, 0.8, 0.12, 0x2f9e5b, x, 0.75 + h / 2, 0, g);
      K.rb(0.56, 0.36, 0.56, 0.1, 0x46c47a, x, 1.08 + h, 0, g);
    }
    function rock(g, x) { K.rb(0.7, 0.5, 0.62, 0.16, 0x9a98b8, x, 0.25, 0, g); K.rb(0.36, 0.22, 0.3, 0.08, 0xb9b7d4, x + 0.08, 0.56, 0.04, g); }
    function flower(g, x, z, c) { K.rb(0.06, 0.18, 0.06, 0.02, 0x2a8c55, x, 0.09, z, g); K.rb(0.16, 0.12, 0.16, 0.05, c, x, 0.22, z, g); }

    function buildCar(row, i) {
      var g = new THREE.Group(), L = row.len, col = CAR_COLORS[(i + row.kind) % CAR_COLORS.length];
      var body = new THREE.Group();
      if (L > 2.5) { /* truck */
        K.rb(0.8, 0.72, 0.86, 0.14, col, L / 2 - 0.45, 0.6, 0, body);
        K.rb(0.06, 0.3, 0.7, 0.02, 0x16224a, L / 2 - 0.04, 0.74, 0, body);
        K.rb(1.75, 0.95, 0.9, 0.14, 0xf4f0ff, -0.4, 0.78, 0, body);
        K.rb(1.77, 0.14, 0.92, 0.05, col, -0.4, 0.46, 0, body);
      } else if (L > 1.7) { /* van */
        K.rb(1.85, 0.8, 0.88, 0.2, 0xf4f0ff, 0, 0.6, 0, body);
        K.rb(1.87, 0.14, 0.9, 0.05, col, 0, 0.42, 0, body);
        K.rb(0.06, 0.3, 0.72, 0.02, 0x16224a, L / 2 - 0.02, 0.74, 0, body);
      } else { /* car */
        K.rb(1.5, 0.42, 0.84, 0.16, col, 0, 0.4, 0, body);
        K.rb(0.8, 0.34, 0.72, 0.13, 0x16224a, -0.08, 0.74, 0, body);
        K.rb(0.74, 0.08, 0.66, 0.04, col, -0.08, 0.93, 0, body);
      }
      K.rb(0.06, 0.12, 0.62, 0.03, K.basic(0xfff3b0), L / 2, 0.42, 0, body);
      K.rb(0.06, 0.1, 0.62, 0.03, K.basic(0xff3355), -L / 2, 0.42, 0, body);
      var wx = L > 2.5 ? [L / 2 - 0.5, -0.2, -0.9] : [L / 2 - 0.42, -L / 2 + 0.42];
      wx.forEach(function (x) { [-0.42, 0.42].forEach(function (z) { K.mesh(G.wheel, K.lam(0x1a1430), x, 0.2, z, body); }); });
      if (row.dir < 0) body.rotation.y = Math.PI;
      g.add(body);
      return g;
    }

    function buildLog(len) {
      var g = new THREE.Group();
      K.rb(len, 0.5, 0.62, 0.2, 0xa8693a, 0, 0, 0, g);
      K.rb(len * 0.92, 0.06, 0.5, 0.03, 0x8a5229, 0, 0.25, 0, g);
      [-1, 1].forEach(function (s) { K.mesh(G.log, K.lam(0xe6c08a), s * (len / 2 + 0.01), 0, 0, g); });
      return g;
    }

    /* lane line texture for the gap between two road rows */
    var dashTex = (function () {
      var c = document.createElement('canvas'); c.width = 64; c.height = 8;
      var x = c.getContext('2d'); x.fillStyle = 'rgba(255,255,255,0.85)'; x.fillRect(8, 2, 28, 4);
      var t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.repeat.set(14, 1);
      return own(t);
    })();
    var dashMat = own(new THREE.MeshBasicMaterial({ map: dashTex, transparent: true, depthWrite: false }));
    var dashGeo = own(new THREE.PlaneGeometry(30, 0.08));

    function buildRow(i) {
      var row = getRow(i), g = new THREE.Group(), q = CA.rng((seed + i * 131) >>> 0), c, k;
      var prev = i > 0 ? getRow(i - 1) : null, next = getRow(i + 1);
      if (row.t === 'g') {
        K.rb(30, 0.4, 1, 0.04, i % 2 ? 0x5cc96f : 0x52bd66, 0, -0.2, 0, g);
        for (c = 0; c < COLS; c++) {
          var x = c - 4;
          if (row.tr[c]) {
            var ty = CA.hash(i * 13 + c) % 3;
            if (ty === 2) rock(g, x); else tree(g, x, ty * 0.35);
          } else if (CA.hash(i * 31 + c * 7) % 8 === 0) {
            flower(g, x + (q() - 0.5) * 0.5, (q() - 0.5) * 0.6, [0xff9ec7, 0xffe38a, 0xffffff][CA.hash(i + c) % 3]);
          }
        }
        /* scenery past the edges */
        [-1, 1].forEach(function (sd) {
          for (k = 0; k < 3; k++) if (i > 1 && q() < 0.55) tree(g, sd * (5.6 + k * 1.8 + q()), q() * 0.5);
        });
      } else if (row.t === 'w') {
        K.rb(30, 0.3, 1, 0.02, 0x3aa0e6, 0, -0.3, 0, g);
        for (k = 0; k < 7; k++) K.rb(0.4 + q() * 0.6, 0.02, 0.05, 0.01, K.basic(0xbfe8ff), (q() - 0.5) * 20, -0.14, (q() - 0.5) * 0.8, g);
        if (!prev || prev.t !== 'w') K.rb(30, 0.2, 0.14, 0.05, 0xc9b27a, 0, -0.06, 0.5, g);
        if (next.t !== 'w') K.rb(30, 0.2, 0.14, 0.05, 0xc9b27a, 0, -0.06, -0.5, g);
        if (row.sub === 'pads') {
          for (c = 0; c < COLS; c++) {
            if (!row.pads[c]) continue;
            K.mesh(G.pad, K.lam(0x3fb36e), c - 4, -0.1, 0, g);
            if (CA.hash(i * 17 + c) % 4 === 0) K.rb(0.16, 0.12, 0.16, 0.05, 0xff9ec7, c - 4 + 0.14, -0.02, 0.1, g);
          }
        } else {
          row.meshes = [];
          for (k = 0; k < row.n; k++) { var lg = buildLog(row.len); lg.position.y = -0.05; g.add(lg); row.meshes.push(lg); }
        }
      } else {
        K.rb(30, 0.3, 1, 0.02, 0x45406a, 0, -0.15, 0, g);
        if (!prev || prev.t !== 'r') K.rb(30, 0.12, 0.16, 0.04, 0xd8d3f0, 0, 0.04, 0.5, g);
        if (next.t !== 'r') K.rb(30, 0.12, 0.16, 0.04, 0xd8d3f0, 0, 0.04, -0.5, g);
        else { var dm = K.mesh(dashGeo, dashMat, 0, 0.011, -0.5, g); dm.rotation.x = -Math.PI / 2; }
        row.meshes = [];
        for (k = 0; k < row.n; k++) { var car = buildCar(row, i + k); g.add(car); row.meshes.push(car); }
      }
      g.position.z = -i;
      scene.add(g);
      row.g = g;
    }

    /* ---------------------------------------------------------------- the chicken */
    var hero = new THREE.Group(), body = new THREE.Group();
    K.rb(0.66, 0.6, 0.66, 0.14, 0xfffaf0, 0, 0.5, 0, body);
    K.rb(0.5, 0.36, 0.42, 0.1, 0xfffaf0, 0, 0.92, -0.08, body);
    K.rb(0.14, 0.18, 0.3, 0.05, 0xff4b6e, 0, 1.17, -0.06, body);
    K.rb(0.16, 0.12, 0.18, 0.04, 0xffab1f, 0, 0.88, -0.38, body);
    K.rb(0.1, 0.12, 0.08, 0.03, 0xff4b6e, 0, 0.74, -0.33, body);
    [-0.2, 0.2].forEach(function (x) { K.rb(0.08, 0.1, 0.06, 0.02, 0x14102e, x, 0.98, -0.3, body); });
    [-0.36, 0.36].forEach(function (x) { K.rb(0.08, 0.3, 0.4, 0.04, 0xeee6d2, x, 0.5, 0.04, body); });
    K.rb(0.36, 0.22, 0.14, 0.05, 0xeee6d2, 0, 0.66, 0.36, body);
    [-0.14, 0.14].forEach(function (x) { K.rb(0.07, 0.2, 0.07, 0.02, 0xffab1f, x, 0.1, 0, body); });
    hero.add(body);
    scene.add(hero);
    var shadow = K.mesh(K.geo('hopShadow', function () { return new THREE.PlaneGeometry(0.9, 0.9); }), own(K.blobMaterial(0.35)), 0, 0.02, 0, scene);
    shadow.rotation.x = -Math.PI / 2;
    var splashMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false }));
    var splash = K.mesh(own(new THREE.RingGeometry(0.2, 0.34, 24)), splashMat, 0, 0, 0, scene);
    splash.rotation.x = -Math.PI / 2; splash.visible = false;

    /* ---------------------------------------------------------------- state */
    var gx = 0, rx = 0, pr = 0, rrw = 0, mr = 0, cam = 0, camT = 0, yaw = 0, yawT = 0, hopT = 0, standY = 0;
    var splashT = 0, autoCam = -2.5, moved = false, over = false, drown = false, flash = 0;
    var t0 = 0, raf = 0, last = 0;
    function tNow() { return (performance.now() - t0) / 1000; }

    function endSoon() { setTimeout(function () { if (api.alive()) api.end(mr); }, flash > 0 ? 800 : 450); }
    function die(kind) {
      over = true; flash = 0.9;
      if (kind === 'water') { drown = true; splashT = 0; splash.visible = true; splash.position.set(gx, -0.1, -pr); api.sfx('miss'); }
      else api.sfx('crash');
      api.buzz(120);
      endSoon();
    }

    function hop(dc, dr) {
      if (over || !api.running()) return;
      var nr = pr + dr, nx = gx + dc, c;
      yawT = dr > 0 ? 0 : dr < 0 ? Math.PI : dc > 0 ? -Math.PI / 2 : Math.PI / 2;
      if (nr < 0 || nr < Math.floor(cam)) return;
      if (dc !== 0 && (nx < -4.6 || nx > 4.6)) return;
      var row = getRow(nr), dead = false;
      c = CA.clamp(Math.round(nx) + 4, 0, COLS - 1);
      if (row.t === 'g') { if (row.tr[c]) return; nx = c - 4; }
      else if (row.t === 'r') nx = c - 4;
      else if (row.sub === 'pads') { if (!row.pads[Math.round(nx) + 4]) dead = true; else nx = c - 4; }
      else {
        var on = movers(row, tNow()).some(function (lx) { return Math.abs(lx - nx) < row.len / 2 + 0.1; });
        if (!on) dead = true;
      }
      gx = nx; pr = nr; hopT = HOP_T; moved = true;
      api.sfx('tap');
      if (dead) return die('water');
      if (pr > mr) {
        mr = pr;
        api.score(mr);
        if (mr % 25 === 0) api.pop(mr + ' ROWS!', '#ffe38a');
        if (mr >= CAP) { over = true; flash = 0; endSoon(); }
      }
    }

    /* input: tap to hop forward, swipe to steer, keys */
    var sx = 0, sy = 0;
    function down(e) { e.preventDefault(); sx = e.clientX; sy = e.clientY; }
    function up(e) {
      e.preventDefault();
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) < 24 && Math.abs(dy) < 24) hop(0, 1);
      else if (Math.abs(dx) > Math.abs(dy)) hop(dx > 0 ? 1 : -1, 0);
      else hop(0, dy < 0 ? 1 : -1);
    }
    function onKey(e) {
      var k = e.key, used = true;
      if (k === 'ArrowUp' || k === 'w' || k === 'W' || k === ' ') hop(0, 1);
      else if (k === 'ArrowDown' || k === 's' || k === 'S') hop(0, -1);
      else if (k === 'ArrowLeft' || k === 'a' || k === 'A') hop(-1, 0);
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') hop(1, 0);
      else used = false;
      if (used) e.preventDefault();
    }

    /* ---------------------------------------------------------------- frame */
    function edgeMeter() {
      var left = CA.clamp((pr - cam - EDGE) / 2.65, 0, 1);
      var col = left < 0.3 ? '#ff4f6d' : left < 0.6 ? '#ffc93c' : '#3ee6a0';
      api.aux('<span class="muted small">edge</span><span style="display:inline-block;width:56px;height:8px;border-radius:4px;background:#0c0824;overflow:hidden">' +
        '<i style="display:block;height:100%;width:' + Math.round(left * 100) + '%;background:' + col + '"></i></span>');
    }

    function update(dt, t) {
      var f = Math.min(1, dt * 28);
      rx += (gx - rx) * f; rrw += (pr - rrw) * f;
      if (pr - 3 > camT) camT = pr - 3;
      if (moved && !over) { autoCam += (0.5 + Math.min(mr, 80) * 0.011) * dt; if (autoCam > camT) camT = autoCam; }
      cam += (camT - cam) * Math.min(1, dt * 11);
      var dyaw = ((yawT - yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      yaw += dyaw * Math.min(1, dt * 30);
      if (hopT > 0) hopT -= dt;

      var cur = getRow(pr);
      if (!over) {
        if (cur.t === 'r') {
          if (movers(cur, t).some(function (x) { return Math.abs(x - gx) < cur.len / 2 + 0.42; })) die('car');
        } else if (cur.t === 'w' && cur.sub === 'logs') {
          var on = movers(cur, t).some(function (x) { return Math.abs(x - gx) < cur.len / 2 + 0.1; });
          if (on) { gx += cur.dir * cur.speed * dt; if (Math.abs(gx) > 5.3) die('water'); }
          else die('water');
        }
        if (!over && moved && pr - cam < EDGE) die('edge');
        edgeMeter();
      } else if (flash > 0) flash -= dt;
      return cur;
    }

    function place(cur, t) {
      var lo = Math.max(0, Math.floor(cam) - 4), hi = Math.floor(cam) + 20, i;
      for (i = lo; i <= hi; i++) if (!getRow(i).g) buildRow(i);
      for (i = Math.max(0, lo - 6); i < lo; i++) { var old = cache[i]; if (old && old.g) { scene.remove(old.g); old.g = null; } }
      for (i = lo; i <= hi; i++) {
        var rw = cache[i];
        if (rw && rw.g && rw.meshes) {
          var xs = movers(rw, t);
          rw.meshes.forEach(function (m, j) { m.position.x = xs[j]; if (rw.t === 'w') m.position.y = -0.05 + Math.sin(t * 2 + j + i) * 0.025; });
        }
      }
      var prog = hopT > 0 ? 1 - hopT / HOP_T : 0, lift = hopT > 0 ? Math.sin(prog * Math.PI) * 0.6 : 0;
      var standT = cur.t === 'w' && cur.sub === 'logs' ? 0.22 : 0;
      standY += (standT - standY) * 0.35;
      hero.position.set(rx, standY + lift, -rrw);
      hero.rotation.y = yaw;
      var st = 1 + Math.sin(prog * Math.PI) * 0.16, sq = Math.max(0.86, 2 - st);
      body.scale.set(sq, st, sq);
      if (over && flash > 0 && !drown) body.scale.set(1.3, 0.2, 1.3);
      if (drown) {
        hero.position.y = standY - Math.max(0, 1 - flash / 0.9) * 0.9;
        splashT += 0.016;
        var ss = 1 + splashT * 5; splash.scale.set(ss, ss, ss);
        splashMat.opacity = Math.max(0, 0.85 - splashT * 1.2);
      }
      shadow.visible = cur.t !== 'w';
      shadow.position.set(rx, 0.02, -rrw);
      var sc = 1 - lift * 0.4; shadow.scale.set(sc, sc, sc);

      var camZ = -(cam + 4), camX = rx * 0.3;
      camera.position.set(camX, 10, camZ + 10.5);
      camera.lookAt(camX, 0, camZ - 3);
    }

    function frame(now) {
      if (!api.alive()) return;
      var dt = Math.min(0.033, (now - last) / 1000), t = (now - t0) / 1000; last = now;
      var cur = update(dt, t);
      place(cur, t);
      ren.render(scene, camera);
      raf = requestAnimationFrame(frame);
    }

    api.score(0);
    edgeMeter();
    place(getRow(0), 0);
    ren.render(scene, camera);

    return {
      start: function () {
        t0 = last = performance.now();
        api.box.addEventListener('pointerdown', down);
        api.box.addEventListener('pointerup', up);
        window.addEventListener('keydown', onKey);
        raf = requestAnimationFrame(frame);
      },
      stop: function () {
        cancelAnimationFrame(raf);
        api.box.removeEventListener('pointerdown', down);
        api.box.removeEventListener('pointerup', up);
        window.removeEventListener('keydown', onKey);
        owned.forEach(function (o) { try { o.dispose(); } catch (e) { /* ok */ } });
        K.dispose(ren);
      },
    };
  };
})();
