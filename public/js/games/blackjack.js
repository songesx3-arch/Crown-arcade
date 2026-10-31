/*
 * Blackjack (canvas 2D)
 * Ten hands against the dealer, scored in chips. You start with 200 and bet 20 a hand (40 if you
 * double). Blackjack pays 3 to 2, the dealer stands on every 17. Both players in a duel draw from
 * the same shuffled shoe (it is seeded), so the cards are identical and only the decisions differ.
 * Score = the chips you finish with.
 */
(function () {
  'use strict';
  var CA = window.CA;

  CA.games.blackjack = function (api) {
    var W = 360, H = 500, START = 200, HANDS = 10, BET = 20;
    var SUITS = ['♠', '♥', '♦', '♣'], RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    var CW = 58, CH = 82;

    var cv = api.canvas, ctx = cv.getContext('2d');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    api.fit(W / H);

    /* the shoe: six decks, shuffled with the shared seed */
    var r = api.rng, shoe = [], pos = 0, i, j;
    for (var d = 0; d < 6; d++) for (var s = 0; s < 4; s++) for (var k = 0; k < 13; k++) shoe.push({ rk: k, su: s });
    for (i = shoe.length - 1; i > 0; i--) { j = Math.floor(r() * (i + 1)); var tmp = shoe[i]; shoe[i] = shoe[j]; shoe[j] = tmp; }
    function draw() { return shoe[pos++ % shoe.length]; }
    function val(rk) { return rk === 0 ? 11 : Math.min(10, rk + 1); }
    function total(cards) {
      var t = 0, aces = 0;
      cards.forEach(function (c) { t += val(c.rk); if (c.rk === 0) aces++; });
      while (t > 21 && aces) { t -= 10; aces--; }
      return t;
    }
    function isBJ(cards) { return cards.length === 2 && total(cards) === 21; }

    var chips = START, hand = 0, bet = BET, phase = 'idle'; /* idle, dealing, player, dealer, result, over */
    var player = [], dealer = [], holeHidden = true, banner = null, canDouble = false;
    var timers = [], raf = 0, last = 0, now = 0, over = false, started = false;
    var chipFly = 0;

    function later(fn, ms) {
      var t = setTimeout(function () { if (api.alive()) fn(); }, ms);
      timers.push(t);
    }

    /* ---------------------------------------------------------------- controls */
    var bar = api.controls('<div class="bj-bar"><button type="button" data-a="hit">Hit</button><button type="button" data-a="stand">Stand</button><button type="button" data-a="double">Double</button></div>');
    var btns = {};
    [].forEach.call(bar.querySelectorAll('button'), function (b) { btns[b.getAttribute('data-a')] = b; });
    function refreshButtons() {
      var on = phase === 'player' && started && !over;
      btns.hit.disabled = !on; btns.stand.disabled = !on;
      btns.double.disabled = !(on && canDouble);
    }
    function onBtn(e) { e.preventDefault(); var a = e.currentTarget.getAttribute('data-a'); if (a === 'hit') hit(); else if (a === 'stand') stand(); else dbl(); }
    ['hit', 'stand', 'double'].forEach(function (a) { btns[a].addEventListener('pointerdown', onBtn); });
    function onKey(e) {
      if (e.repeat) return;
      var k = (e.key || '').toLowerCase();
      if (k === 'h') hit(); else if (k === 's') stand(); else if (k === 'd') dbl();
    }
    refreshButtons();

    /* ---------------------------------------------------------------- cards */
    function deal(to, faceDown) {
      var c = draw();
      var card = { rk: c.rk, su: c.su, x: W - 40, y: -90, born: now, down: !!faceDown, flipAt: -1, to: to };
      to.push(card);
      layout();
      CA.sfx('tap');
      return card;
    }
    /* fan the cards out centred in their row; each card eases to its slot */
    function layout() {
      [[dealer, 92], [player, 288]].forEach(function (row) {
        var cards = row[0], y = row[1], n = cards.length, step = Math.min(CW + 8, (W - 60 - CW) / Math.max(1, n - 1));
        var span = (n - 1) * step + CW, x0 = (W - span) / 2;
        cards.forEach(function (c, idx) { c.tx = x0 + idx * step; c.ty = y; });
      });
    }

    /* ---------------------------------------------------------------- the hand */
    function startHand() {
      hand++;
      bet = Math.min(BET, chips);
      player = []; dealer = []; holeHidden = true; banner = null; canDouble = false;
      phase = 'dealing'; refreshButtons();
      deal(player); later(function () { deal(dealer); }, 260);
      later(function () { deal(player); }, 520);
      later(function () { deal(dealer, true); }, 780);
      later(afterDeal, 1150);
    }
    function afterDeal() {
      var pBJ = isBJ(player), dBJ = isBJ(dealer);
      if (pBJ || dBJ) return reveal(function () { settle(pBJ && dBJ ? 'push' : pBJ ? 'blackjack' : 'lose'); });
      phase = 'player'; canDouble = chips >= bet * 2; refreshButtons();
    }
    function hit() {
      if (phase !== 'player') return;
      canDouble = false; deal(player);
      var t = total(player);
      if (t > 21) { phase = 'result'; refreshButtons(); return later(function () { settle('bust'); }, 450); }
      if (t === 21) return stand();
      refreshButtons();
    }
    function stand() {
      if (phase !== 'player') return;
      phase = 'dealer'; refreshButtons();
      reveal(dealerPlay);
    }
    function dbl() {
      if (phase !== 'player' || !canDouble) return;
      bet *= 2; canDouble = false; deal(player);
      api.pop('DOUBLE', '#ffc93c');
      if (total(player) > 21) { phase = 'result'; refreshButtons(); return later(function () { settle('bust'); }, 450); }
      phase = 'dealer'; refreshButtons();
      later(function () { reveal(dealerPlay); }, 450);
    }
    function reveal(next) {
      var hole = dealer[1];
      if (hole && hole.down) { hole.flipAt = now; CA.sfx('tap'); }
      later(function () { holeHidden = false; next(); }, 420);
    }
    function dealerPlay() {
      if (total(dealer) < 17 && total(player) <= 21) { deal(dealer); return later(dealerPlay, 520); }
      var p = total(player), dd = total(dealer);
      settle(dd > 21 ? 'dealerBust' : p > dd ? 'win' : p < dd ? 'lose' : 'push');
    }
    function settle(kind) {
      phase = 'result'; refreshButtons();
      holeHidden = false; if (dealer[1]) dealer[1].down = false;
      var delta = 0, text, color;
      if (kind === 'blackjack') { delta = Math.floor(bet * 1.5); text = 'BLACKJACK +' + delta; color = '#ffc93c'; }
      else if (kind === 'win' || kind === 'dealerBust') { delta = bet; text = (kind === 'win' ? 'YOU WIN +' : 'DEALER BUSTS +') + delta; color = '#3ee6a0'; }
      else if (kind === 'push') { text = 'PUSH'; color = '#d7d0f5'; }
      else { delta = -bet; text = (kind === 'bust' ? 'BUST ' : 'DEALER WINS ') + delta; color = '#ff6b8b'; }
      chips = Math.max(0, chips + delta);
      banner = { text: text, color: color, at: now };
      chipFly = delta;
      api.score(chips);
      api.aux('<span class="muted small">hand</span> ' + Math.min(hand, HANDS) + '/' + HANDS);
      CA.sfx(delta > 0 ? 'win' : delta < 0 ? 'miss' : 'tap');
      if (delta < 0) CA.buzz(60);
      later(function () {
        if (hand >= HANDS || chips <= 0) { phase = 'over'; over = true; return later(function () { api.end(chips); }, 500); }
        startHand();
      }, 1500);
    }

    /* ---------------------------------------------------------------- drawing */
    function rr(x, y, w, h, rad) {
      ctx.beginPath();
      ctx.moveTo(x + rad, y); ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
      ctx.arcTo(x, y + h, x, y, rad); ctx.arcTo(x, y, x + w, y, rad); ctx.closePath();
    }
    function drawCard(c) {
      var fp = c.flipAt >= 0 ? Math.min(1, (now - c.flipAt) / 380) : -1;
      var sx = 1, down = c.down;
      if (fp >= 0) { sx = Math.abs(Math.cos(Math.PI * fp)); if (fp > 0.5) down = false; }
      var pop = Math.min(1, (now - c.born) / 260), sc = 0.7 + 0.3 * (1 - Math.pow(1 - pop, 3));
      ctx.save();
      ctx.translate(c.x + CW / 2, c.y + CH / 2);
      ctx.rotate((1 - pop) * 0.25);
      ctx.scale(Math.max(0.03, sx) * sc, sc);
      ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
      rr(-CW / 2, -CH / 2, CW, CH, 8);
      if (down) {
        ctx.fillStyle = '#3b3fd6'; ctx.fill(); ctx.shadowColor = 'transparent';
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
        for (var q = -2; q <= 2; q++) { ctx.beginPath(); ctx.moveTo(-CW / 2 + 6, q * 14); ctx.lineTo(CW / 2 - 6, q * 14 + 10); ctx.stroke(); }
      } else {
        ctx.fillStyle = '#fffdf7'; ctx.fill(); ctx.shadowColor = 'transparent';
        var red = c.su === 1 || c.su === 2;
        ctx.fillStyle = red ? '#e0314f' : '#1b1535';
        ctx.font = '900 18px "Nunito", Arial, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(RANKS[c.rk], -CW / 2 + 6, -CH / 2 + 5);
        ctx.font = '16px Arial, sans-serif'; ctx.fillText(SUITS[c.su], -CW / 2 + 6, -CH / 2 + 25);
        ctx.font = '34px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(SUITS[c.su], 4, 8);
      }
      ctx.restore();
    }
    function label(text, x, y, size, color, align) {
      ctx.font = '900 ' + size + 'px "Nunito", Arial, sans-serif'; ctx.fillStyle = color; ctx.textAlign = align || 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, x, y);
    }
    function render() {
      var g = ctx.createRadialGradient(W / 2, H * 0.45, 30, W / 2, H * 0.45, H * 0.8);
      g.addColorStop(0, '#1f9a63'); g.addColorStop(1, '#0b4a35');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      /* table rim and printed text */
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(W / 2, H + 40, 280, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
      label('BLACKJACK PAYS 3 TO 2', W / 2, 218, 14, 'rgba(255,255,255,0.35)');
      label('DEALER STANDS ON ALL 17s', W / 2, 238, 11, 'rgba(255,255,255,0.25)');
      /* top bar */
      label('HAND ' + Math.min(hand, HANDS) + ' / ' + HANDS, 16, 28, 15, '#d7f7e6', 'left');
      label('Bet ' + bet, W - 16, 28, 15, '#ffd86b', 'right');
      label('DEALER', W / 2, 62, 13, 'rgba(255,255,255,0.7)');
      if (dealer.length) label(holeHidden ? '' + val(dealer[0].rk === 0 ? 0 : dealer[0].rk) + ' + ?' : '' + total(dealer), W / 2, 84, 17, '#fff');
      dealer.forEach(drawCard);
      player.forEach(drawCard);
      if (player.length) {
        var pt = total(player), soft = false;
        player.forEach(function (c) { if (c.rk === 0) soft = true; });
        label('YOU: ' + pt + (pt > 21 ? ' BUST' : isBJ(player) ? ' BLACKJACK' : ''), W / 2, 398, 18, pt > 21 ? '#ff8ba3' : '#fff');
      }
      /* chip stack */
      var cx = W / 2, cy = 452;
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; rr(cx - 120, cy - 30, 240, 56, 28); ctx.fill();
      ctx.beginPath(); ctx.arc(cx - 92, cy - 2, 17, 0, Math.PI * 2); ctx.fillStyle = '#ffc93c'; ctx.fill();
      ctx.beginPath(); ctx.arc(cx - 92, cy - 2, 10, 0, Math.PI * 2); ctx.strokeStyle = '#8a5a00'; ctx.lineWidth = 3; ctx.stroke();
      label('' + chips, cx - 64, cy + 8, 28, '#fff', 'left');
      label('CHIPS', cx + 60, cy + 6, 12, 'rgba(255,255,255,0.6)', 'left');
      /* result banner */
      if (banner) {
        var bp = Math.min(1, (now - banner.at) / 260), sc = 0.6 + 0.4 * (1 - Math.pow(1 - bp, 3));
        ctx.save(); ctx.translate(W / 2, 205); ctx.scale(sc, sc);
        ctx.font = '900 30px "Lilita One", "Nunito", Arial, sans-serif'; ctx.textAlign = 'center';
        var tw = ctx.measureText(banner.text).width + 36;
        ctx.fillStyle = 'rgba(12,8,36,0.82)'; rr(-tw / 2, -30, tw, 46, 14); ctx.fill();
        ctx.fillStyle = banner.color; ctx.fillText(banner.text, 0, 4);
        ctx.restore();
      }
    }

    function frame(t) {
      if (!api.alive()) return;
      var dt = Math.min(0.05, (t - last) / 1000); last = t; now = t;
      var k = Math.min(1, dt * 11);
      dealer.concat(player).forEach(function (c) { c.x += (c.tx - c.x) * k; c.y += (c.ty - c.y) * k; });
      render();
      raf = requestAnimationFrame(frame);
    }

    now = performance.now();
    api.score(START);
    api.aux('<span class="muted small">hand</span> 0/' + HANDS);
    render();

    return {
      start: function () {
        started = true; last = now = performance.now();
        window.addEventListener('keydown', onKey);
        raf = requestAnimationFrame(frame);
        startHand();
      },
      stop: function () {
        cancelAnimationFrame(raf);
        timers.forEach(clearTimeout);
        window.removeEventListener('keydown', onKey);
      },
    };
  };
})();
