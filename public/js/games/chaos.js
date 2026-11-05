/*
 * Chaos Cannon (canvas 2D)
 * Slide the cannon left and right (drag, or arrow keys / A and D) while it auto-fires at rocks falling
 * from the sky. Big rocks take several hits. Some rocks carry a glowing power-up: shoot them to drop it,
 * then catch it with the cannon. LASER pierces everything in a column, TRIPLE fires three shots at once,
 * FREEZE stops every rock for a few seconds. A rock that hits the ground or the cannon costs a life.
 * You have 3 lives and 60 seconds. The rock schedule is seeded, so both players in a duel face the same sky.
 */
(function () {
  'use strict';
  var CA = window.CA;

  CA.games.chaos = function (api) {
    var W = 360, H = 540, GROUND = 486, CY = 500, TIME = 60, LIVES = 3;
    var POWER = {
      laser: { name: 'LASER', color: '#ff4d6d', letter: 'L', dur: 5 },
      triple: { name: 'TRIPLE SHOT', color: '#ffc93c', letter: '3', dur: 8 },
      freeze: { name: 'FREEZE', color: '#5ad8ff', letter: '*', dur: 4 },
    };
    var SIZES = [null, { r: 15, hp: 1, pts: 10 }, { r: 23, hp: 2, pts: 20 }, { r: 33, hp: 4, pts: 40 }];

    var cv = api.canvas, ctx = cv.getContext('2d');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    api.fit(W / H);

    /* the whole sky is decided up front from the shared seed */
    var r = api.rng, schedule = [], t0 = 0.7, i;
    var kinds = ['laser', 'triple', 'freeze', 'triple', 'laser', 'freeze'], kn = 0;
    while (t0 < TIME) {
      var roll = r(), size = roll < 0.5 ? 1 : roll < 0.82 ? 2 : 3, power = null;
      if (size >= 2 && r() < 0.2) { power = kinds[kn++ % kinds.length]; } else if (size === 1) { r(); }
      var verts = [], nv = 9;
      for (i = 0; i < nv; i++) verts.push(0.82 + r() * 0.3);
      schedule.push({
        at: t0, x: 30 + r() * (W - 60), size: size, power: power, vx: (r() - 0.5) * 36, vy: 62 + r() * 34 - size * 5,
        rs: (r() - 0.5) * 2, verts: verts,
      });
      t0 += Math.max(0.42, 1.2 - t0 * 0.013) * (0.75 + r() * 0.5);
    }
    var nextRock = 0;

    var score = 0, lives = LIVES, time = 0, over = false, started = false, raf = 0, last = 0;
    var cx = W / 2, tx = W / 2, keys = { l: false, r: false }, fireT = 0.3, laserT = 0, tripleT = 0, freezeT = 0, laserTick = 0, shake = 0, hurt = 0;
    var rocks = [], bullets = [], caps = [], parts = [], floats = [], stars = [];
    for (i = 0; i < 40; i++) stars.push({ x: r() * W, y: r() * H, s: 0.4 + r() * 1.4, v: 6 + r() * 26 });

    function hud() {
      var s = '';
      for (var k = 0; k < LIVES; k++) s += '<span style="color:' + (k < lives ? '#ff6b8b' : '#3a2f6b') + '">♥</span>';
      api.aux(s);
    }

    function burst(x, y, color, n, spd) {
      for (var k = 0; k < n; k++) {
        var a = Math.random() * 6.28, v = (0.3 + Math.random()) * spd;
        parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35 + Math.random() * 0.45, t: 0, c: color, s: 2 + Math.random() * 3 });
      }
    }
    function addScore(n, x, y, color) {
      score += n; api.score(score);
      floats.push({ x: x, y: y, text: '+' + n, t: 0, c: color || '#fff' });
    }
    function destroy(rk) {
      rk.dead = true;
      var def = SIZES[rk.size];
      addScore(def.pts, rk.x, rk.y);
      burst(rk.x, rk.y, rk.power ? POWER[rk.power].color : '#c9b8ff', 10 + rk.size * 4, 150 + rk.size * 40);
      CA.sfx('hit', rk.size);
      if (rk.size === 3) { shake = Math.max(shake, 0.4); CA.buzz(20); }
      if (rk.power) caps.push({ x: rk.x, y: rk.y, type: rk.power, vy: 120, t: 0 });
    }
    function loseLife(x, y) {
      lives--; hurt = 1; shake = 1;
      burst(x, y, '#ff8a3d', 22, 260);
      CA.sfx('miss'); CA.buzz(60);
      hud();
      if (lives <= 0) finish();
    }
    function finish() { if (over) return; over = true; api.end(score); }

    function shoot() {
      CA.sfx('tap');
      var angles = tripleT > 0 ? [-0.2, 0, 0.2] : [0];
      angles.forEach(function (a) { bullets.push({ x: cx + Math.sin(a) * 30, y: CY - 34, vx: Math.sin(a) * 560, vy: -Math.cos(a) * 560 }); });
    }
    function give(type) {
      var p = POWER[type];
      if (type === 'laser') laserT = p.dur; else if (type === 'triple') tripleT = p.dur; else freezeT = p.dur;
      api.pop(p.name + '!', p.color);
      CA.sfx('coin'); CA.buzz(30);
      burst(cx, CY - 20, p.color, 18, 200);
    }

    function pointerX(e) { var rc = cv.getBoundingClientRect(); return (e.clientX - rc.left) / rc.width * W; }
    function onMove(e) { tx = Math.max(24, Math.min(W - 24, pointerX(e))); }
    function onDown(e) { e.preventDefault(); onMove(e); }
    function onKey(e, down) {
      var k = (e.key || '').toLowerCase();
      if (k === 'arrowleft' || k === 'a') { keys.l = down; e.preventDefault(); }
      else if (k === 'arrowright' || k === 'd') { keys.r = down; e.preventDefault(); }
    }
    function kd(e) { onKey(e, true); }
    function ku(e) { onKey(e, false); }

    /* ---------------------------------------------------------------- update */
    function update(dt) {
      time += dt;
      if (keys.l) tx -= 420 * dt;
      if (keys.r) tx += 420 * dt;
      tx = Math.max(24, Math.min(W - 24, tx));
      var dx = tx - cx, step = 900 * dt;
      cx += Math.abs(dx) <= step ? dx : Math.sign(dx) * step;
      laserT = Math.max(0, laserT - dt); tripleT = Math.max(0, tripleT - dt); freezeT = Math.max(0, freezeT - dt);
      shake = Math.max(0, shake - dt * 2.5); hurt = Math.max(0, hurt - dt * 2);

      while (nextRock < schedule.length && schedule[nextRock].at <= time) {
        var s = schedule[nextRock++];
        rocks.push({ x: s.x, y: -SIZES[s.size].r, vx: s.vx, vy: s.vy * (1 + time * 0.012), rot: 0, rs: s.rs, size: s.size, hp: SIZES[s.size].hp, power: s.power, verts: s.verts, flash: 0, dead: false });
      }

      var fz = freezeT > 0 ? 0.05 : 1;
      rocks.forEach(function (rk) {
        var def = SIZES[rk.size];
        rk.y += rk.vy * fz * dt; rk.x += rk.vx * fz * dt; rk.rot += rk.rs * fz * dt; rk.flash = Math.max(0, rk.flash - dt * 6);
        if (rk.x < def.r) { rk.x = def.r; rk.vx = Math.abs(rk.vx); } else if (rk.x > W - def.r) { rk.x = W - def.r; rk.vx = -Math.abs(rk.vx); }
        if (rk.dead) return;
        if (rk.y + def.r >= GROUND) { rk.dead = true; loseLife(rk.x, GROUND); return; }
        if (rk.y + def.r > CY - 30 && Math.abs(rk.x - cx) < def.r + 20) { rk.dead = true; loseLife(cx, CY - 20); }
      });

      /* firing: the laser replaces the bullets while it lasts */
      if (laserT <= 0) {
        fireT -= dt;
        if (fireT <= 0) { fireT = 0.2; shoot(); }
      } else {
        laserTick -= dt;
        if (laserTick <= 0) {
          laserTick = 0.08;
          rocks.forEach(function (rk) {
            if (rk.dead || rk.y < -10) return;
            if (Math.abs(rk.x - cx) < SIZES[rk.size].r + 9) { rk.hp -= 1; rk.flash = 1; if (rk.hp <= 0) destroy(rk); }
          });
        }
      }

      bullets.forEach(function (b) {
        var nx = b.x + b.vx * dt, ny = b.y + b.vy * dt;
        for (var q = 0; q < rocks.length; q++) {
          var rk = rocks[q];
          if (rk.dead) continue;
          var rad = SIZES[rk.size].r + 3;
          /* check the bullet's path this frame so fast shots cannot skip over a rock */
          var mx = (b.x + nx) / 2, my = (b.y + ny) / 2;
          if (Math.hypot(rk.x - nx, rk.y - ny) < rad || Math.hypot(rk.x - mx, rk.y - my) < rad) {
            b.dead = true; rk.hp -= 1; rk.flash = 1;
            burst(nx, ny, '#ffe9a8', 4, 110);
            if (rk.hp <= 0) destroy(rk);
            break;
          }
        }
        b.x = nx; b.y = ny;
        if (ny < -20 || nx < -20 || nx > W + 20) b.dead = true;
      });

      caps.forEach(function (c) {
        c.t += dt; c.y += c.vy * dt;
        if (c.y > CY - 36 && c.y < CY + 10 && Math.abs(c.x - cx) < 38) { c.dead = true; give(c.type); }
        else if (c.y > H + 20) c.dead = true;
      });

      parts.forEach(function (p) { p.t += dt; p.vy += 300 * dt; p.x += p.vx * dt; p.y += p.vy * dt; });
      floats.forEach(function (f) { f.t += dt; });
      stars.forEach(function (st) { st.y += st.v * dt * (freezeT > 0 ? 0.2 : 1); if (st.y > H) { st.y = 0; st.x = Math.random() * W; } });
      rocks = rocks.filter(function (rk) { return !rk.dead && rk.y < H + 60; });
      bullets = bullets.filter(function (b) { return !b.dead; });
      caps = caps.filter(function (c) { return !c.dead; });
      parts = parts.filter(function (p) { return p.t < p.life; });
      floats = floats.filter(function (f) { return f.t < 0.9; });

      if (time >= TIME && !over) { api.pop('TIME!', '#ffc93c'); finish(); }
    }

    /* ---------------------------------------------------------------- drawing */
    function rr(x, y, w, h, rad) {
      ctx.beginPath();
      ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
    }
    function drawRock(rk) {
      var def = SIZES[rk.size], base = rk.size === 3 ? '#7a6b9e' : rk.size === 2 ? '#8f7fb8' : '#a899cf';
      ctx.save(); ctx.translate(rk.x, rk.y); ctx.rotate(rk.rot);
      if (rk.power) {
        var pc = POWER[rk.power].color;
        ctx.fillStyle = pc; ctx.globalAlpha = 0.25 + 0.2 * Math.sin(time * 8);
        ctx.beginPath(); ctx.arc(0, 0, def.r + 9, 0, 6.28); ctx.fill(); ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      rk.verts.forEach(function (v, n) {
        var a = n / rk.verts.length * 6.28, px = Math.cos(a) * def.r * v, py = Math.sin(a) * def.r * v;
        if (n === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.fillStyle = freezeT > 0 ? '#bfeaff' : base; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = freezeT > 0 ? '#5ad8ff' : '#3d3267'; ctx.stroke();
      /* craters, and cracks as the rock takes damage */
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.arc(-def.r * 0.3, -def.r * 0.2, def.r * 0.22, 0, 6.28); ctx.arc(def.r * 0.32, def.r * 0.25, def.r * 0.16, 0, 6.28); ctx.fill();
      if (rk.hp < SIZES[rk.size].hp) {
        ctx.strokeStyle = 'rgba(30,20,60,0.7)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-def.r * 0.1, -def.r * 0.7); ctx.lineTo(def.r * 0.1, -def.r * 0.1); ctx.lineTo(-def.r * 0.2, def.r * 0.3); ctx.lineTo(def.r * 0.15, def.r * 0.7); ctx.stroke();
      }
      if (rk.power) {
        ctx.fillStyle = POWER[rk.power].color; ctx.beginPath(); ctx.arc(0, 0, def.r * 0.38, 0, 6.28); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '900 ' + Math.round(def.r * 0.5) + 'px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.rotate(-rk.rot); ctx.fillText(POWER[rk.power].letter, 0, 1);
      }
      if (rk.flash > 0) { ctx.rotate(0); ctx.fillStyle = 'rgba(255,255,255,' + 0.6 * rk.flash + ')'; ctx.beginPath(); ctx.arc(0, 0, def.r, 0, 6.28); ctx.fill(); }
      ctx.restore();
    }
    function render() {
      ctx.save();
      if (shake > 0) ctx.translate((Math.random() - 0.5) * shake * 12, (Math.random() - 0.5) * shake * 12);
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, freezeT > 0 ? '#0f3a6b' : '#1a0f52'); g.addColorStop(0.7, freezeT > 0 ? '#2b6fa8' : '#5b2fa0'); g.addColorStop(1, freezeT > 0 ? '#7fc8f0' : '#ff7a6b');
      ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);
      stars.forEach(function (st) { ctx.fillStyle = 'rgba(255,255,255,' + (0.35 + st.s * 0.3) + ')'; ctx.fillRect(st.x, st.y, st.s, st.s * 2.2); });
      ctx.fillStyle = '#2a1a66'; ctx.fillRect(-20, GROUND, W + 40, H - GROUND + 20);
      ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(-20, GROUND, W + 40, 3);

      /* laser beam */
      if (laserT > 0) {
        var lw = 14 + Math.sin(time * 40) * 3;
        var lg = ctx.createLinearGradient(cx - lw, 0, cx + lw, 0);
        lg.addColorStop(0, 'rgba(255,77,109,0)'); lg.addColorStop(0.5, 'rgba(255,230,240,0.95)'); lg.addColorStop(1, 'rgba(255,77,109,0)');
        ctx.fillStyle = lg; ctx.fillRect(cx - lw, 0, lw * 2, CY - 40);
        ctx.fillStyle = 'rgba(255,77,109,0.25)'; ctx.fillRect(cx - lw * 1.8, 0, lw * 3.6, CY - 40);
      }

      rocks.forEach(drawRock);
      bullets.forEach(function (b) {
        ctx.fillStyle = tripleT > 0 ? '#ffc93c' : '#fff';
        ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, 6.28); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillRect(b.x - 1.5, b.y, 3, 14);
      });

      caps.forEach(function (c) {
        var p = POWER[c.type], bob = Math.sin(c.t * 8) * 2;
        ctx.save(); ctx.translate(c.x, c.y + bob);
        ctx.fillStyle = p.color; ctx.globalAlpha = 0.3; ctx.beginPath(); ctx.arc(0, 0, 24, 0, 6.28); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = p.color; rr(-15, -15, 30, 30, 10); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '900 18px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.letter, 0, 1);
        ctx.restore();
      });

      /* cannon */
      ctx.save(); ctx.translate(cx, CY);
      if (hurt > 0) ctx.globalAlpha = 0.5 + 0.5 * Math.sin(time * 50);
      ctx.fillStyle = laserT > 0 ? '#ff4d6d' : '#2b2552'; rr(-9, -42, 18, 40, 6); ctx.fill();
      ctx.fillStyle = '#4a3f8f'; rr(-12, -46, 24, 10, 4); ctx.fill();
      if (tripleT > 0) { ctx.fillStyle = '#ffc93c'; rr(-26, -30, 10, 28, 4); ctx.fill(); rr(16, -30, 10, 28, 4); ctx.fill(); }
      ctx.fillStyle = '#ffc93c'; ctx.beginPath(); ctx.arc(0, 0, 22, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#7a4fe0'; rr(-34, -2, 68, 18, 8); ctx.fill();
      [-22, 22].forEach(function (dx) { ctx.fillStyle = '#17122e'; ctx.beginPath(); ctx.arc(dx, 12, 10, 0, 6.28); ctx.fill(); ctx.fillStyle = '#c9c1f0'; ctx.beginPath(); ctx.arc(dx, 12, 3.5, 0, 6.28); ctx.fill(); });
      ctx.restore();

      parts.forEach(function (p) { ctx.globalAlpha = Math.max(0, 1 - p.t / p.life); ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, p.s, p.s); });
      ctx.globalAlpha = 1;
      floats.forEach(function (f) {
        ctx.globalAlpha = Math.max(0, 1 - f.t / 0.9); ctx.fillStyle = f.c; ctx.font = '900 15px "Nunito", Arial, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(f.text, f.x, f.y - f.t * 36);
      });
      ctx.globalAlpha = 1;

      /* active power-ups and the clock */
      var bx = 10;
      [['laser', laserT], ['triple', tripleT], ['freeze', freezeT]].forEach(function (pt) {
        if (pt[1] <= 0) return;
        var p = POWER[pt[0]];
        ctx.fillStyle = 'rgba(12,8,36,0.6)'; rr(bx, 10, 70, 20, 8); ctx.fill();
        ctx.fillStyle = p.color; rr(bx + 3, 13, 64 * (pt[1] / p.dur), 14, 6); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = '900 10px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.name.split(' ')[0], bx + 35, 20);
        bx += 76;
      });
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = '900 14px "Nunito", Arial, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(Math.max(0, Math.ceil(TIME - time)) + 's', W - 10, 24);
      if (hurt > 0) { ctx.fillStyle = 'rgba(255,60,80,' + 0.25 * hurt + ')'; ctx.fillRect(-20, -20, W + 40, H + 40); }
      ctx.restore();
    }

    function frame(t) {
      if (!api.alive()) return;
      var dt = Math.min(0.033, (t - last) / 1000); last = t;
      if (!over) update(dt);
      render();
      raf = requestAnimationFrame(frame);
    }

    api.score(0);
    hud();
    render();

    return {
      start: function () {
        started = true; last = performance.now();
        api.box.addEventListener('pointerdown', onDown);
        api.box.addEventListener('pointermove', onMove);
        window.addEventListener('keydown', kd);
        window.addEventListener('keyup', ku);
        raf = requestAnimationFrame(frame);
      },
      stop: function () {
        cancelAnimationFrame(raf);
        api.box.removeEventListener('pointerdown', onDown);
        api.box.removeEventListener('pointermove', onMove);
        window.removeEventListener('keydown', kd);
        window.removeEventListener('keyup', ku);
      },
    };
  };
})();
