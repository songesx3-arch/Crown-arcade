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
    var W = 360, H = 540, BH = 0.8, START = 3, LIM = 5.2, SNAP = 0.12, GROW = 0.3;

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
    var cur = null, debris = [], waves = [], lands = [], sparks = [], clouds = [], tAcc = 0;
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

    /* little burst of sparks on a perfect drop */
    var sparkGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
    var sparkMat = new THREE.MeshBasicMaterial({ color: 0xffe38a, transparent: true });
    owned.push(sparkMat);
    function sparkBurst(b, level) {
      for (var i = 0; i < 12; i++) {
        var m = new THREE.Mesh(sparkGeo, sparkMat);
        var a = Math.random() * Math.PI * 2;
        m.position.set(b.x + Math.cos(a) * b.w * 0.45, level * BH + BH, b.z + Math.sin(a) * b.d * 0.45);
        scene.add(m);
        sparks.push({ m: m, vx: Math.cos(a) * (2 + Math.random() * 2), vz: Math.sin(a) * (2 + Math.random() * 2), vy: 3 + Math.random() * 3, t: 0 });
      }
    }

    /* soft clouds drifting behind the tower (placed in screen space so they always stay in view) */
    var cloudTex = (function () {
      var c = document.createElement('canvas'); c.width = 128; c.height = 64;
      var x = c.getContext('2d');
      [[34, 38, 22], [60, 30, 28], [90, 38, 22], [64, 42, 26]].forEach(function (p) {
        var g = x.createRadialGradient(p[0], p[1], 2, p[0], p[1], p[2]);
        g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        x.fillStyle = g; x.beginPath(); x.arc(p[0], p[1], p[2], 0, Math.PI * 2); x.fill();
      });
      var t = new THREE.CanvasTexture(c); owned.push(t); return t;
    })();
    for (var ci = 0; ci < 6; ci++) {
      var cmat = new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.28 + (ci % 3) * 0.08, depthWrite: false });
      owned.push(cmat);
      var cs = new THREE.Sprite(cmat);
      var csz = 3.2 + (ci % 3) * 1.2;
      cs.scale.set(csz, csz / 2, 1);
      scene.add(cs);
      clouds.push({ s: cs, sx: -hw + (ci / 6) * hw * 2, sy: -hh + ((ci * 37) % 100) / 100 * hh * 2, v: 0.25 + (ci % 3) * 0.18, par: 0.12 + (ci % 3) * 0.08 });
    }
    var fwdV = new THREE.Vector3(), rightV = new THREE.Vector3(), upV = new THREE.Vector3();
    function animateClouds(dt) {
      cam.getWorldDirection(fwdV);
      rightV.crossVectors(fwdV, cam.up).normalize();
      upV.crossVectors(rightV, fwdV).normalize();
      clouds.forEach(function (c) {
        c.sx += c.v * dt;
        if (c.sx > hw + 3) c.sx = -hw - 3;
        var sy = ((c.sy + camY * c.par + hh) % (hh * 2) + hh * 2) % (hh * 2) - hh; /* slides down as the tower climbs */
        c.s.position.copy(cam.position).addScaledVector(fwdV, 60).addScaledVector(rightV, c.sx).addScaledVector(upV, -sy);
      });
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
      lands.push({ m: nb.mesh, lvl: n, t: 0 });
      if (glow > 0) sparkBurst(nb, n);
      if (tower.length > 40) tower[tower.length - 40].mesh.visible = false; /* endless tower: stop drawing what is far below */
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
        cur.mesh.position.set(cur.x, tower.length * BH + BH / 2 + Math.sin(tAcc * 7) * 0.05, cur.z);
        /* lean into the direction of travel */
        if (P === 'x') cur.mesh.rotation.z = -cur.dir * 0.07; else cur.mesh.rotation.x = cur.dir * 0.07;
      }
      tAcc += dt;
      /* landing squash and spring */
      for (var li = lands.length - 1; li >= 0; li--) {
        var ld = lands[li]; ld.t += dt;
        var kk = Math.max(0, 1 - ld.t * 3.2), sq = 1 - 0.38 * kk * Math.cos(ld.t * 26);
        ld.m.scale.y = BH * sq; ld.m.position.y = ld.lvl * BH + ld.m.scale.y / 2;
        if (ld.t > 0.32) { ld.m.scale.y = BH; ld.m.position.y = ld.lvl * BH + BH / 2; lands.splice(li, 1); }
      }
      for (var si = sparks.length - 1; si >= 0; si--) {
        var sp2 = sparks[si]; sp2.t += dt; sp2.vy -= 14 * dt;
        sp2.m.position.x += sp2.vx * dt; sp2.m.position.z += sp2.vz * dt; sp2.m.position.y += sp2.vy * dt;
        sp2.m.scale.setScalar(Math.max(0.01, 1 - sp2.t * 1.8));
        if (sp2.t > 0.55) { scene.remove(sp2.m); sparks.splice(si, 1); }
      }
      animateClouds(dt);
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
