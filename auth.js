'use strict';
/* Verifies a "Sign in with Google" ID token (a signed JWT) without any extra packages. */
const crypto = require('crypto');

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
let cache = { keys: null, at: 0 };

async function defaultFetchJwks() {
  const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('jwks http ' + res.status);
  return (await res.json()).keys || [];
}

async function getKeys(fetchJwks, force) {
  if (!force && cache.keys && Date.now() - cache.at < 3600000) return cache.keys;
  cache = { keys: await fetchJwks(), at: Date.now() };
  return cache.keys;
}

const b64 = (s) => Buffer.from(s, 'base64url');

/* Returns { sub, name } or throws. opts: clientId, fetchJwks (tests), nowSec (tests). */
async function verifyGoogleIdToken(token, opts) {
  const clientId = opts.clientId;
  if (!clientId) throw new Error('google sign-in is not configured');
  if (typeof token !== 'string' || token.length > 4096) throw new Error('bad token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  let header, payload;
  try { header = JSON.parse(b64(parts[0]).toString()); payload = JSON.parse(b64(parts[1]).toString()); } catch (e) { throw new Error('bad token'); }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad algorithm');
  const fetchJwks = opts.fetchJwks || defaultFetchJwks;
  let keys = await getKeys(fetchJwks, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getKeys(fetchJwks, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('unknown signing key');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), pub, b64(parts[2]));
  if (!ok) throw new Error('bad signature');
  const now = opts.nowSec || Math.floor(Date.now() / 1000);
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') throw new Error('bad issuer');
  if (payload.aud !== clientId) throw new Error('wrong audience');
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) throw new Error('expired');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('no subject');
  return { sub: payload.sub, name: typeof payload.given_name === 'string' ? payload.given_name : '' };
}

function resetCache() { cache = { keys: null, at: 0 }; }

module.exports = { verifyGoogleIdToken, resetCache };
