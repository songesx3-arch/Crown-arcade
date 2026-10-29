# Crown Arcade 2.0

Free real-time 1v1 arcade skill duels in the browser. Two players pick the same game and stake, get the same seeded board, play at the same time, and the higher score takes the pot. Coins are virtual only, with no cash value and no real-money play.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # server protocol, payouts, rematch, reconnects, crash refunds
```

Node 18+, one dependency (`ws`). Deploy anywhere with WebSocket support (`render.yaml` and `Dockerfile` included). Run exactly one server instance and give `DATA_DIR` a persistent disk.

## Endless 3D games
Stack, Lane Dash and Road Hop no longer have a score ceiling; a run ends when you fail (or when the match time limit hits). The server plausibility check is a per-second rate, with very high ceilings.

## What changed in 2.0

**Gameplay and idea**
- **Rematch**: after a duel between two people, either can offer a rematch for 30 seconds. Both accept and a new match starts with the same game and stake.
- **Win streaks**: from the 3rd win in a row, each win earns +1 bonus crown (4 instead of 3). Streak and best streak show on the profile and ladder.
- **Fairer computer opponent**: it now plays around 82–108% of your own best instead of always beating it, so a player in form wins a little over half the time.
- **Match history**: the last 12 duels (opponent, scores, coins won or lost) are kept by the server and shown on the profile.
- **Orbit Tap**: dead-centre taps score a +1 Perfect bonus, combo counter, life cap is 3.
- **Stack**: four perfect drops in a row grow the block back a little.
- **Road Hop**: an "edge" meter shows how close the advancing screen is.
- **Lane Dash**: parked traffic added as an obstacle type, km/h readout, close-call bonus feedback.
- **Leave button** in matches (tap twice; counts as a loss), live score race bar, opponent "number to beat" alert, share sheet for room links, practice bests saved on the device, sound effects and haptics with a mute toggle.

**Graphics and design**
- New design system: Lilita One + Nunito, chunky pressable buttons, illustrated game cards, gold/cyan wallet chips, count-up animations, confetti on wins.
- Orbit Tap redrawn: glowing arc bars, gate beam, particles, shockwaves, idle timer ring, starfield. No `shadowBlur`, so it stays fast on phones.
- Stack: sky gradient that shifts with height, perfect-drop ripple, rounded pedestal.
- Lane Dash: synthwave night highway with a striped sun, scrolling neon grid, mountains, distance gantries, speed streaks, FOV kick.
- Road Hop: bright voxel daytime world, rounded cars/vans/trucks, logs, lily pads, a new chicken, blob shadows.
- The board is drawn before the countdown, and the countdown shows how to play.

**Code**
- The client is split into readable files instead of one 3,000-line HTML file:
  `public/css/app.css`, `public/js/{config,fx,three-kit,harness,net,app}.js`, `public/js/games/{orbit,stack,lane,hop}.js`.
- Every game uses the same small harness API (`score`, `end`, `aux`, `pop`, `fit`), so adding a fifth game is one file.
- CSP no longer needs `'unsafe-inline'` for scripts.
- Server tidied into clear sections; old save files are upgraded automatically on load.

## Design rules (unchanged)

Server-authoritative coins and results; escrow with crash refunds; queues keyed by game + stake with a computer opponent after 15–25 s; friend rooms by 4-character code or `?room=CODE`; same seed for both players; plausibility-only anti-cheat (caps, max rate, 2 s slack); guest keys stored as SHA-256 hashes plus optional Google sign-in; reconnect-safe matches, one tab per account, 190 s hard cap and 60 s grace; per-IP limits, rate limiting, 4 KB payloads, heartbeat, CSP and path-traversal protection.

## Protocol additions

Client → server: `rematch{mid}`, `rematch_no{mid}`.
Server → client: `rematch_offer{mid,name,stake,game}`, `rematch_wait{mid}`, `rematch_off{mid,why}`.
`result` now also carries `streak`, `newBest` and `rematch` (ms the offer stays open, 0 for computer matches). `me` carries `draws`, `streak`, `bestStreak`, `history` and `refillLeft`. New env var: `CA_REMATCH_MS`.

## Known limits

Plausibility-only anti-cheat; one server with JSON storage; guest + Google accounts only; three.js loads from cdnjs, so the 3D games need internet; free hosting tiers sleep and lose data without a persistent disk. Real-money play would need licensing, age and identity checks, payments and replay validation, none of which exist here.
