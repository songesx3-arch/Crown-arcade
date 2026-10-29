/* Sound, haptics, confetti and number count-ups. No assets: every sound is synthesised. */
(function () {
  'use strict';
  var CA = window.CA;
  var ctx = null, muted = false;

  try { muted = localStorage.getItem('ca-muted') === '1'; } catch (e) { /* storage blocked */ }

  function audio() {
    if (muted) return null;
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* one short note: frequency sweep with a quick envelope */
  function tone(f1, f2, dur, type, vol, delay) {
    var a = audio();
    if (!a) return;
    var t = a.currentTime + (delay || 0);
    var o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f1, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.12, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }

  var SOUNDS = {
    tap: function () { tone(520, 380, 0.07, 'triangle', 0.08); },
    hit: function (n) { var f = 560 + Math.min(n || 0, 24) * 22; tone(f, f * 1.5, 0.11, 'triangle', 0.11); },
    perfect: function () { tone(880, 1320, 0.09, 'sine', 0.1); tone(1320, 1760, 0.12, 'sine', 0.08, 0.07); },
    miss: function () { tone(220, 110, 0.22, 'sawtooth', 0.07); },
    crash: function () { tone(180, 50, 0.45, 'sawtooth', 0.1); tone(90, 40, 0.5, 'square', 0.05, 0.03); },
    life: function () { tone(660, 990, 0.1, 'sine', 0.1); tone(990, 1320, 0.14, 'sine', 0.09, 0.09); },
    count: function () { tone(440, 440, 0.1, 'square', 0.05); },
    go: function () { tone(880, 880, 0.22, 'square', 0.06); },
    coin: function () { tone(1180, 1580, 0.08, 'square', 0.04); },
    win: function () { [523, 659, 784, 1046].forEach(function (f, i) { tone(f, f, 0.18, 'triangle', 0.1, i * 0.1); }); },
    lose: function () { [392, 330, 262].forEach(function (f, i) { tone(f, f * 0.97, 0.22, 'triangle', 0.08, i * 0.14); }); },
    match: function () { tone(330, 660, 0.18, 'triangle', 0.09); tone(660, 990, 0.2, 'triangle', 0.08, 0.15); },
  };

  CA.sfx = function (name, arg) {
    if (muted) return;
    try { SOUNDS[name] && SOUNDS[name](arg); } catch (e) { /* audio is optional */ }
  };
  CA.buzz = function (ms) {
    if (muted) return;
    try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { /* not supported */ }
  };
  CA.isMuted = function () { return muted; };
  CA.setMuted = function (m) {
    muted = !!m;
    try { localStorage.setItem('ca-muted', muted ? '1' : '0'); } catch (e) { /* storage blocked */ }
  };
  /* browsers only allow audio after a user gesture */
  window.addEventListener('pointerdown', function () { audio(); }, { once: true });

  /* Count a number up (or down) inside an element. */
  CA.countTo = function (el, from, to, ms, fmt) {
    fmt = fmt || function (v) { return String(v); };
    if (CA.reducedMotion || from === to) { el.textContent = fmt(to); return; }
    var t0 = performance.now();
    (function step(t) {
      var k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(Math.round(from + (to - from) * e));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  };

  /* Confetti burst over the whole screen. */
  CA.confetti = function () {
    if (CA.reducedMotion) return;
    var cv = document.createElement('canvas');
    cv.className = 'confetti';
    document.body.appendChild(cv);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = innerWidth, H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    var x = cv.getContext('2d');
    x.scale(dpr, dpr);
    var cols = ['#ffc93c', '#3ee6a0', '#5ad8ff', '#ff5d8f', '#b892ff', '#ffffff'];
    var bits = [];
    for (var i = 0; i < 140; i++) {
      bits.push({
        x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.35,
        vx: (Math.random() - 0.5) * 900, vy: -300 - Math.random() * 700,
        r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 14,
        w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, c: cols[i % cols.length],
      });
    }
    var t0 = performance.now(), last = t0;
    (function frame(t) {
      var dt = Math.min(0.033, (t - last) / 1000); last = t;
      x.clearRect(0, 0, W, H);
      bits.forEach(function (b) {
        b.vy += 1300 * dt; b.vx *= 0.985;
        b.x += b.vx * dt; b.y += b.vy * dt; b.r += b.vr * dt;
        x.save(); x.translate(b.x, b.y); x.rotate(b.r);
        x.fillStyle = b.c; x.fillRect(-b.w / 2, -b.h / 2, b.w, b.h * Math.abs(Math.cos(b.r * 1.7)) + 1);
        x.restore();
      });
      if (t - t0 < 2600) requestAnimationFrame(frame); else cv.remove();
    })(t0);
  };
})();
