/* Shared three.js helpers: renderer setup, cached rounded boxes and materials, cleanup. */
(function () {
  'use strict';
  var CA = window.CA;
  var K = (CA.three = {});
  var ok = null;

  K.available = function () {
    if (ok !== null) return ok;
    ok = false;
    try {
      if (typeof THREE !== 'undefined') {
        var c = document.createElement('canvas');
        ok = !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
      }
    } catch (e) { ok = false; }
    return ok;
  };

  K.renderer = function (canvas, W, H, opts) {
    var ren = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: !!(opts && opts.alpha) });
    ren.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    ren.setSize(W, H, false);
    if (opts && opts.shadows) {
      ren.shadowMap.enabled = true;
      ren.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    return ren;
  };

  K.dispose = function (ren) {
    try { ren.dispose(); if (ren.forceContextLoss) ren.forceContextLoss(); } catch (e) { /* gone */ }
  };

  /*
   * A box with chamfered-round edges. Built from a segmented BoxGeometry whose
   * vertices are pulled onto a rounded shell; normals point out from the inner box,
   * so flat faces stay flat and edges shade smoothly.
   */
  var RB = {};
  K.rbox = function (w, h, d, r) {
    var key = [w, h, d, r].join('_');
    if (RB[key]) return RB[key];
    r = Math.min(r, w / 2, h / 2, d / 2);
    var seg = function (s) { return Math.max(2, Math.min(8, Math.round(s / Math.max(r, 0.01)) + 1)); };
    var g = new THREE.BoxGeometry(w, h, d, seg(w), seg(h), seg(d));
    var pos = g.attributes.position, nor = g.attributes.normal;
    var hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
    var v = new THREE.Vector3(), inner = new THREE.Vector3(), n = new THREE.Vector3();
    for (var i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      inner.set(CA.clamp(v.x, -hx, hx), CA.clamp(v.y, -hy, hy), CA.clamp(v.z, -hz, hz));
      n.subVectors(v, inner);
      if (n.lengthSq() < 1e-9) n.fromBufferAttribute(nor, i); else n.normalize();
      pos.setXYZ(i, inner.x + n.x * r, inner.y + n.y * r, inner.z + n.z * r);
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    pos.needsUpdate = true; nor.needsUpdate = true;
    RB[key] = g;
    return g;
  };

  /* Material and geometry caches. Shared across games, never disposed (they are small). */
  var LAM = {}, BAS = {}, GEO = {};
  K.lam = function (c) { return LAM[c] || (LAM[c] = new THREE.MeshLambertMaterial({ color: c })); };
  K.basic = function (c) { return BAS[c] || (BAS[c] = new THREE.MeshBasicMaterial({ color: c })); };
  K.geo = function (key, make) { return GEO[key] || (GEO[key] = make()); };

  K.mesh = function (geo, mat, x, y, z, parent) {
    var m = new THREE.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    if (parent) parent.add(m);
    return m;
  };
  /* rounded box mesh in one call */
  K.rb = function (w, h, d, r, color, x, y, z, parent) {
    return K.mesh(K.rbox(w, h, d, r), typeof color === 'number' ? K.lam(color) : color, x, y, z, parent);
  };

  /* A vertical gradient as a texture, for sky backgrounds. stops: [[0,'#hex'],[1,'#hex']] */
  K.gradientTexture = function (stops, w, h, draw) {
    var c = document.createElement('canvas');
    c.width = w || 4; c.height = h || 256;
    var x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, c.height);
    stops.forEach(function (s) { g.addColorStop(s[0], s[1]); });
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    if (draw) draw(x, c.width, c.height);
    var t = new THREE.CanvasTexture(c);
    return t;
  };

  /* Soft round blob shadow texture, shared. */
  var blob = null;
  K.blobMaterial = function (opacity) {
    if (!blob) {
      var c = document.createElement('canvas'); c.width = c.height = 64;
      var x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 2, 32, 32, 31);
      g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(0, 0, 64, 64);
      blob = new THREE.CanvasTexture(c);
    }
    return new THREE.MeshBasicMaterial({ map: blob, transparent: true, opacity: opacity || 0.35, depthWrite: false });
  };

  /* Remove every child of a group from the scene graph (geometry/material are cached, so not disposed). */
  K.clear = function (obj) { while (obj.children.length) obj.remove(obj.children[0]); };
})();
