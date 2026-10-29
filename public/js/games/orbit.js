/*
 * Orbit Tap (canvas 2D)
 * Three bars of different sizes ride a ring. Tap when one crosses the gate at the top.
 * Smaller bars score more; a dead-centre tap adds a Perfect bonus. After every tap the bars
 * jump to new random spots and the spin reverses. An extra-life bar appears every 5-10 hits.
 * A miss costs a life; 6 seconds without a hit ends the run.
 */
(function () {
  'use strict';
  var CA = window.CA;

  CA.games.orbit = function (api) {
    var W = 360, H = 360, CX = 180, CY = 184, R = 122;
    var CAP = 300, IDLE = 6000, LIFE_MS = 7000, MAX_LIVES = 3, PERFECT = 3.5;
    var TOP = -Math.PI / 2, TWO = Math.PI * 2;

    var cv = api.canvas, ctx = cv.getContext('2d');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    api.fit(1);

    var r = api.rng;
    var a0 = TOP + 1.2 + r() * 3.8;
    var bars = [
      { a: a0,        m: 1.35, base: 12, pts: 3, color: '#ffc93c', armed: true },
      { a: a0 + 2.15, m: 1.0,  base: 20, pts: 2, color: '#c4a3ff', armed: true },
      { a: a0 + 4.1,  m: 0.7,  base: 30, pts: 1, color: '#5ad8ff', armed: true },
    ];
    var life = null, wantLife = false, nextLife = 5 + Math.floor(r() * 6);
    var dir = 1, hits = 0, points = 0, lives = 1, combo = 0;
    var over = false, raf = 0, last = 0, lastHit = 0;
    var flash = 0, missFx = 0, shake = 0, gatePulse = 0;
    var parts = [], rings = [], floats = [];

    /* static starfield, the same on every device */
    var stars = [];
    for (var i = 0; i < 60; i++) stars.push({ x: CA.hash(i * 3) % W, y: CA.hash(i * 7 + 1) % H, s: (CA.hash(i * 11) % 3) * 0.5 + 0.5 });

    /* ---------------------------------------------------------------- geometry */
    function k() { return Math.max(0.55, 1 - hits * 0.012); }
    function sizeOf(b) { return b.life ? b.base : b.base * k(); }
    function speed() { return Math.min(6, 1.8 + hits * 0.06); }
    function arc(a, b) { return Math.abs((((a - b + Math.PI) % TWO) + TWO) % TWO - Math.PI); }
    function gapOf(a) { return arc(a, TOP) * R; }
    function winOf(b) { return sizeOf(b) + 4; }
    function everyone() { return life ? bars.concat([life]) : bars; }

    /* the life bar only appears where it overlaps no other bar and is clear of the gate */
    function trySpawn(now) {
      var start = r() * TWO;
      for (var i = 0; i < 72; i++) {
        var a = start + i * TWO / 72, ok = arc(a, TOP) >= 0.8;
        for (var j = 0; ok && j < bars.length; j++) {
          if (arc(a, bars[j].a) < (sizeOf(bars[j]) + 34) / R) ok = false;
        }
        if (ok) { life = { life: true, pts: 0, base: 16, a: a, m: 0.9, born: now, armed: true, color: '#3ee6a0' }; wantLife = false; return; }
      }
    }

    /* a faster bar that catches a slower one trades speeds with it */
    function collide(p, q) {
      var d = (((p.a - q.a + Math.PI) % TWO) + TWO) % TWO - Math.PI;
      var need = (sizeOf(p) + sizeOf(q)) / R, dist = Math.abs(d);
      if (dist >= need) return;
      var sg = d >= 0 ? 1 : -1;
      if (d * (p.m - q.m) * dir < 0) { var t = p.m; p.m = q.m; q.m = t; }
      var push = (need - dist) / 2;
      p.a += sg * push; q.a -= sg * push;
    }

    /* after every tap the bars jump to new spots, never overlapping and never on the gate */
    function reshuffle() {
      var list = everyone(), placed = [], start = r() * TWO;
      list.forEach(function (b, i) {
        var done = false;
        for (var tries = 0; tries < 80 && !done; tries++) {
          var a = r() * TWO, ok = arc(a, TOP) >= 0.7;
          for (var j = 0; ok && j < placed.length; j++) {
            if (arc(a, placed[j].a) < (sizeOf(b) + sizeOf(placed[j])) / R + 0.08) ok = false;
          }
          if (ok) { b.a = a; done = true; }
        }
        if (!done) b.a = start + (i + 0.5) * TWO / (list.length + 1) + 0.6;
        placed.push(b);
        b.armed = true;
      });
      dir = -dir;
    }

    /* ---------------------------------------------------------------- effects */
    function burst(color, n, power) {
      var gx = CX, gy = CY - R;
      for (var i = 0; i < n; i++) {
        var ang = Math.random() * TWO, sp = (60 + Math.random() * 180) * (power || 1);
        parts.push({ x: gx, y: gy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 40, life: 0.6 + Math.random() * 0.3, t: 0, c: color, s: 2 + Math.random() * 3 });
      }
      rings.push({ t: 0, c: color });
    }
    function floatText(txt, color) { floats.push({ txt: txt, c: color, t: 0 }); }

    function hud() {
      api.score(points);
      var h = '';
      for (var i = 0; i < MAX_LIVES; i++) h += '<i class="heart' + (i < lives ? '' : ' off') + '"></i>';
      api.aux(h);
    }

    function endSoon() {
      setTimeout(function () { if (api.alive()) api.end(points); }, flash > 0 ? 800 : 450);
    }

    /* ---------------------------------------------------------------- input */
    function tap() {
      var near = everyone().filter(function (b) { return gapOf(b.a) <= winOf(b); });
      var ready = near.filter(function (b) { return b.armed; });
      if (!ready.length) {
        if (near.length) return false; /* same pass as a bar you already hit */
        lives--; combo = 0; missFx = 0.35; shake = 0.35;
        api.sfx('miss'); api.buzz(60);
        hud();
        if (lives <= 0) { over = true; flash = 0.8; endSoon(); }
        return true;
      }
      ready.sort(function (a, b) { return b.pts - a.pts; });
      var b = ready[0];
      b.armed = false;
      gatePulse = 0.3;
      lastHit = performance.now();
      if (b.life) {
        lives = Math.min(MAX_LIVES, lives + 1);
        life = null;
        api.sfx('life'); floatText('+1 LIFE', '#3ee6a0'); burst('#3ee6a0', 18, 1);
      } else {
        var perfect = gapOf(b.a) <= PERFECT;
        var gain = b.pts + (perfect ? 1 : 0);
        points = Math.min(CAP, points + gain);
        hits++; combo++;
        burst(b.color, perfect ? 26 : 14, perfect ? 1.4 : 1);
        if (perfect) { api.sfx('perfect'); api.pop('PERFECT +' + gain, '#ffe38a'); }
        else { api.sfx('hit', combo); floatText('+' + gain, b.color); }
        if (!life && !wantLife && hits >= nextLife) { wantLife = true; nextLife = hits + 5 + Math.floor(r() * 6); }
      }
      hud();
      if (points >= CAP) { over = true; flash = 0; endSoon(); }
      return true;
    }

    function onDown(e) {
      e.preventDefault();
      if (over || !api.running()) return;
      tap();
      if (!over) reshuffle();
    }
    function onKey(e) {
      if (e.repeat) return;
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp') onDown(e);
    }

    /* ---------------------------------------------------------------- drawing */
    function drawBar(b, alpha) {
      var s = sizeOf(b), hw = Math.max(0.01, (s - 4) / R);
      var col = over && flash > 0 ? '#ff4f6d' : b.color;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.lineCap = 'round';
      ctx.strokeStyle = col;
      ctx.globalAlpha = alpha * 0.22; ctx.lineWidth = 32; /* soft glow without shadowBlur (cheap on phones) */
      ctx.beginPath(); ctx.arc(CX, CY, R, b.a - hw, b.a + hw); ctx.stroke();
      ctx.globalAlpha = alpha; ctx.lineWidth = 18;
      ctx.beginPath(); ctx.arc(CX, CY, R, b.a - hw, b.a + hw); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(CX, CY, R + 3, b.a - hw * 0.8, b.a + hw * 0.8); ctx.stroke();
      if (b.life) {
        var x = CX + R * Math.cos(b.a), y = CY + R * Math.sin(b.a);
        ctx.fillStyle = '#0b3a26';
        ctx.fillRect(x - 1.8, y - 6, 3.6, 12); ctx.fillRect(x - 6, y - 1.8, 12, 3.6);
      } else if (!b.armed) {
        ctx.strokeStyle = 'rgba(12,8,36,0.55)'; ctx.lineWidth = 18;
        ctx.beginPath(); ctx.arc(CX, CY, R, b.a - hw, b.a + hw); ctx.stroke();
      }
      ctx.restore();
    }

    function draw(now) {
      ctx.save();
      if (shake > 0) ctx.translate((Math.random() - 0.5) * 10 * shake, (Math.random() - 0.5) * 10 * shake);

      /* background */
      var bg = ctx.createRadialGradient(CX, CY, 20, CX, CY, 260);
      bg.addColorStop(0, '#2b1a72'); bg.addColorStop(1, '#0e0a2a');
      ctx.fillStyle = bg; ctx.fillRect(-10, -10, W + 20, H + 20);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      stars.forEach(function (s) { ctx.globalAlpha = 0.25 + 0.25 * Math.sin(now / 900 + s.x); ctx.fillRect(s.x, s.y, s.s, s.s); });
      ctx.globalAlpha = 1;

      /* track */
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 30;
      ctx.beginPath(); ctx.arc(CX, CY, R, 0, TWO); ctx.stroke();
      ctx.strokeStyle = missFx > 0 ? 'rgba(255,79,109,' + (0.4 + missFx) + ')' : 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(CX, CY, R - 15, 0, TWO); ctx.stroke();
      ctx.beginPath(); ctx.arc(CX, CY, R + 15, 0, TWO); ctx.stroke();
      for (var t = 0; t < 48; t++) {
        var ta = t / 48 * TWO, inr = R + 19, out = R + (t % 4 === 0 ? 27 : 23);
        ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(CX + inr * Math.cos(ta), CY + inr * Math.sin(ta)); ctx.lineTo(CX + out * Math.cos(ta), CY + out * Math.sin(ta)); ctx.stroke();
      }

      /* gate: a glowing pillar through the ring at the top */
      var gp = Math.max(0, gatePulse) / 0.3;
      var beam = ctx.createLinearGradient(0, CY - R - 40, 0, CY - R + 40);
      beam.addColorStop(0, 'rgba(62,230,160,0)'); beam.addColorStop(0.5, 'rgba(62,230,160,' + (0.18 + gp * 0.3) + ')'); beam.addColorStop(1, 'rgba(62,230,160,0)');
      ctx.fillStyle = beam; ctx.fillRect(CX - 16 - gp * 8, CY - R - 40, 32 + gp * 16, 80);
      ctx.save();
      ctx.strokeStyle = '#3ee6a0'; ctx.lineCap = 'round';
      ctx.globalAlpha = 0.25 + gp * 0.3; ctx.lineWidth = 14 + gp * 10;
      ctx.beginPath(); ctx.moveTo(CX, CY - R - 30); ctx.lineTo(CX, CY - R + 30); ctx.stroke();
      ctx.globalAlpha = 1; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(CX, CY - R - 30); ctx.lineTo(CX, CY - R + 30); ctx.stroke();
      ctx.restore();
      ctx.fillStyle = '#3ee6a0';
      ctx.beginPath(); ctx.moveTo(CX - 9, CY - R - 44); ctx.lineTo(CX + 9, CY - R - 44); ctx.lineTo(CX, CY - R - 34); ctx.closePath(); ctx.fill();

      /* bars */
      bars.forEach(function (b) { drawBar(b, 1); });
      if (life) {
        var left = LIFE_MS - (now - life.born);
        if (left > 2000 || Math.floor(now / 120) % 2 === 0) drawBar(life, 1);
      }

      /* centre: score and the idle timer */
      var idle = over ? 0 : Math.max(0, 1 - (now - lastHit) / IDLE);
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(CX, CY, 58, 0, TWO); ctx.stroke();
      ctx.strokeStyle = idle < 0.35 ? '#ff4f6d' : '#ffc93c'; ctx.lineCap = 'round';
      if (idle > 0) { ctx.beginPath(); ctx.arc(CX, CY, 58, TOP, TOP + TWO * idle); ctx.stroke(); }
      ctx.fillStyle = '#fff';
      ctx.font = "54px 'Lilita One', Impact, sans-serif"; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(points), CX, CY + 2);
      ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = "800 11px Nunito, sans-serif";
      ctx.fillText(combo > 2 ? 'COMBO ×' + combo : 'POINTS', CX, CY + 34);

      /* particles, shockwaves and floating numbers */
      rings.forEach(function (g) {
        ctx.strokeStyle = g.c; ctx.globalAlpha = Math.max(0, 1 - g.t / 0.5); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(CX, CY - R, 10 + g.t * 90, 0, TWO); ctx.stroke();
      });
      parts.forEach(function (p) {
        ctx.globalAlpha = Math.max(0, 1 - p.t / p.life); ctx.fillStyle = p.c;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.s, 0, TWO); ctx.fill();
      });
      floats.forEach(function (f) {
        ctx.globalAlpha = Math.max(0, 1 - f.t / 0.8); ctx.fillStyle = f.c;
        ctx.font = "22px 'Lilita One', Impact, sans-serif";
        ctx.fillText(f.txt, CX + 34, CY - R - 20 - f.t * 40);
      });
      ctx.globalAlpha = 1;

      if (missFx > 0) {
        var v = ctx.createRadialGradient(CX, CY, 120, CX, CY, 260);
        v.addColorStop(0, 'rgba(255,79,109,0)'); v.addColorStop(1, 'rgba(255,79,109,' + missFx + ')');
        ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
    }

    /* ---------------------------------------------------------------- loop */
    function step(now, dt) {
      if (!over) {
        var sp = speed(), all = everyone(), i, j;
        all.forEach(function (b) { b.a += dir * b.m * sp * dt; });
        for (i = 0; i < all.length; i++) for (j = i + 1; j < all.length; j++) collide(all[i], all[j]);
        all.forEach(function (b) { if (!b.armed && gapOf(b.a) > winOf(b) + 12) b.armed = true; });
        if (wantLife && !life) trySpawn(now);
        if (life && now - life.born > LIFE_MS) life = null;
        if (now - lastHit > IDLE) { over = true; flash = 0.8; api.sfx('miss'); endSoon(); }
      } else if (flash > 0) flash -= dt;
      gatePulse -= dt; missFx = Math.max(0, missFx - dt); shake = Math.max(0, shake - dt);
      parts.forEach(function (p) { p.t += dt; p.vy += 260 * dt; p.x += p.vx * dt; p.y += p.vy * dt; });
      parts = parts.filter(function (p) { return p.t < p.life; });
      rings.forEach(function (g) { g.t += dt; }); rings = rings.filter(function (g) { return g.t < 0.5; });
      floats.forEach(function (f) { f.t += dt; }); floats = floats.filter(function (f) { return f.t < 0.8; });
    }

    function frame(now) {
      if (!api.alive()) return;
      var dt = Math.min(0.033, (now - last) / 1000); last = now;
      step(now, dt);
      draw(now);
      raf = requestAnimationFrame(frame);
    }

    hud();
    lastHit = performance.now();
    draw(lastHit);

    return {
      start: function () {
        last = lastHit = performance.now();
        api.box.addEventListener('pointerdown', onDown);
        window.addEventListener('keydown', onKey);
        raf = requestAnimationFrame(frame);
      },
      stop: function () {
        cancelAnimationFrame(raf);
        api.box.removeEventListener('pointerdown', onDown);
        window.removeEventListener('keydown', onKey);
      },
    };
  };
})();
