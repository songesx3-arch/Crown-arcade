/*
 * Chaos Cannon (canvas 2D)
 * A cannon sweeps left and right. Tap to fire; ten cannonballs. Crates, gold, TNT and giant bombs
 * float above. Anything that blows up sets off its neighbours, and every step of a chain reaction is
 * worth more than the one before it. The field is seeded, so both players in a duel see the same board.
 */
(function () {
  'use strict';
  var CA = window.CA;

  CA.games.chaos = function (api) {
    var W = 360, H = 540, SHOTS = 10, BALL_V = 720, CX = 180, CY = 498, MAX_TIME = 100;
    var TYPES = {
      crate: { r: 16, pts: 10 },
      gold: { r: 13, pts: 50 },
      tnt: { r: 17, pts: 20, boom: 64 },
      mega: { r: 20, pts: 40, boom: 112 },
    };

    var cv = api.canvas, ctx = cv.getContext('2d');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    api.fit(W / H);

    var r = api.rng;
    var targets = [], i;
    for (i = 0; i < 30; i++) {
      var row = Math.floor(i / 6), col = i % 6, roll = r(), type = roll < 0.66 ? 'crate' : roll < 0.80 ? 'tnt' : roll < 0.94 ? 'gold' : 'mega';
      targets.push({
        type: type, def: TYPES[type], bx: 44 + col * 54 + (row % 2) * 27 + (r() - 0.5) * 12, by: 74 + row * 56 + (r() - 0.5) * 12,
        amp: 4 + r() * 16, sp: 0.5 + r() * 0.9, ph: r() * 6.28, x: 0, y: 0, alive: true, hit: 0,
      });
    }
    var ph0 = r() * 6.28;

    var score = 0, ammo = SHOTS, used = 0, time = 0, aimT = 0, ang = 0, recoil = 0, shake = 0, chain = 0, idle = 0, lastShot = -9;
    var balls = [], blasts = [], rings = [], parts = [], floats = [], smoke = [];
    var over = false, raf = 0, last = 0, started = false;

    function place() {
      targets.forEach(function (t) {
        t.x = t.bx + Math.sin(time * t.sp + t.ph) * t.amp;
        t.y = t.by + Math.cos(time * t.sp * 0.7 + t.ph) * 5;
      });
    }
    function ammoHtml() {
      var s = '';
      for (var k = 0; k < SHOTS; k++) s += '<span style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-left:3px;background:' + (k < ammo ? '#ffc93c' : '#3a2f6b') + '"></span>';
      return s;
    }

    /* ---------------------------------------------------------------- action */
    function burst(x, y, color, n, spd) {
      for (var k = 0; k < n; k++) {
        var a = Math.random() * 6.28, v = (0.3 + Math.random()) * spd;
        parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0.5 + Math.random() * 0.5, t: 0, c: color, s: 2 + Math.random() * 3 });
      }
    }
    function kill(t, depth) {
      if (!t.alive) return;
      t.alive = false; chain++;
      var pts = Math.round(t.def.pts * (1 + 0.75 * depth));
      score += pts; api.score(score);
      floats.push({ x: t.x, y: t.y, text: '+' + pts, t: 0, c: depth > 1 ? '#ffd86b' : '#fff' });
      burst(t.x, t.y, t.type === 'gold' ? '#ffd23f' : t.type === 'crate' ? '#d49a5a' : '#ff8a3d', t.def.boom ? 16 : 9, t.def.boom ? 220 : 140);
      CA.sfx(t.type === 'gold' ? 'coin' : 'hit', Math.min(20, chain));
      if (t.def.boom) blasts.push({ x: t.x, y: t.y, R: t.def.boom, at: time + 0.11, depth: depth + 1 });
      if (chain === 5) api.pop('CHAOS!', '#ffc93c');
      else if (chain === 10) api.pop('MAYHEM!', '#ff6b8b');
      else if (chain === 16) api.pop('TOTAL CARNAGE!', '#c4a3ff');
    }
    function fire() {
      if (over || !started || ammo <= 0 || time - lastShot < 0.22) return;
      lastShot = time; ammo--; used++; recoil = 1;
      var tx = CX + Math.sin(ang) * 48, ty = CY - Math.cos(ang) * 48;
      balls.push({ x: tx, y: ty, vx: Math.sin(ang) * BALL_V, vy: -Math.cos(ang) * BALL_V });
      burst(tx, ty, '#ffe9a8', 6, 120);
      api.aux(ammoHtml());
      CA.sfx('tap'); CA.buzz(15);
    }
    function onDown(e) { e.preventDefault(); fire(); }
    function onKey(e) { if (!e.repeat && (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp')) { e.preventDefault(); fire(); } }

    function segDist(px, py, ax, ay, bx, by) {
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      var cx = ax + dx * t, cy = ay + dy * t;
      return Math.hypot(px - cx, py - cy);
    }

    function update(dt) {
      time += dt; aimT += dt;
      place();
      var spd = 1.55 + used * 0.11;
      ang = Math.sin(aimT * spd + ph0) * 1.12;
      recoil = Math.max(0, recoil - dt * 5); shake = Math.max(0, shake - dt * 2.5);

      for (var b = balls.length - 1; b >= 0; b--) {
        var ball = balls[b], nx = ball.x + ball.vx * dt, ny = ball.y + ball.vy * dt, hitT = null, hd = 1e9;
        targets.forEach(function (t) {
          if (!t.alive) return;
          var d = segDist(t.x, t.y, ball.x, ball.y, nx, ny);
          if (d < t.def.r + 5 && Math.hypot(t.x - ball.x, t.y - ball.y) < hd) { hitT = t; hd = Math.hypot(t.x - ball.x, t.y - ball.y); }
        });
        smoke.push({ x: ball.x, y: ball.y, t: 0 });
        if (hitT) { chain = 0; kill(hitT, 0); balls.splice(b, 1); shake = Math.max(shake, 0.25); continue; }
        ball.x = nx; ball.y = ny;
        if (ny < -30 || nx < -30 || nx > W + 30) balls.splice(b, 1);
      }

      for (var k = blasts.length - 1; k >= 0; k--) {
        var bl = blasts[k];
        if (time < bl.at) continue;
        blasts.splice(k, 1);
        rings.push({ x: bl.x, y: bl.y, R: bl.R, t: 0 });
        shake = Math.min(1, shake + 0.35 + bl.R / 400);
        CA.sfx('crash'); CA.buzz(25);
        targets.forEach(function (t) { if (t.alive && Math.hypot(t.x - bl.x, t.y - bl.y) < bl.R + t.def.r * 0.4) kill(t, bl.depth); });
      }
      if (!blasts.length && !balls.length) chain = 0;

      parts.forEach(function (p) { p.t += dt; p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt; });
      parts = parts.filter(function (p) { return p.t < p.life; });
      rings.forEach(function (rg) { rg.t += dt; });
      rings = rings.filter(function (rg) { return rg.t < 0.45; });
      floats.forEach(function (f) { f.t += dt; });
      floats = floats.filter(function (f) { return f.t < 0.9; });
      smoke.forEach(function (s) { s.t += dt; });
      smoke = smoke.filter(function (s) { return s.t < 0.35; });
      targets.forEach(function (t) { if (!t.alive) t.hit += dt; });

      if (ammo <= 0 && !balls.length && !blasts.length) {
        idle += dt;
        if (idle > 1.0) finish();
      }
      if (time > MAX_TIME) finish();
    }
    function finish() { if (over) return; over = true; api.end(score); }

    /* ---------------------------------------------------------------- drawing */
    function rr(x, y, w, h, rad) {
      ctx.beginPath();
      ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
    }
    function drawTarget(t) {
      var d = t.def, pulse = 1 + Math.sin(time * 6 + t.ph) * 0.05;
      ctx.save(); ctx.translate(t.x, t.y);
      if (t.type === 'crate') {
        ctx.fillStyle = '#c98a4b'; rr(-d.r, -d.r, d.r * 2, d.r * 2, 4); ctx.fill();
        ctx.strokeStyle = '#8a5a2b'; ctx.lineWidth = 2.5; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-d.r + 3, -d.r + 3); ctx.lineTo(d.r - 3, d.r - 3); ctx.moveTo(d.r - 3, -d.r + 3); ctx.lineTo(-d.r + 3, d.r - 3); ctx.stroke();
      } else if (t.type === 'tnt') {
        ctx.scale(pulse, pulse);
        ctx.fillStyle = '#e8374f'; rr(-d.r, -d.r, d.r * 2, d.r * 2, 6); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '900 11px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('TNT', 0, 1);
        ctx.strokeStyle = '#7a1424'; ctx.lineWidth = 2; rr(-d.r, -d.r, d.r * 2, d.r * 2, 6); ctx.stroke();
        ctx.fillStyle = (Math.floor(time * 8) % 2) ? '#ffd23f' : '#ff8a3d';
        ctx.beginPath(); ctx.arc(0, -d.r - 4, 3.5, 0, 6.28); ctx.fill();
      } else if (t.type === 'gold') {
        ctx.scale(pulse, pulse);
        var g = ctx.createRadialGradient(-3, -3, 2, 0, 0, d.r); g.addColorStop(0, '#fff3a8'); g.addColorStop(1, '#f2a60b');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, d.r, 0, 6.28); ctx.fill();
        ctx.strokeStyle = '#a86a00'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#a86a00'; ctx.font = '900 14px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('$', 0, 1);
      } else {
        ctx.scale(pulse, pulse);
        ctx.fillStyle = 'rgba(255,60,80,0.25)'; ctx.beginPath(); ctx.arc(0, 0, d.r + 6 + Math.sin(time * 8) * 2, 0, 6.28); ctx.fill();
        var bg = ctx.createRadialGradient(-6, -6, 2, 0, 0, d.r); bg.addColorStop(0, '#5a5470'); bg.addColorStop(1, '#16112a');
        ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(0, 0, d.r, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#ff4d6d'; ctx.font = '900 12px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('MEGA', 0, 1);
        ctx.fillStyle = (Math.floor(time * 10) % 2) ? '#ffd23f' : '#ff8a3d';
        ctx.beginPath(); ctx.arc(7, -d.r - 3, 4, 0, 6.28); ctx.fill();
      }
      ctx.restore();
    }
    function render() {
      ctx.save();
      if (shake > 0) ctx.translate((Math.random() - 0.5) * shake * 14, (Math.random() - 0.5) * shake * 14);
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#2d1b7a'); g.addColorStop(0.55, '#7a3fb8'); g.addColorStop(0.85, '#ff7a6b'); g.addColorStop(1, '#ffb36b');
      ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);
      for (var q = 0; q < 28; q++) { ctx.fillStyle = 'rgba(255,255,255,' + (0.2 + (CA.hash(q) % 50) / 100) + ')'; ctx.fillRect(CA.hash(q * 3) % W, CA.hash(q * 5) % 260, 1.6, 1.6); }
      /* hills */
      ctx.fillStyle = '#3d2a82'; ctx.beginPath(); ctx.moveTo(0, 470); ctx.quadraticCurveTo(90, 400, 200, 462); ctx.quadraticCurveTo(300, 420, W, 456); ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
      ctx.fillStyle = '#26175e'; ctx.fillRect(0, 494, W, H - 494);

      targets.forEach(function (t) { if (t.alive) drawTarget(t); });

      /* aim guide */
      if (!over && ammo > 0) {
        for (var d = 1; d <= 6; d++) {
          var len = 56 + d * 22;
          ctx.fillStyle = 'rgba(255,255,255,' + (0.7 - d * 0.1) + ')';
          ctx.beginPath(); ctx.arc(CX + Math.sin(ang) * len, CY - Math.cos(ang) * len, 3, 0, 6.28); ctx.fill();
        }
      }
      smoke.forEach(function (s) { ctx.fillStyle = 'rgba(255,255,255,' + (0.35 - s.t) + ')'; ctx.beginPath(); ctx.arc(s.x, s.y, 3 + s.t * 10, 0, 6.28); ctx.fill(); });
      balls.forEach(function (b) { ctx.fillStyle = '#17122e'; ctx.beginPath(); ctx.arc(b.x, b.y, 7, 0, 6.28); ctx.fill(); ctx.fillStyle = '#6b62a0'; ctx.beginPath(); ctx.arc(b.x - 2, b.y - 2, 2.5, 0, 6.28); ctx.fill(); });

      /* cannon */
      ctx.save(); ctx.translate(CX, CY); ctx.rotate(ang);
      var back = recoil * 9;
      ctx.fillStyle = '#2b2552'; rr(-15, -46 + back, 30, 62, 10); ctx.fill();
      ctx.fillStyle = '#4a3f8f'; rr(-17, -52 + back, 34, 16, 6); ctx.fill();
      ctx.restore();
      ctx.fillStyle = '#ffc93c'; ctx.beginPath(); ctx.arc(CX, CY, 24, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#7a4fe0'; rr(CX - 38, CY - 2, 76, 20, 8); ctx.fill();
      [-26, 26].forEach(function (dx) { ctx.fillStyle = '#17122e'; ctx.beginPath(); ctx.arc(CX + dx, CY + 14, 11, 0, 6.28); ctx.fill(); ctx.fillStyle = '#c9c1f0'; ctx.beginPath(); ctx.arc(CX + dx, CY + 14, 4, 0, 6.28); ctx.fill(); });

      rings.forEach(function (rg) {
        var k = rg.t / 0.45, R = rg.R * (0.25 + 0.85 * (1 - Math.pow(1 - k, 2)));
        var gr = ctx.createRadialGradient(rg.x, rg.y, R * 0.2, rg.x, rg.y, R);
        gr.addColorStop(0, 'rgba(255,240,170,' + (0.9 * (1 - k)) + ')'); gr.addColorStop(0.6, 'rgba(255,140,50,' + (0.6 * (1 - k)) + ')'); gr.addColorStop(1, 'rgba(255,60,40,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(rg.x, rg.y, R, 0, 6.28); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.8 * (1 - k)) + ')'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(rg.x, rg.y, R * 0.9, 0, 6.28); ctx.stroke();
      });
      parts.forEach(function (p) { ctx.globalAlpha = Math.max(0, 1 - p.t / p.life); ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, p.s, p.s); });
      ctx.globalAlpha = 1;
      floats.forEach(function (f) {
        ctx.globalAlpha = Math.max(0, 1 - f.t / 0.9); ctx.fillStyle = f.c; ctx.font = '900 16px "Nunito", Arial, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(f.text, f.x, f.y - f.t * 40);
      });
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    function frame(t) {
      if (!api.alive()) return;
      var dt = Math.min(0.033, (t - last) / 1000); last = t;
      update(dt);
      render();
      raf = requestAnimationFrame(frame);
    }

    place();
    api.score(0);
    api.aux(ammoHtml());
    render();

    return {
      start: function () {
        started = true; last = performance.now();
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
