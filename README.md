# Crown Arcade Online

Real-time 1v1 skill duels (Orbit Tap, Stack, Lane Dash, Road Hop) as a website with a Node server.
Virtual coins only. There is no cash play.

## Run it
    npm install
    npm start            # http://localhost:3000   (PORT=8080 to change)
    npm test

Open the site in two browsers, pick the same game and stake, press "Find opponent". Other modes: "Practice solo" (no opponent, no coins), "Play a friend" (4-character room code / invite link).

## Deploy
Any host that runs Node 18+ and supports WebSockets (Render, Railway, Fly.io, a VPS, Docker).
- Start command: `npm start`. Health check: `/healthz`.
- Put `DATA_DIR` on a persistent disk (accounts are stored in `players.json` there).
- Behind a proxy or load balancer set `TRUST_PROXY=1` so per-IP limits see real client addresses.
- Serve over HTTPS (the client switches to `wss://` automatically).
- Run ONE instance. Matchmaking and storage are in-process.

## Environment
PUBLIC_URL (e.g. https://your-site.example, enables sitemap.xml), PORT, HOST, DATA_DIR, TRUST_PROXY, CA_MAX_CONN_PER_IP (30), CA_MAX_NEW_ACCOUNTS_PER_HOUR (12), CA_MATCH_LIMIT_MS (190000), CA_GRACE_MS (60000).

## How it works
- The server owns coins, crowns and results. Stakes are held at match start; win pays 2x stake (+3 crowns), draw refunds, loss -1 crown.
- If nobody else joins a queue within 15-25 seconds, a bot opponent steps in (CA_QUEUE_BOT_MIN_MS / CA_QUEUE_BOT_MAX_MS).
- Both players get the same random seed, so the board is identical. Live opponent score is relayed.
- Guest accounts: a secret key is stored in the browser (Profile > Your account lets you copy it to another device). The server stores only its hash.

## Known limits
- Anti-cheat is plausibility checking (score caps and rate), not replay validation. A determined cheater can still submit a high believable score. Do not attach real value to it.
- Single server, JSON file storage, no user passwords or e-mail.
- three.js is loaded from cdnjs, so the 3D games need internet access (Orbit Tap works without it). Self-host it and add an SRI hash for production.
- Real-money play would need licensing, age/identity checks, payments and server-side replay validation. Not included.
