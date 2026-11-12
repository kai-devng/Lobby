# Building a Lobby Certified game

You are building a **Lobby Certified** game: a multiplayer HTML5 game that runs inside **Lobby**, a desktop
game launcher where friends host lobbies and play together. Read this whole file before writing code. If
you follow it exactly, the game will install with Lobby's **+** button and work in multiplayer on the
first try.

---

## 1. What you are making

- A **folder** (zipped for sharing) that contains `lobby-game.json` and normal web files (HTML/JS/CSS,
  images, audio, WASM).
- Lobby opens the game in **its own window** when the host presses Start, or when someone clicks "Play solo".
- The game talks to other players **only** through `window.lobbyGame`. That is Lobby's relay, and it
  passes JSON messages between the players in the lobby.
- The game runs in a **sandbox with no network**. `fetch`/XHR/WebSocket to the internet or localhost,
  remote images, CDNs, WebRTC, and peer-to-peer are all **blocked**. This is deliberate: it guarantees no
  player's IP address can leak. **Everything must be bundled in the folder.** No CDN script tags, no
  Google Fonts, no analytics.

Plain JavaScript is fine. So is any engine or framework that builds to static files (Phaser, PixiJS,
Three.js, Kaboom, Godot/Unity HTML5 exports, etc.) as long as the built files are **inside the folder** and
nothing loads from the internet.

---

## 2. Folder layout

```
my-game/                    <- folder name MUST equal the "id" in lobby-game.json
  lobby-game.json           <- required manifest
  index.html                <- entry page (name set by "entry")
  game.js                   <- your code (any number of files/folders)
  icon.png                  <- optional, square, 256x256 recommended, max 512 KB
  assets/...                <- images, sounds, fonts, models, wasm...
```

Limits: max 1 GB and 20,000 files, and **no symlinks/shortcuts**.

## 3. `lobby-game.json` (manifest)

```json
{
  "lobbyApi": 1,
  "id": "space-race",
  "name": "Space Race",
  "version": "1.0.0",
  "author": "Your Name",
  "description": "One or two sentences shown in Lobby.",
  "entry": "index.html",
  "icon": "icon.png",
  "minPlayers": 1,
  "maxPlayers": 8,
  "solo": true,
  "window": { "width": 1280, "height": 720 }
}
```

