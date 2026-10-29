/* WebSocket connection with automatic reconnect. The account key lives in localStorage. */
(function () {
  'use strict';
  var CA = window.CA;
  var KEY_STORE = 'crown-arcade-account';
  var ws = null, tries = 0, retryT = null, pingT = null, stopped = false;

  var net = (CA.net = {
    ready: false,
    onMessage: function () {},
    onStatus: function () {}, /* (text|null) for the connection banner */
    onDown: function () {},
  });

  net.key = function () { try { return localStorage.getItem(KEY_STORE); } catch (e) { return null; } };
  net.setKey = function (k) { try { localStorage.setItem(KEY_STORE, k); } catch (e) { /* storage blocked */ } };
  net.dropKey = function () { try { localStorage.removeItem(KEY_STORE); } catch (e) { /* storage blocked */ } };

  net.send = function (o) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; }
    return false;
  };

  net.connect = function () {
    stopped = false;
    clearTimeout(retryT);
    var sock;
    try {
      sock = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    } catch (e) { return retry(); }
    ws = sock;
    sock.onopen = function () {
      var k = net.key();
      sock.send(JSON.stringify(k ? { t: 'hello', key: k } : { t: 'hello' }));
    };
    sock.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'welcome') {
        tries = 0; net.ready = true; net.onStatus(null);
        clearInterval(pingT);
        pingT = setInterval(function () { net.send({ t: 'ping' }); }, 20000);
      }
      net.onMessage(m);
    };
    sock.onclose = function () {
      if (sock !== ws) return;
      net.ready = false;
      clearInterval(pingT);
      net.onDown();
      if (!stopped) { net.onStatus('Connection lost. Reconnecting…'); retry(); }
    };
    sock.onerror = function () {};
  };

  /* stop reconnecting (another tab took over) */
  net.halt = function () {
    stopped = true; net.ready = false;
    clearTimeout(retryT); clearInterval(pingT);
    try { ws && ws.close(); } catch (e) { /* closed */ }
  };

  /* drop this socket and open a fresh one (after switching account key) */
  net.restart = function () {
    try { ws && ws.close(); } catch (e) { /* closed */ }
    setTimeout(net.connect, 60);
  };

  function retry() {
    tries++;
    clearTimeout(retryT);
    retryT = setTimeout(net.connect, Math.min(8000, 400 * Math.pow(1.7, tries)));
  }
})();
