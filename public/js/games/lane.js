/*
 * Lane Dash (three.js)
 * A three-lane neon highway at night. Rows of obstacles come at you, always with at least
 * one open lane; the speed climbs and the gaps between rows grow so reaction time stays
 * fair. Score is metres. Steer with the buttons, by tapping a side, swiping or arrow keys.
 */
(function () {
  'use strict';
  var CA = window.CA, K;

  CA.games.lane = function (api) {
    K = CA.three;
    var W = 360, H = 520;
    var SC = 0.4;                /* world units per metre */
    var LANE = 2.4, FINISH = Infinity; /* endless: the run only ends when you crash */
    var HIT_X = 1.13, NEAR_X = 1.79, HIT_Z = 4.8;
    function spdAt(m) { return Math.min(95, 42 + m * 0.045); } /* metres per second */

    api.fit(W / H);
    var ren = K.renderer(api.canvas, W, H);
    var scene = new THREE.Scene();
    var owned = [];
    function own(x) { owned.push(x); return x; }

    /* ---------------------------------------------------------------- sky, sun, stars */
    var sky = own(K.gradientTexture([[0, '#0b0628'], [0.32, '#2a0f5e'], [0.5, '#8a2d82'], [0.58, '#ff7a59'], [0.6, '#2a0f5e'], [1, '#160a3a']], 256, 512, function (x, w, h) {
      for (var i = 0; i < 90; i++) {
        x.fillStyle = 'rgba(255,255,255,' + (0.25 + (CA.hash(i) % 60) / 100) + ')';
        x.fillRect(CA.hash(i * 3) % w, CA.hash(i * 5) % Math.floor(h * 0.45), 1.5, 1.5);
      }
      var cx = w / 2, cy = h * 0.5, rad = 56;
      var g = x.createLinearGradient(0, cy - rad, 0, cy + rad);
      g.addColorStop(0, '#ffe38a'); g.addColorStop(0.6, '#ff5d8f'); g.addColorStop(1, '#b8329c');
      x.save(); x.beginPath(); x.arc(cx, cy, rad, 0, Math.PI * 2); x.clip();
      x.fillStyle = g; x.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      x.fillStyle = '#2a0f5e';
      for (var s = 0; s < 6; s++) x.fillRect(cx - rad, cy + 6 + s * 9, rad * 2, 2 + s * 0.8);
      x.restore();
    }));
    scene.background = sky;
    scene.fog = new THREE.Fog(0x2a0f5e, 22, 58);
    scene.add(new THREE.HemisphereLight(0xb9a8ff, 0x2a0f5e, 0.85));
    var key = new THREE.DirectionalLight(0xffd0e0, 0.55);
    key.position.set(-3, 8, 6);
    scene.add(key);

    var cam = new THREE.PerspectiveCamera(54, W / H, 0.1, 90);

    /* ---------------------------------------------------------------- ground */
    var gridTex = (function () {
      var c = document.createElement('canvas'); c.width = c.height = 64;
      var x = c.getContext('2d');
      x.fillStyle = '#150a36'; x.fillRect(0, 0, 64, 64);
      x.strokeStyle = 'rgba(255,93,143,0.55)'; x.lineWidth = 2;
      x.strokeRect(0, 0, 64, 64);
      var t = new THREE.CanvasTexture(c);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(40, 40);
      return own(t);
    })();
    var ground = K.mesh(new THREE.PlaneGeometry(160, 160), own(new THREE.MeshBasicMaterial({ map: gridTex })), 0, -0.05, -50, scene);
    ground.rotation.x = -Math.PI / 2;

    var road = K.mesh(new THREE.PlaneGeometry(8.2, 140), K.lam(0x221a4a), 0, 0, -50, scene);
    road.rotation.x = -Math.PI / 2;
    [-1, 1].forEach(function (s) {
      var edge = K.mesh(new THREE.BoxGeometry(0.14, 0.06, 140), K.basic(0xff5d8f), s * 4.1, 0.03, -50, scene);
      edge.userData.glow = true;
      K.mesh(new THREE.BoxGeometry(0.5, 0.25, 140), K.lam(0x3a2d78), s * 4.5, 0.12, -50, scene);
    });

    /* far mountains: a ring of low-poly cones */
    for (var mi = 0; mi < 14; mi++) {
      var mh = 4 + (CA.hash(mi * 13) % 7), mx = -60 + mi * 9.5 + (CA.hash(mi) % 5);
      var cone = K.mesh(K.geo('mtn' + mh, function () { return new THREE.ConeGeometry(6, mh, 4); }), K.lam(0x3d1a6e), mx, mh / 2 - 0.2, -64, scene);
      cone.rotation.y = Math.PI / 4;
    }

    /* scrolling bits: lane dashes, roadside posts */
    var dashes = [], posts = [], i;
    var dashGeo = new THREE.BoxGeometry(0.12, 0.02, 1.4), postGeo = new THREE.BoxGeometry(0.16, 1.6, 0.16);
    for (i = 0; i < 24; i++) {
      [-LANE / 2, LANE / 2].forEach(function (x) { dashes.push({ m: K.mesh(dashGeo, K.basic(0x5ad8ff), x, 0.02, 0, scene), i: i }); });
    }
    for (i = 0; i < 12; i++) {
      [-1, 1].forEach(function (s) {
        var g = new THREE.Group();
        K.mesh(postGeo, K.lam(0x4a3b8c), 0, 0.8, 0, g);
        K.mesh(K.geo('lampHead', function () { return new THREE.BoxGeometry(0.34, 0.14, 0.34); }), K.basic(i % 2 ? 0x5ad8ff : 0xff5d8f), 0, 1.66, 0, g);
        g.position.x = s * 5.2;
        scene.add(g);
        posts.push({ g: g, i: i });
      });
    }

    /* distance gantries every 200 m */
    function signTexture(text, finish) {
      var c = document.createElement('canvas'); c.width = 256; c.height = 64;
      var x = c.getContext('2d');
      if (finish) {
        for (var a = 0; a < 16; a++) for (var b = 0; b < 4; b++) { x.fillStyle = (a + b) % 2 ? '#14092e' : '#ffffff'; x.fillRect(a * 16, b * 16, 16, 16); }
        x.fillStyle = 'rgba(20,9,46,.85)'; x.fillRect(48, 10, 160, 44);
      } else { x.fillStyle = '#14092e'; x.fillRect(0, 0, 256, 64); x.strokeStyle = '#ffc93c'; x.lineWidth = 6; x.strokeRect(3, 3, 250, 58); }
      x.fillStyle = '#ffc93c'; x.font = "38px 'Lilita One', Impact, sans-serif"; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(text, 128, 34);
      var tex = own(new THREE.CanvasTexture(c));
      tex.redrawSign = function (txt) {
        x.fillStyle = '#14092e'; x.fillRect(0, 0, 256, 64); x.strokeStyle = '#ffc93c'; x.lineWidth = 6; x.strokeRect(3, 3, 250, 58);
        x.fillStyle = '#ffc93c'; x.fillText(txt, 128, 34);
        tex.needsUpdate = true;
      };
      return tex;
    }
    var gantries = [];
    for (i = 1; i <= 9; i++) {
      var gg = new THREE.Group(), fin = false;
      [-1, 1].forEach(function (s) { K.rb(0.3, 6, 0.3, 0.1, 0x4a3b8c, s * 4.6, 3, 0, gg); });
      K.rb(9.6, 1.9, 0.36, 0.14, 0x2a1f60, 0, 5.3, 0, gg);
      var stex = signTexture(i * 200 + ' m', fin);
      var sign = K.mesh(new THREE.PlaneGeometry(6.4, 1.6), own(new THREE.MeshBasicMaterial({ map: stex })), 0, 5.3, 0.2, gg);
      scene.add(gg);
      gantries.push({ g: gg, m: i * 200, tex: stex });
    }

    /* speed streaks */
    var streakMat = own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.32 }));
    var streaks = [];
    for (i = 0; i < 30; i++) {
      var sm = K.mesh(K.geo('streak', function () { return new THREE.BoxGeometry(0.03, 0.03, 3); }), streakMat,
        (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 5), 0.3 + Math.random() * 3.6, -Math.random() * 50, scene);
      streaks.push(sm);
    }

    /* ---------------------------------------------------------------- the car */
    var car = new THREE.Group(), paint = own(new THREE.MeshLambertMaterial({ color: 0x3ee6a0 })), trim = own(new THREE.MeshLambertMaterial({ color: 0x1fa877 }));
    K.mesh(K.rbox(1.36, 0.46, 2.6, 0.2), paint, 0, 0.5, 0, car);
    K.mesh(K.rbox(1.0, 0.36, 1.25, 0.16), K.lam(0x101a3a), 0, 0.9, 0.18, car);
    K.mesh(K.rbox(0.94, 0.08, 0.95, 0.04), trim, 0, 1.1, 0.2, car);
    K.mesh(K.rbox(1.42, 0.08, 0.36, 0.04), trim, 0, 1.08, 1.18, car);
    [-0.5, 0.5].forEach(function (x) { K.mesh(K.geo('spoilerLeg', function () { return new THREE.BoxGeometry(0.06, 0.3, 0.06); }), K.lam(0x1a1240), x, 0.9, 1.18, car); });
    K.mesh(K.geo('stripe', function () { return new THREE.BoxGeometry(0.22, 0.02, 2.3); }), K.basic(0xffffff), 0, 0.74, 0, car);
    [-0.44, 0.44].forEach(function (x) {
      K.mesh(K.rbox(0.34, 0.12, 0.08, 0.04), K.basic(0xff3355), x, 0.58, 1.3, car);
      K.mesh(K.rbox(0.3, 0.12, 0.08, 0.04), K.basic(0xfff3b0), x, 0.56, -1.3, car);
    });
    var wheelGeo = K.geo('wheel', function () { var g = new THREE.CylinderGeometry(0.32, 0.32, 0.26, 20); g.rotateZ(Math.PI / 2); return g; });
    var carWheels = [];
    [[-0.68, -0.82], [0.68, -0.82], [-0.68, 0.82], [0.68, 0.82]].forEach(function (p) { carWheels.push(K.mesh(wheelGeo, K.lam(0x0b0718), p[0], 0.32, p[1], car)); });
    var under = K.mesh(new THREE.PlaneGeometry(2, 3.2), own(new THREE.MeshBasicMaterial({ color: 0x3ee6a0, transparent: true, opacity: 0.35, depthWrite: false })), 0, 0.03, 0, car);
    under.rotation.x = -Math.PI / 2;
    var beam = K.mesh(new THREE.PlaneGeometry(2.6, 7), own(new THREE.MeshBasicMaterial({ color: 0xfff3b0, transparent: true, opacity: 0.12, depthWrite: false })), 0, 0.04, -4.8, car);
    beam.rotation.x = -Math.PI / 2;
    scene.add(car);

    /* ---------------------------------------------------------------- obstacles */
    function barrier() {
      var g = new THREE.Group();
      for (var n = 0; n < 5; n++) K.rb(0.4, 0.34, 0.22, 0.08, n % 2 ? 0xf4eefc : 0xff4f6d, (n - 2) * 0.4, 0.85, 0, g);
      [-0.8, 0.8].forEach(function (x) { K.rb(0.16, 1.0, 0.5, 0.06, 0x6b5fa8, x, 0.5, 0, g); });
      K.rb(0.24, 0.24, 0.1, 0.08, 0xffc93c, 0, 1.25, 0.1, g).material = K.basic(0xffc93c);
      return g;
    }
    function cones() {
      var g = new THREE.Group();
      var cg = K.geo('cone', function () { return new THREE.ConeGeometry(0.28, 0.78, 16); });
      var bg = K.geo('coneBand', function () { return new THREE.CylinderGeometry(0.19, 0.22, 0.12, 16); });
      [[-0.55, 0.3], [0.55, 0.15], [0, -0.45]].forEach(function (p) {
        K.rb(0.62, 0.07, 0.62, 0.03, 0x241a40, p[0], 0.035, p[1], g);
        K.mesh(cg, K.lam(0xff8a2b), p[0], 0.45, p[1], g);
        K.mesh(bg, K.lam(0xffffff), p[0], 0.46, p[1], g);
      });
      return g;
    }
    function barrels() {
      var g = new THREE.Group();
      var dg = K.geo('drum', function () { return new THREE.CylinderGeometry(0.44, 0.44, 1.1, 18); });
      var rg = K.geo('drumRing', function () { return new THREE.CylinderGeometry(0.46, 0.46, 0.1, 18); });
      [[-0.5, 0.1], [0.5, -0.1]].forEach(function (p) {
        K.mesh(dg, K.lam(0x3f6fe0), p[0], 0.55, p[1], g);
        K.mesh(rg, K.lam(0xd8e2ff), p[0], 0.32, p[1], g);
        K.mesh(rg, K.lam(0xd8e2ff), p[0], 0.82, p[1], g);
      });
      return g;
    }
    var TRAFFIC = [0xffc93c, 0xff5d8f, 0xc4a3ff, 0x5ad8ff, 0xff8a2b];
    function traffic(n) {
      var g = new THREE.Group();
      K.rb(1.4, 0.5, 2.5, 0.2, TRAFFIC[n % TRAFFIC.length], 0, 0.52, 0, g);
      K.rb(1.06, 0.4, 1.3, 0.16, 0x101a3a, 0, 0.94, 0.1, g);
      [-0.44, 0.44].forEach(function (x) { K.rb(0.32, 0.12, 0.08, 0.04, 0xff3355, x, 0.58, -1.26, g).material = K.basic(0xff3355); });
      [[-0.7, -0.8], [0.7, -0.8], [-0.7, 0.8], [0.7, 0.8]].forEach(function (p) { K.mesh(wheelGeo, K.lam(0x0b0718), p[0], 0.32, p[1], g); });
      g.rotation.y = Math.PI; /* parked facing away from us: tail lights toward the player */
      return g;
    }
    var makers = [barrier, cones, barrels, traffic];

    /* ---------------------------------------------------------------- state */
    var r = api.rng;
    var lane = 1, cx = 0, d = 0, rows = [], nextM = 52, openL = 1;
    var tAcc = 0;
    function boostNow(s) { return Math.max(0, Math.min(1, (s - 42) / 53)); }
    var over = false, finished = false, flash = 0, spin = 0, shake = 0, raf = 0, last = 0;
    function laneX(l) { return (l - 1) * LANE; }

    function genRows(upTo) {
      while (nextM < upTo) {
        openL = Math.max(0, Math.min(2, openL + Math.floor(r() * 3) - 1));
        var others = [0, 1, 2].filter(function (l) { return l !== openL; });
        var blocked = r() < 0.5 ? others : [others[Math.floor(r() * others.length)]];
        var kind = Math.floor(r() * 4);
        var row = { m: nextM, b: blocked, passed: false, g: new THREE.Group() };
        blocked.forEach(function (l, j) {
          var o = makers[kind](rows.length + j);
          o.position.x = laneX(l);
          row.g.add(o);
        });
        scene.add(row.g);
        rows.push(row);
        nextM += spdAt(nextM) * 0.4 + 7; /* gaps grow with speed so reaction time stays fair */
      }
    }

    function move(dir) {
      if (over || !api.running()) return;
      var nl = Math.max(0, Math.min(2, lane + dir));
      if (nl !== lane) { lane = nl; shake = 0.3; api.sfx('tap'); }
    }

    /* input: buttons, tap a side, swipe, keys */
    var steer = api.controls('<div class="steer"><button type="button" aria-label="Left">◀</button><button type="button" aria-label="Right">▶</button></div>');
    var bL = steer.children[0], bR = steer.children[1];
    function left(e) { e.preventDefault(); move(-1); }
    function right(e) { e.preventDefault(); move(1); }
    var sx = 0, swiped = false;
    function boxDown(e) { e.preventDefault(); sx = e.clientX; swiped = false; }
    function boxMove(e) {
      if (swiped || !(e.buttons || e.pointerType === 'touch')) return;
      if (Math.abs(e.clientX - sx) > 28) { swiped = true; move(e.clientX > sx ? 1 : -1); }
    }
    function boxUp(e) {
      if (swiped) return;
      var rc = api.box.getBoundingClientRect();
      move(e.clientX < rc.left + rc.width / 2 ? -1 : 1);
    }
    function onKey(e) {
      if (e.repeat) return;
      var k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { e.preventDefault(); move(-1); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { e.preventDefault(); move(1); }
    }

    function crash() {
      over = true; flash = 0.8; shake = 1;
      api.sfx('crash'); api.buzz(150);
      paint.color.setHex(0xff4f6d); trim.color.setHex(0xb8324a);
      setTimeout(function () { if (api.alive()) api.end(Math.floor(d)); }, 900);
    }

    /* ---------------------------------------------------------------- frame */
    function update(dt) {
      var spd = spdAt(d);
      if (!over) {
        d += spd * dt;
        var tx = laneX(lane), step = 44 * dt;
        cx += Math.max(-step, Math.min(step, tx - cx));
        genRows(d + 140);
        while (rows.length && rows[0].m < d - 25) scene.remove(rows.shift().g);
        for (var k = 0; k < rows.length && !over; k++) {
          var row = rows[k];
          if (Math.abs(row.m - d) < HIT_Z) {
            for (var j = 0; j < row.b.length; j++) if (Math.abs(cx - laneX(row.b[j])) < HIT_X) { crash(); break; }
          }
          if (!row.passed && row.m <= d && !over) {
            row.passed = true;
            var near = 99;
            row.b.forEach(function (l) { near = Math.min(near, Math.abs(cx - laneX(l))); });
            if (near < NEAR_X) { api.pop('CLOSE CALL!', '#5ad8ff'); api.sfx('coin'); }
          }
        }
        if (d >= FINISH) {
          d = FINISH; over = true; finished = true;
          api.pop('FINISH!', '#ffe38a'); api.sfx('win');
          setTimeout(function () { if (api.alive()) api.end(FINISH); }, 700);
        }
        api.score(Math.floor(d));
        api.aux('<span class="muted small">km/h</span> ' + Math.round(spd * 3.6));
      } else if (flash > 0) { flash -= dt; spin += dt * 9; }
      return spd;
    }

    function place(spd, dt) {
      var dz = d * SC;
      rows.forEach(function (row) { row.g.position.z = -(row.m - d) * SC; });
      var f1 = (dz % 2.4);
      dashes.forEach(function (o) { o.m.position.z = 4 - o.i * 2.4 + f1; });
      var f2 = dz % 4.8;
      posts.forEach(function (o) { o.g.position.z = 4 - o.i * 4.8 + f2; });
      gridTex.offset.y = (dz / 4) % 1;
      gantries.forEach(function (o) {
        if (d - o.m > 20) { o.m += 1800; o.tex.redrawSign(o.m + ' m'); } /* endless road: gantries are reused ahead of you */
        var rel = (o.m - d) * SC;
        o.g.visible = rel > -6 && rel < 60;
        if (o.g.visible) o.g.position.z = -rel;
      });

      var boost = (spd - 42) / 53; /* 0 at the start, 1 flat out */
      streaks.forEach(function (s) {
        s.scale.z = 0.6 + boost * 2.4;
        s.position.z += spd * SC * 1.6 * dt;
        if (s.position.z > 8) { s.position.z = -50; s.position.x = (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 5); }
      });

      tAcc += dt;
      carWheels.forEach(function (w) { w.rotation.x -= spd * SC * dt * 3.2; });
      car.position.x = cx;
      car.position.y = over ? 0 : Math.abs(Math.sin(tAcc * 18)) * 0.025 * (0.4 + boostNow(spd)); /* engine rumble */
      car.rotation.set(over ? 0 : -0.02 - boostNow(spd) * 0.03, -(laneX(lane) - cx) * 0.08, -(laneX(lane) - cx) * 0.06);
      if (over && !finished && flash > 0) { car.rotation.y = spin; car.position.y = Math.abs(Math.sin(spin)) * 0.4; }

      shake = Math.max(0, shake - dt * 2.2);
      var sh = 0.015 + boost * 0.03 + shake * 0.08;
      cam.fov = 54 + boost * 16 + shake * 3;
      cam.updateProjectionMatrix();
      cam.position.set(cx * 0.55 + (Math.random() - 0.5) * sh, 4.4 + (Math.random() - 0.5) * sh, 7.2 - boost * 0.9);
      cam.lookAt(cx * 0.55, 0.4, -7);
      cam.rotateZ((laneX(lane) - cx) * 0.012); /* lean the camera into lane changes */
    }

    function frame(now) {
      if (!api.alive()) return;
      var dt = Math.min(0.033, (now - last) / 1000); last = now;
      var spd = update(dt);
      place(spd, dt);
      ren.render(scene, cam);
      raf = requestAnimationFrame(frame);
    }

    genRows(140);
    api.score(0);
    api.aux('<span class="muted small">km/h</span> 0');
    place(spdAt(0), 0);
    ren.render(scene, cam);

    return {
      start: function () {
        last = performance.now();
        bL.addEventListener('pointerdown', left); bR.addEventListener('pointerdown', right);
        api.box.addEventListener('pointerdown', boxDown); api.box.addEventListener('pointermove', boxMove); api.box.addEventListener('pointerup', boxUp);
        window.addEventListener('keydown', onKey);
        raf = requestAnimationFrame(frame);
      },
      stop: function () {
        cancelAnimationFrame(raf);
        bL.removeEventListener('pointerdown', left); bR.removeEventListener('pointerdown', right);
        api.box.removeEventListener('pointerdown', boxDown); api.box.removeEventListener('pointermove', boxMove); api.box.removeEventListener('pointerup', boxUp);
        window.removeEventListener('keydown', onKey);
        owned.forEach(function (o) { try { o.dispose(); } catch (e) { /* ok */ } });
        K.dispose(ren);
      },
    };
  };
})();