| Field | Rules |
|---|---|
| `lobbyApi` | Always `1`. |
| `id` | **Required.** 3-40 chars: lowercase letters, numbers, `-`. Must start with a letter/number. Must equal the folder name. Never change it after release (it's how lobbies match the game). |
| `name` | **Required.** Max 40 chars. |
| `version` | **Required.** e.g. `"1.0.0"`. Bump it on every release. Lobby warns players whose version differs from the host's. |
| `entry` | HTML file to open. Default `index.html`. |
| `icon` | Optional png/jpg/webp/svg path inside the folder. |
| `minPlayers`/`maxPlayers` | 1-32. |
| `solo` | `true` if the game can be played alone (shows a "Play solo" button). Default `true`. |
| `window` | Initial window size in px. The player can resize it, and F11 toggles fullscreen. **Your game must handle any window size** (scale a fixed-resolution canvas, or a responsive layout). |
| `description`, `author` | Optional text. |

## 4. The `window.lobbyGame` API (this is everything)

```js
const ctx = await lobbyGame.init();
// ctx = {
//   gameId:  "space-race",
//   solo:    false,                 // true = "Play solo": no one else, send() does nothing
//   isHost:  true,                  // true for the lobby host (and always true in solo)
//   hostId:  12,                    // user id of the host
//   me:      { id: 12, username: "Kai" },
//   members: [ { id: 12, username: "Kai" }, { id: 15, username: "Sam" } ]  // everyone in the lobby
// }

lobbyGame.send(data);               // send to EVERYONE else in the lobby
lobbyGame.send(data, userId);       // send to ONE player (e.g. to the host)
// data = any JSON-serializable value. Max 16 KB per message, max ~200 messages/second per player.
// Messages arrive in order and are not lost (reliable, like TCP). You never receive your own messages.

const off = lobbyGame.onMessage(({ from, data }) => { ... });
// from = sender's user id (set by Lobby, cannot be faked). data = what they sent.
// Returns an unsubscribe function.

lobbyGame.onMembers((members) => { ... });
// Fires when someone joins or leaves the lobby. members = [{ id, username }, ...] (the full current list).

lobbyGame.close();                  // close the game window (e.g. when the player presses Esc / "Quit")
```

Lifecycle facts:
- Call `init()` once at startup and wait for it before anything else.
- **Everyone's window opens at about the same time, but not exactly.** A player's first messages can arrive
  before another player's game has loaded and subscribed. Use the "hello" pattern (section 5). Don't
  assume everyone is listening at frame 1.
- If the **host closes** the game window, or the host ends the game in Lobby, **every** player's game
  window closes automatically. If a non-host leaves, only their window closes, and the host gets an
  `onMembers` update.
- There is no persistent server for your game. The host's game **is** the server. If you need
  "save data", keep it in `localStorage` (per game, per PC).

## 5. Required multiplayer pattern: host-authoritative

Use this unless you have a strong reason not to:

1. **The host owns the game state** (positions, scores, whose turn, RNG, timers, who hit whom).
2. **Non-hosts send their inputs/intentions to the host:** `lobbyGame.send({ t: 'input', ... }, ctx.hostId)`.
3. **The host validates inputs**, updates the state, and **broadcasts state** to everyone: `lobbyGame.send({ t: 'state', ... })`.
4. **Non-hosts render whatever the host says**, and accept state only from the host: `if (from !== ctx.hostId) return;`.
5. **Join handshake:** when a non-host starts, it sends `{ t: 'hello' }` to the host. It repeats this every
   500 ms until it receives the first state. The host answers a hello with the full current state.
6. **Solo mode:** `ctx.isHost` is true and `send()` is a no-op, so the same code path works alone. Add AI
   bots in solo if the game needs opponents.

Message-design rules:
- Give every message a type field: `{ t: 'state' | 'input' | 'hello' | ... }`.
- **Always validate incoming data.** It comes from another player's PC. Check types, clamp numbers,
  ignore unknown `t`, and on the host reject impossible inputs (too fast, out of bounds, not your turn).
- Keep messages small. Round floats (`Math.round(x)` or `+x.toFixed(2)`). Don't send what didn't change.
- Never put player names into `innerHTML`. Use `textContent` (names are typed by other people).

### Real-time action games (shooters, racers, platformers)

Relay latency is roughly ping to the server × 2 (often 30-150 ms). To make it feel instant:
- **Client-side prediction:** each player simulates **their own** movement locally and immediately, then
  sends their position (or inputs) to the host about 20-30×/s. The host sanity-checks it (max speed, walls)
  and sends a correction if it's impossible.
- **Interpolation:** draw *other* players about 100 ms in the past, blending between the last two network
  updates. Don't snap them to each new packet.
- **Events, not streams, for projectiles:** send "bullet fired at x,y angle a" once. Every client simulates
  the bullet locally. Only the host decides hits and damage and broadcasts them.
- Run the simulation on `setInterval(tick, 1000/60)`, not only in `requestAnimationFrame`. rAF pauses when
  a window is hidden, and the host must keep simulating for everyone.
- Host state broadcast: 20-30 Hz. Inputs: on change, or 20-30 Hz.

### Turn-based games (cards, board games, trivia)

- The host holds the full state, including hidden info (deck order, other hands). Send each player only
  what they may see (`send(privateData, playerId)`) and broadcast public state to everyone.
- Players send intentions (`{ t: 'play', card: 'Q♠' }`). The host checks it's their turn and it's legal.
- The host generates all randomness.

## 6. Sandbox rules (what will NOT work)

The page is served from `lobbygame://<id>/` with this Content-Security-Policy:

```
default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
worker-src 'self' blob:; frame-src 'none'; object-src 'none'
```

- ✅ Works: your own files via relative paths (`./assets/x.png`, `fetch('levels/1.json')`), canvas, WebGL,
  WebGPU, Web Audio, Gamepad API, Pointer Lock, fullscreen, `localStorage`, IndexedDB, Web Workers from
  your files, WASM, ES modules from your files (`<script type="module" src="main.js">`).
- ❌ Blocked: any `http(s)://`, `ws(s)://`, CDNs, remote fonts/images, iframes, `eval`-style code
  (`eval`, `new Function`; use `'wasm-unsafe-eval'` only for WASM), WebRTC, popups (`window.open`),
  navigating to other pages, camera/microphone/location, Node.js, and the file system.
- Use **relative paths** everywhere. No leading `/`, or use `./`. Paths are case-sensitive in some tools,
  so match file names exactly.
- If you use a bundler (Vite/webpack), set `base: './'` (relative), bundle all dependencies, and copy the
  **build output** plus `lobby-game.json` into the package folder.

## 7. Controls & UX checklist

- [ ] Works at any window size (letterbox a fixed canvas, or use a responsive layout).
- [ ] **Esc** opens a pause/quit menu or calls `lobbyGame.close()`. Tell players the key on screen.
- [ ] Shows a "Waiting for host…" or "Connecting…" state until the first host state arrives.
- [ ] Handles players leaving mid-game (`onMembers`): remove them, and don't crash.
- [ ] Handles a late joiner (the hello handshake).
- [ ] If `ctx.solo`, the game is still playable (bots, practice, or score attack).
- [ ] All assets are local. Search your code for `http` before shipping.
- [ ] No `innerHTML` with player-provided text.
- [ ] `version` bumped for each release.

## 8. Testing it in Lobby

1. In Lobby, go to **Library**, then **Lobby Certified**, then the **+** button, then **Add game folder**, and
   pick your game folder. (Re-adding the same `id` replaces the old copy. Do that after every change.)
2. Click the game, then **Play solo**, to test alone.
3. Multiplayer on one PC: run a second Lobby account (`Start Lobby (second account).bat` in the dev
   build, or a second profile). Have both add the game, then host a lobby with the game, invite, join, and
   Start.
4. **F12** in the game window opens DevTools (console errors, network, breakpoints).

## 9. Sharing it

Zip the **contents** of the folder (or the folder itself). `lobby-game.json` must be at the zip root or
inside one top-level folder. Friends install it with **+**, then **Add .zip package**. Everyone in a lobby
needs the same game id, and should have the same version.

## 10. Minimal working example

A complete small game is in `examples/tap-race/` (manifest + `index.html` + `game.js`). Copy its structure.
Here is the core skeleton:

```html
<!-- index.html -->
<!doctype html><html><head><meta charset="utf-8"><title>My Game</title></head>
<body><canvas id="c"></canvas><script src="game.js"></script></body></html>
```

```js
// game.js
(async () => {
  const G = window.lobbyGame;
  const ctx = await G.init();
  let state = { players: {}, started: false };          // host-authoritative state
  let gotState = ctx.isHost;

  if (ctx.isHost) for (const m of ctx.members) state.players[m.id] = { name: m.username, x: 100, y: 100, score: 0 };

  G.onMessage(({ from, data }) => {
    if (!data || typeof data !== 'object') return;
    if (ctx.isHost) {
      if (data.t === 'hello') G.send({ t: 'state', state }, from);
      if (data.t === 'input' && state.players[from]) {
        const p = state.players[from];
        p.x = Math.max(0, Math.min(1000, Number(data.x) || 0));   // validate + clamp
        p.y = Math.max(0, Math.min(600, Number(data.y) || 0));
      }
    } else if (from === ctx.hostId && data.t === 'state') {
      state = data.state; gotState = true;
    }
  });

  G.onMembers((members) => {
    if (!ctx.isHost) return;
    const ids = new Set(members.map((m) => String(m.id)));
    for (const m of members) state.players[m.id] ??= { name: m.username, x: 100, y: 100, score: 0 };
    for (const id of Object.keys(state.players)) if (!ids.has(id)) delete state.players[id];
  });

  if (!ctx.isHost) {
    const hello = setInterval(() => gotState ? clearInterval(hello) : G.send({ t: 'hello' }, ctx.hostId), 500);
    G.send({ t: 'hello' }, ctx.hostId);
  }

  setInterval(() => {                                       // 30 Hz network tick
    if (ctx.isHost) G.send({ t: 'state', state });
    else if (gotState) { const me = state.players[ctx.me.id]; if (me) G.send({ t: 'input', x: me.x, y: me.y }, ctx.hostId); }
  }, 1000 / 30);

  addEventListener('keydown', (e) => { if (e.key === 'Escape') G.close(); });
  // ...your update() + draw() loop here; move state.players[ctx.me.id] locally for instant feel...
})();
```

When you finish, give the user: the complete folder (all files), and a one-line summary of the controls.
