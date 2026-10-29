/*
 * Stack (three.js)
 * A block slides back and forth over the tower. Tap to drop it: whatever hangs over the
 * edge is sliced off and falls. Miss completely and the run ends. A drop within a hair
 * of the block below snaps perfectly; four perfects in a row grow the block back a little.
 */
(function () {
  'use strict';
  var CA = window.CA, K;

  CA.games.stack = function (api) {
    K = CA.three;
    var W = 360, H = 540, BH = 0.8, START = 3, CAP = 150, LIM = 5.2, SNAP = 0.12, GROW = 0.3;

    api.fit(W / H);
    var cv = api.canvas;
    var ren = K.renderer(cv, W, H, { alpha: true });
    var scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a2a7a, 0.78));
    var sun = new THREE.DirectionalLight(0xffffff, 0.62);
    sun.position.set(6, 12, 4);
    scene.add(sun);

    var hh = 8.4, hw = hh * W / H;
    var cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 0.1, 120);
    var r = api.rng;
    var hue0 = Math.floor(r() * 360);

    function hueAt(i) { return (hue0 + i * 9) % 360; }
    function colorAt(i) { return new THREE.Color().setHSL(hueAt(i) / 360, 0.7, 0.6); }
    function paintSky(i) {
      var h = hueAt(i + 6);
      cv.style.background = 'linear-gradient(180deg, hsl(' + h + ',62%,30%) 0%, hsl(' + ((h + 40) % 360) + ',55%,14%) 100%)';
    }

    var boxGeo = new THREE.BoxGeometry(1, 1, 1); /* scaled per block */
    var owned = [];
    function block(b, level, color) {
      var mat = new THREE.MeshLambertMaterial({ color: color });
      owned.push(mat);
      var m = new THREE.Mesh(boxGeo, mat);
      m.scale.set(b.w, BH, b.d);
      m.position.set(b.x, level * BH + BH / 2, b.z);
      scene.add(m);
      return m;
    }

    /* pedestal */
    K.rb(7.2, 5, 7.2, 0.35, 0x2b2160, 0, -2.5, 0, scene);
    K.rb(7.6, 0.5, 7.6, 0.2, 0x3b2d86, 0, -0.25 - 4.6, 0, scene);

    var tower = [{ x: 0, z: 0, w: START, d: START }];
    tower[0].mesh = block(tower[0], 0, colorAt(0));
    var cur = null, debris = [], waves = [];
    var over = false, flash = 0, glow = 0, perfects = 0, camY = 0, last = 0, raf = 0;

    function newCur(dir) {
      var top = tower[tower.length - 1], n = tower.length, ax = n % 2 === 1 ? 'x' : 'z';
      cur = { x: top.x, z: top.z, w: top.w, d: top.d, axis: ax, dir: dir };
      cur[ax] = dir > 0 ? -LIM : LIM;
      cur.mesh = block(cur, n, colorAt(n));
    }
    newCur(r() < 0.5 ? 1 : -1);

    function floors() { return tower.length - 1; }

    function toDebris(x, z, w, d, level, color) {
      if (w < 0.02 || d < 0.02) return;
      var m = block({ x: x, z: z, w: w, d: d }, level, color);
      debris.push({ m: m, vy: 0, rx: (Math.random() - 0.5) * 3, rz: (Math.random() - 0.5) * 3 });
    }

    function wave(b, level) {
      var g = K.geo('stackWave', function () { var rg = new THREE.RingGeometry(0.94, 1.0, 4, 1); rg.rotateZ(Math.PI / 4); return rg; });
      var mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
      owned.push(mat);
      var m = new THREE.Mesh(g, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(b.x, level * BH + BH + 0.01, b.z);
      m.userData = { w: b.w, d: b.d };
      scene.add(m);
      waves.push({ m: m, t: 0 });
    }

    function endSoon() {
      setTimeout(function () { if (api.alive()) api.end(floors()); }, flash > 0 ? 800 : 450);
    }

    function drop() {
      if (over || !cur || !api.running()) return;
      var top = tower[tower.length - 1], n = tower.length, P = cur.axis, S = P === 'x' ? 'w' : 'd';
      var c = cur[P], t = top[P], cs = cur[S], ts = top[S];
      var lo = Math.max(c - cs / 2, t - ts / 2), hi = Math.min(c + cs / 2, t + ts / 2), ov = hi - lo;
      var color = colorAt(n);
      scene.remove(cur.mesh);

      if (ov <= 0) {
        toDebris(cur.x, cur.z, cur.w, cur.d, n, color);
        cur = null; over = true; flash = 0.8;
        api.sfx('crash'); api.buzz(120);
        return endSoon();
      }

      var nb = { x: top.x, z: top.z, w: top.w, d: top.d };
      if (Math.abs(c - t) <= SNAP) {
        perfects++;
        nb[P] = t;
        if (perfects >= 4) {
          nb[S] = Math.min(START, nb[S] + GROW); /* streak reward: grow back */
          api.pop('PERFECT ×' + perfects + ' · GROW', '#ffe38a');
        } else {
          api.pop(perfects > 1 ? 'PERFECT ×' + perfects : 'PERFECT', '#ffe38a');
        }
        glow = 0.5;
        api.sfx('perfect');
      } else {
        perfects = 0;
        nb[P] = (lo + hi) / 2; nb[S] = ov;
        var pc, ps;
        if (c < t) { ps = lo - (c - cs / 2); pc = c - cs / 2 + ps / 2; } else { ps = c + cs / 2 - hi; pc = hi + ps / 2; }
        toDebris(P === 'x' ? pc : cur.x, P === 'z' ? pc : cur.z, P === 'x' ? ps : cur.w, P === 'z' ? ps : cur.d, n, color);
        api.sfx('hit', Math.min(20, n / 3));
      }
      nb.mesh = block(nb, n, color);
      tower.push(nb);
      if (glow > 0) wave(nb, n);
      api.score(floors());
      paintSky(floors());
      if (floors() >= CAP) { cur = null; over = true; flash = 0; return endSoon(); }
      newCur(-cur.dir);
    }

    function onDown(e) { e.preventDefault(); drop(); }
    function onKey(e) {
      if (e.repeat) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); drop(); }
    }

    function render() {
      cam.position.set(10, camY + 12.5, 10);
      cam.lookAt(0, camY + 2.4, 0);
      ren.render(scene, cam);
    }

    function frame(now) {
      if (!api.alive()) return;
      var dt = Math.min(0.033, (now - last) / 1000); last = now;
      if (cur && !over) {
        var sp = Math.min(9, 3.2 + floors() * 0.13), P = cur.axis;
        cur[P] += cur.dir * sp * dt;
        if (cur[P] > LIM) { cur[P] = LIM; cur.dir = -1; }
        if (cur[P] < -LIM) { cur[P] = -LIM; cur.dir = 1; }
        cur.mesh.position.set(cur.x, tower.length * BH + BH / 2, cur.z);
      }
      if (flash > 0) flash -= dt;

      var topMesh = tower[tower.length - 1].mesh;
      if (glow > 0) { glow -= dt; var g = Math.max(0, glow * 2) * 0.55; topMesh.material.emissive.setRGB(g, g, g); }
      else topMesh.material.emissive.setRGB(0, 0, 0);

      waves.forEach(function (w) {
        w.t += dt;
        var s = 1 + w.t * 2.4;
        w.m.scale.set(w.m.userData.w * 0.72 * s, w.m.userData.d * 0.72 * s, 1);
        w.m.material.opacity = Math.max(0, 0.9 - w.t * 1.8);
      });
      waves = waves.filter(function (w) { if (w.t > 0.5) { scene.remove(w.m); return false; } return true; });

      var target = Math.max(0, (tower.length - 5) * BH);
      camY += (target - camY) * Math.min(1, dt * 5);

      for (var k = debris.length - 1; k >= 0; k--) {
        var d = debris[k];
        d.vy += 26 * dt; d.m.position.y -= d.vy * dt;
        d.m.rotation.x += d.rx * dt; d.m.rotation.z += d.rz * dt;
        if (d.m.position.y < camY - 16) { scene.remove(d.m); debris.splice(k, 1); }
      }
      render();
      raf = requestAnimationFrame(frame);
    }

    api.score(0);
    paintSky(0);
    render();

    return {
      start: function () {
        last = performance.now();
        api.box.addEventListener('pointerdown', onDown);
        window.addEventListener('keydown', onKey);
        raf = requestAnimationFrame(frame);
      },
      stop: function () {
        cancelAnimationFrame(raf);
        api.box.removeEventListener('pointerdown', onDown);
        window.removeEventListener('keydown', onKey);
        owned.forEach(function (m) { m.dispose(); });
        K.dispose(ren);
      },
    };
  };
})();
