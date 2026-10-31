/*
 * Crown Arcade client: lobby, matchmaking screens, match flow and results.
 * The server owns coins, crowns and results. S is only a copy of what it last told us.
 */
(function () {
  'use strict';
  var CA = window.CA, $ = CA.$, net = CA.net, G = CA.GAMES;

  var S = { name: 'Player', coins: 0, crowns: 0, wins: 0, losses: 0, draws: 0, streak: 0, bestStreak: 0,
    best: {}, history: [], dailyLeft: 0, refillLeft: 0, google: false, _at: Date.now() };
  var game = 'orbit', stake = 50, online = 0, kicked = false;
  var busy = false;      /* in a queue, room, match or result flow */
  var cur = null;        /* the match being played right now */
  var handle = null;     /* mounted game */
  var waitKind = null, joinCode = null, offer = null;
  var shownCoins = null, shownCrowns = null;

  /* ============================================================ helpers */
  var toastT = null;
  function toast(text) {
    var t = $('toast');
    t.textContent = text; t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, 3800);
  }
  function setNet(text) { var n = $('net'); n.hidden = !text; if (text) n.textContent = text; }
  function myName() { return (S.name && String(S.name).trim()) || 'Player'; }
  function initial(n) { return String(n || '?').charAt(0).toUpperCase(); }
  function has3D(g) { return !G[g].is3d || CA.three.available(); }

  function show(which) {
    ['lobby', 'match', 'result', 'wait'].forEach(function (id) { $(id).hidden = id !== which; });
    if (which !== 'wait') waitKind = null;
    document.body.style.overflow = which === 'lobby' ? '' : 'hidden';
    if (which === 'lobby') {
      try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {}); } catch (e) { /* ok */ }
      renderAll();
    }
  }
  function goFullscreen() {
    try {
      var el = document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen && matchMedia('(pointer: coarse)').matches) el.requestFullscreen().catch(function () {});
    } catch (e) { /* ok */ }
  }
  function backToLobby() {
    if (offer) { net.send({ t: 'rematch_no', mid: offer.mid }); offer = null; }
    CA.unmountGame(); handle = null;
    busy = false; cur = null;
    show('lobby');
  }

  function copyText(text, btn, label) {
    function done(ok) { btn.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(function () { btn.textContent = label; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); document.body.removeChild(ta); done(ok);
      } catch (e) { done(false); }
    }
  }

  /* tap-twice confirm for destructive buttons */
  function armed(btn, label, armedLabel, fn) {
    var t = null;
    btn.onclick = function () {
      if (!btn.dataset.armed) {
        btn.dataset.armed = '1'; btn.textContent = armedLabel; btn.classList.add('armed');
        clearTimeout(t);
        t = setTimeout(function () { delete btn.dataset.armed; btn.textContent = label; btn.classList.remove('armed'); }, 3500);
        return;
      }
      clearTimeout(t); delete btn.dataset.armed; btn.textContent = label; btn.classList.remove('armed');
      fn();
    };
  }

  /* ============================================================ server messages */
  net.onStatus = setNet;
  net.onDown = function () { renderAll(); };
  net.onMessage = function (m) {
    switch (m.t) {
      case 'welcome': return onWelcome(m);
      case 'me':
        applyMe(m.me);
        if (m.gift) { toast('+' + m.gift + ' coins'); CA.sfx('coin'); }
        return;
      case 'linked': applyMe(m.me); return toast('Signed in with Google. Your progress is saved to it.');
      case 'switch':
        net.setKey(m.key); toast('Signed in. Loading your account…');
        return setTimeout(function () { location.reload(); }, 600);
      case 'online': online = m.n; return renderBadge();
      case 'queued': return showWait('queue', m);
      case 'room': return showWait('room', m);
      case 'cancelled':
        if (m.why === 'room_expired') toast('Your room expired.');
        if (waitKind) backToLobby();
        return;
      case 'match': return beginMatch(m);
      case 'opp': return onOpp(m);
      case 'opp_done': return onOppDone(m);
      case 'result': return showResult(m);
      case 'rematch_offer': return onRematchOffer(m);
      case 'rematch_wait': return setRematchBtn('Waiting for ' + (offer ? offer.oppName : 'them') + '…', true);
      case 'rematch_off': return onRematchOff(m);
      case 'ladder': return renderLadder(m);
      case 'error': return onError(m);
    }
  };

  function onWelcome(m) {
    if (m.key) { net.setKey(m.key); renderKey(); }
    online = m.online;
    applyMe(m.me);
    if (m.pending) {
      showResult(m.pending);
    } else if (m.active) {
      var a = m.active;
      if (cur && cur.mid === a.mid) {
        if (cur.finished) net.send({ t: 'result', mid: cur.mid, score: cur.myScore }); /* may not have arrived */
      } else if (a.finished) {
        cur = { mid: a.mid, game: a.game, stake: a.stake, bot: a.bot, oppName: a.oppName, finished: true, myScore: null, oppLive: null };
        busy = true; showWaiting();
      } else {
        net.send({ t: 'forfeit', mid: a.mid });
        toast('You left your last match, so it counted as a loss.');
      }
    } else if (cur && !cur.solo && !cur.finished) {
      CA.unmountGame(); cur = null; busy = false; show('lobby');
      toast('That match ended while you were offline.');
    } else if (waitKind === 'queue' || waitKind === 'room') {
      backToLobby(); toast('The connection dropped, so your search was cancelled.');
    }
    var code = joinCode; joinCode = null;
    if (code && !busy && !m.active) { busy = true; net.send({ t: 'room_join', code: code }); }
    renderAll();
    if (!$('tab-league').hidden) net.send({ t: 'ladder' });
  }

  function onError(m) {
    switch (m.code) {
      case 'replaced':
        kicked = true; net.halt(); CA.unmountGame();
        return showWait('replaced');
      case 'unknown_key':
      case 'bad_key':
        net.dropKey();
        toast('Your saved account was not found on this server, so a new one was created.');
        return net.restart();
      case 'daily_wait':
        if (m.me) applyMe(m.me);
        return toast(m.msg);
      case 'no_rematch':
        return onRematchOff({ why: 'expired' });
      case 'no_match':
        return; /* a late duplicate result after a reconnect */
      default:
        toast(m.msg || 'Something went wrong.');
        if (waitKind && waitKind !== 'replaced') backToLobby();
        else if (!cur) busy = false;
        renderAll();
    }
  }

  /* ============================================================ lobby rendering */
  function applyMe(me) {
    if (!me) return;
    var typing = document.activeElement === $('nameIn');
    S = Object.assign(S, me);
    S._at = Date.now();
    if (!typing) $('nameIn').value = S.name;
    renderAll();
  }

  function renderWallet() {
    var c = $('coins'), k = $('crowns');
    if (shownCoins !== null && shownCoins !== S.coins) {
      CA.countTo(c, shownCoins, S.coins, 700);
      c.parentNode.classList.remove('bump'); void c.offsetWidth; c.parentNode.classList.add('bump');
    } else c.textContent = S.coins;
    if (shownCrowns !== null && shownCrowns !== S.crowns) CA.countTo(k, shownCrowns, S.crowns, 700);
    else k.textContent = S.crowns;
    shownCoins = S.coins; shownCrowns = S.crowns;
  }

  function renderBadge() {
    var b = $('liveBadge');
    b.classList.toggle('on', net.ready);
    b.lastChild.textContent = net.ready ? online + ' online now' : 'Connecting';
    var st = $('streakChip');
    st.hidden = !(S.streak >= 2);
    st.textContent = '🔥 ' + S.streak + ' win streak' + (S.streak >= CA.STREAK_AT ? ' · +1 crown' : '');
  }

  function renderBests() {
    CA.GKEYS.forEach(function (k) {
      $('b-' + k).textContent = S.best && S.best[k] !== undefined ? 'Best ' + CA.fmt(k, S.best[k]) : 'New';
    });
    $('bestList').innerHTML = CA.GKEYS.map(function (k) {
      return '<li><span>' + G[k].name + '</span><b>' + (S.best && S.best[k] !== undefined ? CA.fmt(k, S.best[k]) : '–') + '</b></li>';
    }).join('');
  }

  function renderHistory() {
    var h = S.history || [];
    $('historyList').innerHTML = h.length ? h.map(function (x) {
      var net_ = x.net > 0 ? '+' + x.net : String(x.net);
      return '<li class="' + x.outcome + '"><span class="badge">' + x.outcome.charAt(0).toUpperCase() + '</span>' +
        '<span class="h-mid"><b>' + G[x.game].name + ' vs ' + CA.esc(x.oppName) + (x.bot && x.oppName !== 'Blitz' ? ' ·🤖' : '') + '</b>' +
        '<small>' + CA.fmt(x.game, x.you) + ' – ' + CA.fmt(x.game, x.opp) + ' · ' + CA.ago(x.at) + '</small></span>' +
        '<span class="h-net ' + (x.net > 0 ? 'up' : x.net < 0 ? 'down' : '') + '">' + net_ + '</span></li>';
    }).join('') : '<li class="empty">No matches yet. Your last ' + 12 + ' duels show up here.</li>';
  }

  function renderDaily() {
    var left = S.dailyLeft - (Date.now() - S._at);
    var b = $('claim'), n = $('dailyNote'), chip = $('bonus'), bn = $('bonusNote');
    if (!net.ready) { b.disabled = chip.disabled = true; n.textContent = ''; bn.textContent = 'Daily bonus'; return; }
    if (left <= 0) {
      b.disabled = chip.disabled = false;
      b.textContent = 'Claim 100 coins'; chip.textContent = 'Claim 100';
      n.textContent = 'Ready'; bn.textContent = 'Your daily 100 coins are ready';
    } else {
      var wait = Math.floor(left / 3600000) + 'h ' + Math.floor(left % 3600000 / 60000) + 'm';
      b.disabled = chip.disabled = true;
      b.textContent = 'Claimed'; chip.textContent = 'Claimed';
      n.textContent = 'Next in ' + wait; bn.textContent = 'Next bonus in ' + wait;
    }
  }

  function renderLeague() {
    var i = CA.leagueIdx(S.crowns), now = CA.LEAGUES[i], nxt = CA.LEAGUES[i + 1], col = CA.LEAGUE_COLORS[i];
    $('leagueName').textContent = now[0];
    $('leagueCrowns').textContent = S.crowns + ' crowns';
    $('shield').style.color = col;
    $('leagueBar').style.background = col;
    if (nxt) {
      $('leagueNext').textContent = (nxt[1] - S.crowns) + ' more crowns to reach ' + nxt[0];
      $('leagueBar').style.width = Math.round((S.crowns - now[1]) / (nxt[1] - now[1]) * 100) + '%';
    } else {
      $('leagueNext').textContent = 'Top league. Defend your spot on the ladder.';
      $('leagueBar').style.width = '100%';
    }
    $('tiers').innerHTML = CA.LEAGUES.map(function (l, n) {
      var st = n === i ? 'now' : n < i ? 'done' : 'locked';
      return '<li class="tier ' + st + '" style="--tc:' + CA.LEAGUE_COLORS[n] + '"><span class="dot"></span><b>' + l[0] + '</b>' +
        '<span class="st">' + (st === 'now' ? 'You' : st === 'done' ? '✓' : '') + '</span><small>' + l[1] + '+ crowns</small></li>';
    }).join('');
  }

  function renderProfile() {
    var i = CA.leagueIdx(S.crowns), tot = S.wins + S.losses + (S.draws || 0);
    $('pRecord').textContent = S.wins + '-' + S.losses + (S.draws ? '-' + S.draws : '');
    $('pRate').textContent = tot ? Math.round(S.wins / tot * 100) + '%' : '–';
    $('pStreak').textContent = S.streak || 0;
    $('pBestStreak').textContent = S.bestStreak || 0;
    $('pLeague').textContent = CA.LEAGUES[i][0] + ' league · ' + S.crowns + ' crowns';
    $('avatar').textContent = initial(myName());
    $('avatar').style.background = CA.LEAGUE_COLORS[i];
    renderHistory();
    renderGoogle();
  }

  function renderStakes() {
    var box = $('stakes');
    box.innerHTML = '';
    CA.STAKES.forEach(function (v) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'stake'; b.setAttribute('role', 'radio');
      b.innerHTML = '<span><i class="ico-coin"></i>' + v + '</span><small>' + (v === 25 ? 'Casual' : v === 50 ? 'Standard' : 'High roller') + '</small>';
      b.disabled = !net.ready || S.coins < v;
      b.setAttribute('aria-checked', String(stake === v));
      b.onclick = function () { stake = v; CA.sfx('tap'); renderStakes(); renderPlay(); };
      box.appendChild(b);
    });
  }

  function renderPlay() {
    var p = $('play'), bot = $('btnBot'), fr = $('btnFriend'), jn = $('btnJoin'), bz = $('btnBlitz');
    bot.disabled = false;
    if (!net.ready) {
      p.textContent = 'Connecting…'; p.disabled = true; p.dataset.mode = 'wait';
      fr.disabled = jn.disabled = bz.disabled = true;
      $('blitzNote').textContent = '';
      $('prize').innerHTML = ''; $('stakeNote').textContent = '';
      $('lobbyNote').textContent = 'Practice works offline. Duels need a connection.';
      return;
    }
    jn.disabled = false;
    if (S.coins < CA.STAKES[0]) {
      var wait = S.refillLeft - (Date.now() - S._at);
      p.dataset.mode = 'refill'; p.classList.add('gold');
      p.disabled = wait > 0;
      p.textContent = wait > 0 ? 'Refill in ' + Math.ceil(wait / 60000) + ' min' : 'Refill 500 coins';
      fr.disabled = bz.disabled = true;
      $('blitzNote').textContent = '';
      $('prize').innerHTML = '';
      $('lobbyNote').textContent = 'Out of coins. You can refill every 5 minutes, or keep practising.';
      return;
    }
    p.classList.remove('gold');
    if (S.coins < stake) { stake = CA.STAKES[0]; renderStakes(); }
    var crowns = CA.WIN_CROWNS + (S.streak + 1 >= CA.STREAK_AT ? 1 : 0);
    p.textContent = 'Play ' + G[game].name; p.disabled = false; p.dataset.mode = 'play';
    fr.disabled = bz.disabled = false;
    var tg = S.blitz && S.blitz[game];
    $('blitzNote').textContent = tg ? 'Blitz: score ' + CA.fmt(game, tg) + ' to get your stake back (a little above your average). Score more to win up to ×3 = ' + stake * 3 + ' coins.' : '';
    $('stakeNote').textContent = 'You have ' + S.coins;
    $('prize').innerHTML = '<div class="w">Win<b>+' + stake + ' coins · +' + crowns + ' 👑</b></div><div class="l">Lose<b>−' + stake + ' coins · −1 👑</b></div>';
    $('lobbyNote').textContent = 'Matched with a player on the same game and stake. Nobody around? A computer opponent steps in.';
  }

  function renderAll() {
    renderWallet(); renderBadge(); renderBests(); renderDaily(); renderLeague(); renderProfile(); renderStakes(); renderPlay();
  }

  function renderLadder(m) {
    var rows = m.rows || [];
    $('board').innerHTML = rows.length ? rows.map(function (r) {
      return '<li class="rk' + (r.me ? ' me' : '') + (r.pos <= 3 ? ' p' + r.pos : '') + '"><span class="pos">' + r.pos + '</span>' +
        '<span class="nm"><b>' + CA.esc(r.name) + (r.me ? '<em class="you-tag">YOU</em>' : '') + '</b><small>' + r.league +
        (r.streak >= 2 ? ' · 🔥' + r.streak : '') + '</small></span><span class="cr"><i class="ico-crown"></i>' + r.crowns + '</span></li>';
    }).join('') : '<li class="empty">No one is on the ladder yet. Finish a match to be the first.</li>';
    $('ladderNote').textContent = m.rank ? '#' + m.rank + ' of ' + m.total : m.online + ' online';
    if (m.online !== undefined) { online = m.online; renderBadge(); }
  }

  /* Google sign-in: only shown when the server has a Google client id */
  var googleId = null;
  function renderGoogle() {
    var box = $('googleBox');
    if (!googleId) { box.hidden = true; return; }
    box.hidden = false;
    $('googleNote').textContent = S.google ? 'Signed in with Google. Sign in on any device to open this account.' : 'Sign in with Google to keep this account safe and use it on other devices.';
    $('googleBtn').hidden = !!S.google;
  }
  function initGoogle() {
    fetch('/config.json').then(function (r) { return r.json(); }).then(function (c) {
      if (!c || !c.googleClientId) return;
      googleId = c.googleClientId; renderGoogle();
      var sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = function () {
        try {
          google.accounts.id.initialize({ client_id: googleId, callback: function (r) {
            if (r && r.credential && !net.send({ t: 'google', credential: r.credential })) toast('Not connected. Try again in a moment.');
          } });
          google.accounts.id.renderButton($('googleBtn'), { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill' });
        } catch (e) { /* ok */ }
      };
      sc.onerror = function () { $('googleNote').textContent = 'Google sign-in could not load.'; };
      document.head.appendChild(sc);
    }).catch(function () {});
  }

  /* ============================================================ lobby controls */
  var TABS = ['play', 'league', 'profile'], ladderT = null;
  function setTab(n) {
    TABS.forEach(function (t) { $('tab-' + t).hidden = t !== n; $('t-' + t).setAttribute('aria-selected', String(t === n)); });
    clearInterval(ladderT);
    if (n === 'league') { net.send({ t: 'ladder' }); ladderT = setInterval(function () { net.send({ t: 'ladder' }); }, 15000); }
    if (n === 'profile') renderDaily();
    window.scrollTo(0, 0);
  }
  TABS.forEach(function (t) { $('t-' + t).onclick = function () { setTab(t); }; });

  CA.GKEYS.forEach(function (k) {
    $('g-' + k).onclick = function () {
      game = k; CA.sfx('tap');
      CA.GKEYS.forEach(function (j) { $('g-' + j).setAttribute('aria-checked', String(j === k)); });
      renderPlay();
    };
  });

  var nameT = null;
  $('nameIn').oninput = function () {
    var v = this.value;
    clearTimeout(nameT);
    nameT = setTimeout(function () { net.send({ t: 'name', name: v }); }, 500);
  };
  $('nameIn').onblur = function () { this.value = S.name; };

  function claim() { net.send({ t: 'claim' }); }
  $('claim').onclick = claim;
  $('bonus').onclick = claim;
  setInterval(function () { if (net.ready && !$('lobby').hidden) { renderDaily(); renderPlay(); } }, 30000);

  armed($('reset'), 'Reset stats', 'Tap again to erase everything', function () { net.send({ t: 'reset' }); });

  function renderMute() {
    var m = CA.isMuted();
    $('muteBtn').setAttribute('aria-label', m ? 'Sound off' : 'Sound on');
    $('muteBtn').innerHTML = m
      ? '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M17 9l4 6M21 9l-4 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  }
  $('muteBtn').onclick = function () { CA.setMuted(!CA.isMuted()); renderMute(); CA.sfx('tap'); };

  /* account key */
  var keyShown = false;
  function renderKey() {
    $('keyOut').type = keyShown ? 'text' : 'password';
    $('keyOut').value = net.key() || '';
    $('keyShow').textContent = keyShown ? 'Hide' : 'Show';
  }
  $('keyShow').onclick = function () { keyShown = !keyShown; renderKey(); };
  $('keyCopy').onclick = function () { copyText(net.key() || '', this, 'Copy'); };
  $('keyRestore').onclick = function () {
    var v = $('keyIn').value.trim();
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(v)) return toast('That does not look like an account key.');
    net.setKey(v); location.reload();
  };

  /* play buttons */
  function canStart() {
    if (busy || !net.ready) return false;
    if (!has3D(game)) { toast(G[game].name + ' needs 3D graphics, which this browser does not have. Orbit Tap still works.'); return false; }
    return true;
  }
  $('play').onclick = function () {
    if (this.dataset.mode === 'refill') return net.send({ t: 'refill' });
    if (!canStart()) return;
    busy = true; goFullscreen(); net.send({ t: 'queue', game: game, stake: stake });
  };
  $('btnBlitz').onclick = function () {
    if (!canStart()) return;
    busy = true; goFullscreen(); net.send({ t: 'blitz', game: game, stake: stake });
  };
  $('btnFriend').onclick = function () {
    if (!canStart()) return;
    busy = true; goFullscreen(); net.send({ t: 'room_create', game: game, stake: stake });
  };
  $('btnBot').onclick = function () {
    if (busy) return;
    if (!has3D(game)) return toast(G[game].name + ' needs 3D graphics. Orbit Tap still works.');
    goFullscreen(); startSolo(game);
  };
  $('codeIn').oninput = function () { this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); };
  $('codeIn').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); $('btnJoin').click(); } };
  $('btnJoin').onclick = function () {
    var c = $('codeIn').value;
    if (c.length !== 4) return toast('Room codes are 4 letters or numbers.');
    if (busy || !net.ready) return;
    busy = true; goFullscreen(); net.send({ t: 'room_join', code: c });
  };

  /* ============================================================ waiting screens */
  var waitT = null;
  function showWait(kind, m) {
    var w = $('wait');
    clearInterval(waitT);
    busy = kind !== 'replaced';
    if (kind === 'queue') {
      var since = Date.now();
      w.innerHTML = '<div class="wait-card"><div class="radar"><span>' + initial(myName()) + '</span></div>' +
        '<p class="big">Finding an opponent</p>' +
        '<p class="muted">' + CA.esc(G[m.game].name) + ' · ' + m.stake + ' coins</p>' +
        '<p class="muted num" id="waitNote" role="status">0:00</p></div>' +
        '<div class="wait-actions"><button class="btn btn-soft" id="waitCancel" type="button">Cancel</button></div>';
      $('waitCancel').onclick = function () { net.send({ t: 'cancel' }); };
      waitT = setInterval(function () {
        var s = Math.floor((Date.now() - since) / 1000), n = $('waitNote');
        if (n) n.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2) + (s >= 8 ? ' · almost there' : '');
      }, 500);
    } else if (kind === 'room') {
      var link = location.origin + '/?room=' + m.code;
      w.innerHTML = '<div class="wait-card"><p class="big">Duel a friend</p>' +
        '<p class="muted">' + CA.esc(G[m.game].name) + ' · ' + m.stake + ' coins. Share this code or the link.</p>' +
        '<p class="code-big" aria-label="Room code">' + CA.esc(m.code) + '</p>' +
        '<p class="muted" role="status">Waiting for your friend…</p></div>' +
        '<div class="wait-actions"><button class="btn btn-go gold" id="copyLink" type="button">Copy invite link</button>' +
        (navigator.share ? '<button class="btn btn-soft" id="shareLink" type="button">Share…</button>' : '') +
        '<button class="btn btn-soft" id="waitCancel" type="button">Cancel</button></div>';
      $('copyLink').onclick = function () { copyText(link, this, 'Copy invite link'); };
      if ($('shareLink')) $('shareLink').onclick = function () { navigator.share({ title: 'Crown Arcade duel', text: 'Duel me in ' + G[m.game].name + '! Code ' + m.code, url: link }).catch(function () {}); };
      $('waitCancel').onclick = function () { net.send({ t: 'cancel' }); };
    } else if (kind === 'replaced') {
      w.innerHTML = '<div class="wait-card"><p class="big">Open in another tab</p>' +
        '<p class="muted">This account was opened somewhere else. Only one tab can play at a time.</p></div>' +
        '<div class="wait-actions"><button class="btn btn-go" id="useHere" type="button">Use it here</button></div>';
      $('useHere').onclick = function () { kicked = false; busy = false; cur = null; show('lobby'); net.connect(); };
    }
    show('wait');
    waitKind = kind;
  }

  /* ============================================================ a match */
  function setDuel(opts) {
    $('meName').textContent = myName();
    $('meAva').textContent = initial(myName());
    $('meSub').textContent = CA.LEAGUES[CA.leagueIdx(S.crowns)][0] + ' · ' + S.crowns + ' 👑';
    $('meScore').textContent = '0';
    $('oppName').textContent = opts.oppName;
    $('oppAva').textContent = opts.solo ? '★' : initial(opts.oppName);
    $('oppSub').textContent = opts.oppSub;
    $('oppScore').textContent = opts.oppScore;
    $('seedNote').textContent = opts.note;
    updateRace(0, null);
  }

  function updateRace(me, opp) {
    var w = opp === null || opp === undefined ? 50 : (me + opp === 0 ? 50 : CA.clamp(me / (me + opp) * 100, 6, 94));
    $('raceMe').style.width = w + '%';
  }

  function countdown(name, tip, ms, then) {
    var box = $('fitbox'), steps = ['3', '2', '1', 'GO!'], i = 0, step = Math.max(150, ms / 4);
    var el = document.createElement('div');
    el.className = 'countdown';
    el.innerHTML = '<span class="gname">' + CA.esc(name) + '</span><b class="tick">3</b><p>' + CA.esc(tip) + '</p>';
    box.appendChild(el);
    CA.sfx('count');
    var t = setInterval(function () {
      i++;
      if (i < steps.length) {
        var b = el.querySelector('b');
        b.textContent = steps[i]; b.classList.remove('tick'); void b.offsetWidth; b.classList.add('tick');
        CA.sfx(i === 3 ? 'go' : 'count');
        if (i === 3) el.querySelector('p').textContent = '';
        return;
      }
      clearInterval(t); el.remove(); then();
    }, step);
    return function () { clearInterval(t); el.remove(); };
  }

  function beginMatch(m) {
    if (!has3D(m.game)) {
      net.send({ t: 'forfeit', mid: m.mid });
      busy = false; show('lobby');
      return toast('That match needs 3D graphics, which this browser does not have.');
    }
    if (offer) offer = null;
    CA.unmountGame();
    game = m.game; stake = m.stake; busy = true;
    applyMe(m.me);
    cur = { mid: m.mid, game: m.game, stake: m.stake, bot: m.bot, blitz: !!m.blitz, oppName: m.opp.name, finished: false, myScore: null,
      live: 0, oppLive: m.blitz ? m.target : null, lastSent: 0, timers: [] };
    if (m.blitz) setDuel({ oppName: 'Blitz', oppSub: 'Break-even ' + CA.fmt(m.game, m.target), oppScore: m.target, note: G[m.game].name + ' · Blitz · ' + m.stake + ' coins' });
    else setDuel({
      oppName: m.opp.name,
      oppSub: m.bot ? 'Computer' : CA.LEAGUES[CA.leagueIdx(m.opp.crowns)][0] + ' · ' + m.opp.crowns + ' 👑',
      oppScore: m.bot ? '?' : '0',
      note: G[m.game].name + ' · ' + m.stake + ' coins · board #' + m.seed,
    });
    if (m.blitz) $('oppAva').textContent = '⚡';
    show('match');
    CA.sfx('match');
    var my = cur;
    handle = CA.mountGame(m.game, { seed: m.seed, onScore: onMyScore, onDone: finishLocal });
    countdown(G[m.game].name, G[m.game].tip, m.startIn, function () {
      if (cur !== my) return;
      handle.start();
      /* stop a little before the server's hard limit so the score still counts */
      my.timers.push(setTimeout(forceEnd, Math.max(3000, m.limitMs - 5000)));
    });
  }

  function onMyScore(n) {
    if (!cur || cur.finished) return;
    cur.live = n;
    $('meScore').textContent = n;
    updateRace(n, cur.oppLive);
    if (cur.solo || cur.bot) return;
    var t = Date.now();
    if (t - cur.lastSent < 250) {
      clearTimeout(cur.sendT);
      cur.sendT = setTimeout(function () { if (cur && !cur.finished) { cur.lastSent = Date.now(); net.send({ t: 'progress', mid: cur.mid, score: cur.live }); } }, 260);
      return;
    }
    cur.lastSent = t;
    net.send({ t: 'progress', mid: cur.mid, score: n });
  }

  function onOpp(m) {
    if (!cur || cur.mid !== m.mid) return;
    cur.oppLive = m.score;
    $('oppScore').textContent = m.score;
    updateRace(cur.live, m.score);
    var w = $('wOpp'); if (w) w.textContent = CA.fmt(cur.game, m.score);
  }

  function onOppDone(m) {
    if (!cur || cur.mid !== m.mid) return;
    cur.oppFinal = m.score; cur.oppLive = m.score;
    $('oppScore').textContent = m.score;
    $('oppSub').textContent = 'Finished · beat ' + m.score;
    updateRace(cur.live, m.score);
    var w = $('wOpp'); if (w) w.textContent = CA.fmt(cur.game, m.score);
    if (!cur.finished) {
      toast(cur.oppName + ' finished with ' + CA.fmt(cur.game, m.score) + '. Beat it!');
      cur.timers.push(setTimeout(forceEnd, Math.max(1500, m.deadlineIn - 2500)));
    }
  }

  /* time is up: stop the game and report the score so far */
  function forceEnd() { if (cur && !cur.finished && handle) handle.finishNow(); }

  function finishLocal(score) {
    if (!cur || cur.finished) return;
    if (cur.solo) return soloDone(score);
    cur.finished = true; cur.myScore = score;
    clearTimeout(cur.sendT);
    cur.timers.forEach(clearTimeout);
    net.send({ t: 'result', mid: cur.mid, score: score });
    setTimeout(function () { if (cur && cur.finished && !$('match').hidden) { CA.unmountGame(); showWaiting(); } }, 300);
  }

  function showWaiting() {
    var c = cur, res = $('result');
    var opp = c.oppFinal !== undefined ? CA.fmt(c.game, c.oppFinal) : c.oppLive !== null ? CA.fmt(c.game, c.oppLive) : '…';
    res.innerHTML = '<div class="result-card"><div class="wait-card"><div class="radar"><span>' + initial(myName()) + '</span></div>' +
      '<p class="big">' + (c.bot ? 'Scoring…' : 'Waiting for ' + CA.esc(c.oppName)) + '</p>' +
      (c.bot ? '' : '<p class="muted">They are still playing. Your result appears the moment they finish.</p>') + '</div>' +
      '<div class="vs-card"><div><span>You</span><b>' + (c.myScore === null ? '–' : CA.fmt(c.game, c.myScore)) + '</b></div>' +
      '<div><span>' + CA.esc(c.oppName) + '</span><b id="wOpp">' + (c.bot ? '?' : opp) + '</b></div></div></div>';
    show('result');
  }

  window.addEventListener('beforeunload', function (e) {
    if (cur && !cur.finished && !cur.solo) { e.preventDefault(); e.returnValue = ''; }
  });

  armed($('quitBtn'), 'Leave', 'Tap again: counts as a loss', function () {
    if (!cur) return backToLobby();
    if (cur.solo) return backToLobby();
    cur.timers.forEach(clearTimeout);
    CA.unmountGame();
    net.send({ t: 'forfeit', mid: cur.mid });
  });

  /* ============================================================ solo practice (no server) */
  var soloBest = {};
  try { soloBest = JSON.parse(localStorage.getItem('ca-practice') || '{}') || {}; } catch (e) { soloBest = {}; }

  function startSolo(g) {
    CA.unmountGame();
    var seed = Math.floor(Math.random() * 4294967296);
    game = g; busy = true;
    cur = { solo: true, mid: 'solo', game: g, finished: false, live: 0, oppLive: null, timers: [] };
    setDuel({ oppName: 'Practice', oppSub: 'Best ' + CA.fmt(g, soloBest[g] || 0), oppScore: soloBest[g] || 0, note: G[g].name + ' · practice · no coins at stake' });
    $('quitBtn').textContent = 'Leave';
    show('match');
    var my = cur;
    handle = CA.mountGame(g, { seed: seed, onScore: function (n) {
      onMyScore(n);
      if (soloBest[g]) updateRace(n, soloBest[g]);
    }, onDone: finishLocal });
    countdown(G[g].name, G[g].tip, 2400, function () { if (cur === my) handle.start(); });
  }

  function soloDone(score) {
    var g = cur.game, prev = soloBest[g], isBest = prev === undefined || score > prev;
    cur.finished = true;
    if (isBest) { soloBest[g] = score; try { localStorage.setItem('ca-practice', JSON.stringify(soloBest)); } catch (e) { /* ok */ } }
    setTimeout(function () {
      CA.unmountGame();
      var res = $('result');
      res.innerHTML = '<div class="result-card"><p class="muted">Practice run · ' + G[g].name + '</p>' +
        '<p class="result-title">' + CA.fmt(g, score) + '</p>' +
        (isBest && prev !== undefined ? '<p class="flag gold">New practice best!</p>' : '') +
        '<div class="vs-card"><div class="' + (isBest ? 'top' : '') + '"><span>This run</span><b>' + CA.fmt(g, score) + '</b></div>' +
        '<div class="' + (isBest ? '' : 'top') + '"><span>Practice best</span><b>' + CA.fmt(g, soloBest[g]) + '</b></div></div>' +
        '<p class="muted small">Practice runs never touch your coins or crowns.</p>' +
        '<div class="result-actions"><button class="btn btn-go" id="again" type="button">Practice again</button>' +
        '<div class="split"><button class="btn btn-soft" id="forReal" type="button">Play for coins</button>' +
        '<button class="btn btn-soft" id="back" type="button">Lobby</button></div></div></div>';
      cur = null; busy = false;
      show('result');
      if (isBest && prev !== undefined) CA.sfx('win'); else CA.sfx('tap');
      $('again').onclick = function () { startSolo(g); };
      $('forReal').onclick = function () { backToLobby(); game = g; renderPlay(); $('play').click(); };
      $('back').onclick = backToLobby;
    }, 250);
  }

  /* ============================================================ results (from the server) */
  var REASONS = {
    opp_left: 'Your opponent left, so you win by forfeit.',
    you_left: 'You left the match, so it counted as a loss.',
    invalid: 'Your score could not be accepted.',
    opp_invalid: 'Your opponent’s score could not be accepted.',
    timeout: 'Time ran out before your score arrived.',
    opp_timeout: 'Your opponent ran out of time.',
  };

  function showResult(m) {
    CA.unmountGame(); handle = null;
    if (cur && cur.timers) cur.timers.forEach(clearTimeout);
    if (m.blitz) return showBlitzResult(m);
    var g = m.game, win = m.outcome === 'win', draw = m.outcome === 'draw';
    var bef = CA.leagueIdx(m.crownsBefore), aft = CA.leagueIdx(m.crownsAfter);
    var flags = '';
    if (m.newBest && m.you !== null) flags += '<p class="flag gold">New personal best: ' + CA.fmt(g, m.you) + '</p>';
    if (aft > bef) flags += '<p class="flag good">Promoted to ' + CA.LEAGUES[aft][0] + '!</p>';
    if (aft < bef) flags += '<p class="flag bad">Dropped to ' + CA.LEAGUES[aft][0] + '.</p>';
    if (win && m.crownDelta > CA.WIN_CROWNS) flags += '<p class="flag good">🔥 ' + m.streak + ' wins in a row · +1 bonus crown</p>';

    var html = '<div class="result-card ' + (draw ? '' : win ? 'win' : 'loss') + '">' +
      '<p class="muted">' + G[g].name + ' · ' + m.stake + ' coins' + (m.bot ? ' · vs computer' : '') + '</p>' +
      '<p class="result-title">' + (draw ? 'Draw' : win ? 'You win!' : 'You lose') + '</p>' +
      (REASONS[m.reason] ? '<p class="reason">' + REASONS[m.reason] + '</p>' : '') +
      '<div class="delta-row"><span class="delta ' + (m.net > 0 ? 'up' : m.net < 0 ? 'down' : '') + '"><i class="ico-coin"></i><span id="dCoins">0</span></span>' +
      '<span class="delta ' + (m.crownDelta > 0 ? 'up' : m.crownDelta < 0 ? 'down' : '') + '"><i class="ico-crown"></i><span>' + (m.crownDelta > 0 ? '+' : '') + m.crownDelta + '</span></span></div>' +
      '<div class="vs-card"><div class="' + (win ? 'top' : '') + '"><span>You</span><b>' + CA.fmt(g, m.you) + '</b></div>' +
      '<div class="' + (!win && !draw ? 'top' : '') + '"><span>' + CA.esc(m.oppName) + '</span><b>' + CA.fmt(g, m.opp) + '</b></div></div>' +
      '<div class="ledger"><p><span>Stake</span><b>−' + m.stake + '</b></p><p><span>Payout</span><b>+' + m.payout + '</b></p>' +
      '<p><span>Crowns</span><b>' + m.crownsBefore + ' → ' + m.crownsAfter + '</b></p>' +
      (m.best !== undefined && m.best !== null ? '<p><span>Your best</span><b>' + CA.fmt(g, m.best) + '</b></p>' : '') + '</div>' +
      flags +
      '<div class="result-actions">' +
      (m.rematch ? '<button class="btn btn-go gold" id="rematch" type="button">Rematch ' + CA.esc(m.oppName) + '</button><div class="rematch-bar"><i id="rmBar"></i></div>' : '') +
      '<div class="split"><button class="btn ' + (m.rematch ? 'btn-soft' : 'btn-go') + '" id="again" type="button">New opponent</button>' +
      '<button class="btn btn-soft" id="back" type="button">Lobby</button></div></div></div>';

    var res = $('result');
    res.innerHTML = html;
    cur = null;
    busy = false;
    if (m.me) applyMe(m.me);
    show('result');
    CA.countTo($('dCoins'), 0, m.net, 900, function (v) { return (v > 0 ? '+' : '') + v; });
    if (win) { CA.sfx('win'); CA.confetti(); } else if (!draw) CA.sfx('lose');

    offer = null;
    if (m.rematch) {
      offer = { mid: m.mid, game: g, stake: m.stake, oppName: m.oppName };
      var bar = $('rmBar');
      requestAnimationFrame(function () { bar.style.transitionDuration = (m.rematch / 1000) + 's'; bar.style.width = '0%'; });
      $('rematch').onclick = function () {
        if (S.coins < m.stake) return toast('Not enough coins for a rematch.');
        net.send({ t: 'rematch', mid: m.mid });
      };
    }
    $('again').onclick = function () {
      if (S.coins < m.stake || !net.ready) return backToLobby();
      if (offer) { net.send({ t: 'rematch_no', mid: offer.mid }); offer = null; }
      game = g; stake = m.stake; busy = true; goFullscreen();
      net.send({ t: 'queue', game: g, stake: m.stake });
    };
    $('back').onclick = backToLobby;
    if (S.coins < m.stake) { $('again').disabled = true; $('again').textContent = 'Not enough coins'; }
  }

  function showBlitzResult(m) {
    var g = m.game, win = m.outcome === 'win', draw = m.outcome === 'draw';
    var title = m.reason !== 'score' ? 'No score' : win ? 'Blitz win!' : draw ? 'Break-even' : 'Short of break-even';
    var html = '<div class="result-card ' + (draw ? '' : win ? 'win' : 'loss') + '">' +
      '<p class="muted">⚡ Blitz · ' + G[g].name + ' · ' + m.stake + ' coins</p>' +
      '<p class="result-title">' + title + '</p>' +
      (REASONS[m.reason] ? '<p class="reason">' + REASONS[m.reason] + '</p>' : '') +
      '<div class="delta-row"><span class="delta ' + (m.net > 0 ? 'up' : m.net < 0 ? 'down' : '') + '"><i class="ico-coin"></i><span id="dCoins">0</span></span></div>' +
      '<div class="vs-card"><div class="' + (win ? 'top' : '') + '"><span>You</span><b>' + CA.fmt(g, m.you) + '</b></div>' +
      '<div><span>Break-even</span><b>' + CA.fmt(g, m.target) + '</b></div></div>' +
      '<div class="ledger"><p><span>Stake</span><b>−' + m.stake + '</b></p><p><span>Payout</span><b>+' + m.payout + '</b></p>' +
      '<p><span>Multiplier</span><b>×' + (Math.round(m.mult * 100) / 100) + '</b></p>' +
      (m.best !== undefined && m.best !== null ? '<p><span>Your best</span><b>' + CA.fmt(g, m.best) + '</b></p>' : '') + '</div>' +
      (m.newBest && m.you !== null ? '<p class="flag gold">New personal best: ' + CA.fmt(g, m.you) + '</p>' : '') +
      '<p class="muted small">Break-even for your next ' + G[g].name + ' Blitz: ' + CA.fmt(g, m.me.blitz[g]) + '. It follows your recent average.</p>' +
      '<div class="result-actions"><div class="split"><button class="btn btn-go" id="again" type="button">Blitz again</button>' +
      '<button class="btn btn-soft" id="back" type="button">Lobby</button></div></div></div>';
    var res = $('result');
    res.innerHTML = html;
    cur = null; busy = false;
    if (m.me) applyMe(m.me);
    show('result');
    CA.countTo($('dCoins'), 0, m.net, 900, function (v) { return (v > 0 ? '+' : '') + v; });
    if (win) { CA.sfx('win'); CA.confetti(); } else if (!draw) CA.sfx('lose'); else CA.sfx('coin');
    $('again').onclick = function () {
      if (S.coins < m.stake || !net.ready) return backToLobby();
      game = g; stake = m.stake; busy = true; goFullscreen();
      net.send({ t: 'blitz', game: g, stake: m.stake });
    };
    $('back').onclick = backToLobby;
    if (S.coins < m.stake) { $('again').disabled = true; $('again').textContent = 'Not enough coins'; }
  }

  function setRematchBtn(text, disabled) {
    var b = $('rematch');
    if (!b) return;
    b.textContent = text; b.disabled = !!disabled;
  }
  function onRematchOffer(m) {
    if (!offer || offer.mid !== m.mid) return;
    CA.sfx('coin');
    setRematchBtn('Accept rematch from ' + m.name, false);
    toast(m.name + ' wants a rematch!');
  }
  function onRematchOff(m) {
    if (!offer) return;
    offer = null;
    setRematchBtn(m.why === 'declined' ? 'Rematch declined' : m.why === 'gone' ? 'Opponent left' : 'Rematch expired', true);
  }

  /* ============================================================ boot */
  try {
    var q = new URLSearchParams(location.search).get('room');
    if (q && /^[A-Za-z0-9]{4}$/.test(q)) {
      joinCode = q.toUpperCase();
      history.replaceState(null, '', location.pathname);
    }
  } catch (e) { /* ok */ }

  renderMute();
  renderKey();
  initGoogle();
  show('lobby');
  net.connect();
  /* debug/testing hook */
  CA.app = { startSolo: startSolo, state: function () { return { S: S, cur: cur, busy: busy }; } };
})();
