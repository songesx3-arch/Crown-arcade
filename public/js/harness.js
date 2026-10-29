/*
 * Game harness: builds the stage (HUD, canvas, pop-up text, countdown) and gives each
 * game a small API. A game module is a function CA.games[key](api) that sets up its
 * board and returns { start(), stop() }. The board is drawn before start() so players
 * can see it during the countdown.
 *
 * api.score(n)  report the score (updates HUD, relays to the server)
 * api.end(n)    the run is over (call once)
 * api.aux(html) right side of the HUD (lives, speed ...)
 * api.pop(text) floating text over the board
 * api.fit(r)    size the canvas to the stage at aspect ratio r (width / height)
 */
(function () {
  'use strict';
  var CA = window.CA;
  CA.games = CA.games || {};

  var current = null;

  CA.mountGame = function (key, opts) {
    CA.unmountGame();
    var stage = CA.$('stage');
    var info = CA.GAMES[key];
    stage.innerHTML =
      '<div class="hud"><div class="hud-score"><span>' + info.label + '</span><b id="hudScore">0</b></div>' +
      '<div class="hud-aux" id="hudAux"></div></div>' +
      '<div class="fitbox" id="fitbox"><canvas id="cv"></canvas><div class="pop" id="pop"></div></div>';

    var box = CA.$('fitbox'), canvas = CA.$('cv'), popEl = CA.$('pop');
    var ended = false, started = false, last = -1, ratio = 1, popT = null;

    function fitNow() {
      var rc = box.getBoundingClientRect();
      var w = Math.min(rc.width, rc.height * ratio);
      if (w < 1) return;
      canvas.style.width = Math.floor(w) + 'px';
      canvas.style.height = Math.floor(w / ratio) + 'px';
    }
    window.addEventListener('resize', fitNow);

    var api = {
      key: key,
      seed: opts.seed,
      rng: CA.rng(opts.seed),
      canvas: canvas,
      box: box,
      stage: stage,
      fit: function (r) { ratio = r; fitNow(); },
      alive: function () { return !ended && current === handle; },
      running: function () { return started && !ended && current === handle; },
      score: function (n) {
        n = Math.floor(n);
        if (n === last || ended) return;
        last = n;
        var el = CA.$('hudScore');
        if (el) el.textContent = n;
        if (opts.onScore) opts.onScore(n);
      },
      aux: function (html) { var el = CA.$('hudAux'); if (el) el.innerHTML = html; },
      pop: function (text, color) {
        popEl.textContent = text;
        popEl.style.color = color || '#fff';
        popEl.classList.remove('show');
        void popEl.offsetWidth;
        popEl.classList.add('show');
        clearTimeout(popT);
        popT = setTimeout(function () { popEl.classList.remove('show'); }, 900);
      },
      controls: function (html) {
        var d = document.createElement('div');
        d.innerHTML = html;
        stage.appendChild(d.firstElementChild);
        fitNow();
        return stage.lastElementChild;
      },
      end: function (n) {
        if (ended) return;
        ended = true;
        if (opts.onDone) opts.onDone(Math.floor(n));
      },
      sfx: CA.sfx,
      buzz: CA.buzz,
    };

    var game = CA.games[key](api);
    var handle = {
      key: key,
      api: api,
      start: function () { if (started || ended) return; started = true; game.start(); },
      /* stop the run from outside (time limit) and report what was scored so far */
      finishNow: function () { if (!ended) { api.end(Math.max(0, last)); } },
      lastScore: function () { return Math.max(0, last); },
      stop: function () {
        ended = true;
        window.removeEventListener('resize', fitNow);
        try { game.stop(); } catch (e) { /* already torn down */ }
      },
    };
    current = handle;
    return handle;
  };

  CA.unmountGame = function () {
    if (current) { var c = current; current = null; c.stop(); }
  };
})();
