// Lobby desktop client - Electron main process.
const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, Menu, protocol, session, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { LobbyConnection } = require('./src/connection');
const { TunnelManager } = require('./src/tunnels');
const { Library } = require('./src/library');
const { Certified } = require('./src/certified');
const { startServer } = require('./src/server/core');

// Same data folder for the dev build and the installed app (%APPDATA%\lobby-client).
app.setPath('userData', path.join(app.getPath('appData'), 'lobby-client'));
// --profile=NAME runs a separate account/library (handy for testing two users on one PC).
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1].replace(/[^\w-]/g, '') : '';
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile}`);

// Optional build config (lets a release ship with your group's server address pre-filled).
let buildConfig = {};
try { buildConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'lobby.config.json'), 'utf8')); } catch {}

const DATA = app.getPath('userData');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const DEFAULT_PORT = 47420;
const DEFAULT_SERVER = typeof buildConfig.defaultServer === 'string' ? buildConfig.defaultServer : `ws://127.0.0.1:${DEFAULT_PORT}`;

let settings = { serverUrl: DEFAULT_SERVER, tokenEnc: null, hostServer: { enabled: false, lan: false, port: DEFAULT_PORT } };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
function saveSettings() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// Session token is encrypted with Windows DPAPI (safeStorage) so it isn't readable as plain text.
function storeToken(token) {
  if (!token) settings.tokenEnc = null;
  else if (safeStorage.isEncryptionAvailable()) settings.tokenEnc = 'enc:' + safeStorage.encryptString(token).toString('base64');
  else settings.tokenEnc = null; // don't persist plaintext tokens
  saveSettings();
}
function loadToken() {
  const v = settings.tokenEnc;
  if (!v || !v.startsWith('enc:')) return null;
  try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); } catch { return null; }
}

// Lobby Certified games are served from their own scheme so each game gets its own origin and a
// strict Content-Security-Policy. Must be registered before the app is ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'lobbygame', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const conn = new LobbyConnection();
const library = new Library(path.join(DATA, 'library.json'));
const certified = new Certified(path.join(__dirname, 'certified'), path.join(DATA, 'certified'));
let win = null;
let tunnels = null;
const iconCache = new Map();

const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 840, minWidth: 980, minHeight: 620,
    backgroundColor: '#0e1116',
    title: profile ? `Lobby (${profile})` : 'Lobby',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false, // keep relays/hosted games running when minimized
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Never open external pages inside the app; never navigate away from our UI.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.on('closed', () => { win = null; app.quit(); });
}

// ------------------------------------------------------------------ certified game sandbox
// Games run in their own session with NO network access: every http/https/ws request is blocked,
// WebRTC can't open UDP (no STUN IP leaks), and no permissions (camera, mic, location...) are granted.
// The only way a game talks to anyone is window.lobbyGame, which goes through the Lobby relay.
const GAME_CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:", "connect-src 'self'",
  "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
const MIME = {
  html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', wasm: 'application/wasm', txt: 'text/plain',
  glb: 'model/gltf-binary', gltf: 'model/gltf+json', bin: 'application/octet-stream',
};
let gameSession = null;
function setupGameSession() {
  gameSession = session.fromPartition('persist:lobbygames');
  gameSession.protocol.handle('lobbygame', async (req) => {
    try {
      const u = new URL(req.url);
      const rel = decodeURIComponent(u.pathname);
      const file = certified.resolveFile(u.hostname, rel === '/' ? '/index.html' : rel);
      if (!file) return new Response('Not found', { status: 404 });
      const data = await fs.promises.readFile(file);
      const ext = path.extname(file).slice(1).toLowerCase();
      return new Response(data, { headers: {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-security-policy': GAME_CSP,
        'x-content-type-options': 'nosniff',
      } });
    } catch { return new Response('Error', { status: 500 }); }
  });
  gameSession.webRequest.onBeforeRequest({ urls: ['*://*/*', 'file:///*'] }, (_d, cb) => cb({ cancel: true }));
  gameSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen' || perm === 'pointerLock'));
  gameSession.setPermissionCheckHandler((_wc, perm) => perm === 'fullscreen' || perm === 'pointerLock');
}

let gameWin = null;
let gameCtx = null;
const sendGame = (ch, payload) => { if (gameWin && !gameWin.isDestroyed()) gameWin.webContents.send(ch, payload); };

function openGameWindow(ctx) {
  const game = certified.get(ctx.gameId);
  if (!game) throw new Error("That game isn't installed");
  if (gameWin && !gameWin.isDestroyed()) {
    if (gameCtx && gameCtx.gameId === ctx.gameId && gameCtx.solo === ctx.solo && gameCtx.hostId === ctx.hostId) { gameWin.focus(); return; }
    closeGameWindow(true);
  }
  gameCtx = ctx;
  const myCtx = ctx; // this window's own context (gameCtx may already point at a newer window)
  const w = new BrowserWindow({
    width: game.window.width, height: game.window.height, minWidth: 480, minHeight: 320,
    backgroundColor: '#05070a', title: game.name, autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'game-preload.js'),
      session: gameSession,
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      spellcheck: false, backgroundThrottling: false,
    },
  });
  w.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  gameWin = w;
  w.loadURL(`lobbygame://${game.id}/${game.entry.split(/[\\/]/).map(encodeURIComponent).join('/')}`);
  w.once('ready-to-show', () => { w.show(); w.focus(); });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`lobbygame://${game.id}/`)) e.preventDefault(); });
  w.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') w.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.key === 'F11') w.setFullScreen(!w.isFullScreen());
  });
  w.on('closed', () => {
    const c = myCtx;
    if (gameWin === w) { gameWin = null; gameCtx = null; }
    // Host closed the game window: end the match for everyone.
    if (c && !c.solo && !c.closedByServer && conn.user && c.hostId === conn.user.id) {
      conn.request('lobby.stop', {}).catch(() => {});
    }
    send('game:closed', {});
  });
}

function closeGameWindow(byServer) {
  if (!gameWin || gameWin.isDestroyed()) return;
  if (gameCtx && byServer) gameCtx.closedByServer = true;
  gameWin.close();
}

// ------------------------------------------------------------------ hosting a server from the app
const hosting = { server: null, error: null, starting: false, tunnel: null, tunnelUrl: null, tunnelError: null };

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function findCloudflared() {
  const names = ['cloudflared.exe', 'cloudflared'];
  const dirs = (process.env.PATH || '').split(path.delimiter).concat([
    'C:\\Program Files (x86)\\cloudflared', 'C:\\Program Files\\cloudflared',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links'),
  ]);
  for (const d of dirs) for (const n of names) {
    const f = path.join(d, n);
    try { if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

function hostingState() {
  const h = settings.hostServer;
  return {
    enabled: h.enabled, lan: h.lan, port: h.port, running: !!hosting.server, starting: hosting.starting, error: hosting.error,
    localUrl: `ws://127.0.0.1:${h.port}`,
    lanUrls: h.lan ? lanAddresses().map((a) => `ws://${a}:${h.port}`) : [],
    cloudflared: !!findCloudflared(), tunnelRunning: !!hosting.tunnel, tunnelUrl: hosting.tunnelUrl, tunnelError: hosting.tunnelError,
  };
}
const pushHosting = () => send('hosting:state', hostingState());

async function startHosting() {
  if (hosting.server || hosting.starting) return;
  hosting.starting = true; hosting.error = null; pushHosting();
  try {
    const h = settings.hostServer;
    hosting.server = await startServer({
      port: h.port, host: h.lan ? '0.0.0.0' : '127.0.0.1', dataDir: path.join(DATA, 'server-data'),
      trustProxy: true, log: (...a) => console.log(...a),
    });
  } catch (e) {
    hosting.error = e.code === 'EADDRINUSE' ? `Port ${settings.hostServer.port} is already in use (another Lobby server may already be running).` : e.message;
  }
  hosting.starting = false;
  pushHosting();
}

async function stopHosting() {
  stopTunnel();
  const s = hosting.server;
  hosting.server = null;
  if (s) await s.close();
  pushHosting();
}

function startTunnel() {
  if (hosting.tunnel) return;
  const exe = findCloudflared();
  if (!exe) { hosting.tunnelError = 'cloudflared is not installed'; pushHosting(); return; }
  hosting.tunnelError = null; hosting.tunnelUrl = null;
  const p = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${settings.hostServer.port}`], { windowsHide: true });
  hosting.tunnel = p;
  const scan = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !hosting.tunnelUrl) { hosting.tunnelUrl = m[0].replace('https://', 'wss://'); pushHosting(); }
  };
  p.stdout.on('data', scan); p.stderr.on('data', scan);
  p.on('exit', (code) => {
    if (hosting.tunnel === p) { hosting.tunnel = null; hosting.tunnelUrl = null; if (code) hosting.tunnelError = `cloudflared stopped (code ${code})`; pushHosting(); }
  });
  p.on('error', (e) => { hosting.tunnelError = e.message; hosting.tunnel = null; pushHosting(); });
  pushHosting();
}
function stopTunnel() {
  const p = hosting.tunnel;
  hosting.tunnel = null; hosting.tunnelUrl = null;
  if (p) try { p.kill(); } catch {}
}

// ------------------------------------------------------------------ startup
app.whenReady().then(async () => {
  setupGameSession();
  tunnels = new TunnelManager(conn, (state) => send('tunnels:state', state));

  conn.on('status', (s) => send('net:status', { ...s, serverUrl: conn.url }));
  conn.on('auth', (a) => {
    if (a.token) storeToken(a.token);
    if (a.clearToken) storeToken(null);
    send('net:auth', { user: a.user, friends: a.friends, error: a.error });
    if (a.user) pushPresence();
  });
  conn.on('event', (e, d) => {
    if (e === 'game.msg') { sendGame('gamewin:msg', d); return; } // straight to the game window
    if (e === 'lobby.state') sendGame('gamewin:members', d.members.map((m) => ({ id: m.id, username: m.username })));
    if ((e === 'lobby.stopped' || e === 'lobby.left') && gameCtx && !gameCtx.solo) closeGameWindow(true);
    send('net:event', { e, d });
  });
  conn.on('status', (s) => { if (!s.connected && gameCtx && !gameCtx.solo) closeGameWindow(true); });

  library.on('changed', () => send('library:changed', library.list()));
  library.on('launch', () => pushPresence());
  library.on('exit', (g, err) => { pushPresence(); if (err) send('toast', { kind: 'error', text: `${g.name}: ${err}` }); });

  createWindow();
  if (settings.hostServer.enabled) await startHosting();
  conn.connect(settings.serverUrl, loadToken());
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { stopTunnel(); });

function pushPresence() {
  if (!conn.user) return;
  const running = library.list().find((g) => g.running);
  conn.request('presence.set', { game: running ? running.name : null }).catch(() => {});
}

// ------------------------------------------------------------------ IPC
// Every handler validates its own input. The renderer can only reach the server through an
// allowlist of operations; tunnel/stream/auth plumbing stays in the main process.
const RENDERER_OPS = new Set([
  'friends.list', 'friends.request', 'friends.accept', 'friends.decline', 'friends.remove', 'dm.send',
  'presence.set', 'lobby.create', 'lobby.invite', 'lobby.join', 'lobby.decline', 'lobby.leave', 'lobby.kick',
  'lobby.ready', 'lobby.chat', 'lobby.start', 'lobby.stop', 'profile.avatar',
]);

// Main-window handlers: only our own UI (file://) may call them. Game windows can't.
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
  if (!win || e.sender !== win.webContents) throw new Error('Blocked');
  return fn(...args);
});

function setServerUrl(url) {
  settings.serverUrl = url;
  saveSettings();
  conn.disconnect();
  conn.connect(url, loadToken());
}

handle('net:state', () => ({ connected: conn.connected, user: conn.user, serverUrl: settings.serverUrl, profile, version: app.getVersion() }));
handle('net:setServer', (url) => {
  url = String(url || '').trim();
  if (!/^wss?:\/\/[^\s]+$/i.test(url)) throw new Error('Server address must start with ws:// or wss://');
  setServerUrl(url);
  return { serverUrl: url, insecure: url.startsWith('ws://') && !/^ws:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url) };
});
handle('net:login', (u, p) => conn.login('auth.login', String(u || ''), String(p || '')).then(() => true));
handle('net:register', (u, p) => conn.login('auth.register', String(u || ''), String(p || '')).then(() => true));
handle('net:logout', async () => {
  closeGameWindow(true);
  await conn.logout();
  storeToken(null);
  conn.disconnect();
  conn.connect(settings.serverUrl, null);
  return true;
});
handle('net:req', (op, d) => {
  if (!RENDERER_OPS.has(op)) throw new Error('Not allowed');
  return conn.request(op, d && typeof d === 'object' ? d : {});
});

// ----- profile photo: any image -> centered square -> 128px PNG (re-encoding strips EXIF/location)
handle('profile:pickAvatar', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a profile photo', properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  if (fs.statSync(r.filePaths[0]).size > 25 * 1024 * 1024) throw new Error('That image is over 25 MB');
  let img = nativeImage.createFromPath(r.filePaths[0]);
  if (img.isEmpty()) throw new Error("Couldn't read that image. Try a PNG or JPG.");
  const { width, height } = img.getSize();
  const side = Math.min(width, height);
  img = img.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side })
    .resize({ width: 128, height: 128, quality: 'best' });
  const png = img.toPNG();
  return conn.request('profile.setAvatar', { data: png.toString('base64') });
});
handle('profile:clearAvatar', () => conn.request('profile.setAvatar', { data: null }));

// ----- certified games
const certInfo = (g) => ({
  id: g.id, name: g.name, version: g.version, description: g.description, author: g.author,
  minPlayers: g.minPlayers, maxPlayers: g.maxPlayers, solo: g.solo, builtin: g.builtin, icon: certified.iconDataUrl(g.id),
});
handle('certified:list', () => certified.list().map(certInfo));
handle('certified:add', async (kind) => {
  const zip = kind === 'zip';
  const r = await dialog.showOpenDialog(win, zip
    ? { title: 'Add a Lobby Certified game (.zip)', properties: ['openFile'], filters: [{ name: 'Lobby game package', extensions: ['zip'] }] }
    : { title: 'Pick the game folder (contains lobby-game.json)', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const m = zip ? certified.addZip(r.filePaths[0]) : certified.addFolder(r.filePaths[0]);
  send('certified:changed', certified.list().map(certInfo));
  return certInfo(certified.get(m.id));
});
handle('certified:remove', (id) => {
  if (gameCtx && gameCtx.gameId === id) closeGameWindow(true);
  certified.remove(String(id));
  send('certified:changed', certified.list().map(certInfo));
  return true;
});
handle('certified:reveal', (id) => {
  const g = certified.get(String(id));
  if (g) shell.openPath(g.dir);
  return true;
});

handle('game:open', (o) => {
  o = o && typeof o === 'object' ? o : {};
  const solo = o.solo === true;
  const gameId = String(o.gameId || '');
  const me = conn.user || { id: 0, username: 'You' };
  if (!solo && !conn.user) throw new Error('Not logged in');
  const members = Array.isArray(o.members) ? o.members.slice(0, 32)
    .filter((m) => m && Number.isInteger(m.id) && typeof m.username === 'string')
    .map((m) => ({ id: m.id, username: m.username.slice(0, 30) })) : [];
  const hostId = solo ? me.id : Number(o.hostId);
  if (!solo && !Number.isInteger(hostId)) throw new Error('Bad host');
  openGameWindow({ gameId, solo, hostId, me: { id: me.id, username: me.username }, members: solo ? [] : members });
  return true;
});
ipcMain.handle('gamewin:init', (e) => {
  if (!gameWin || e.sender !== gameWin.webContents || !gameCtx) return null;
  return {
    gameId: gameCtx.gameId, solo: gameCtx.solo, hostId: gameCtx.hostId, isHost: gameCtx.solo || gameCtx.hostId === gameCtx.me.id,
    me: gameCtx.me, members: gameCtx.solo ? [gameCtx.me] : gameCtx.members,
  };
});
ipcMain.on('gamewin:send', (e, data, to) => {
  if (!gameWin || e.sender !== gameWin.webContents || !gameCtx || gameCtx.solo) return;
  conn.fire('game.send', Number.isInteger(to) ? { data, to } : { data });
});
ipcMain.handle('gamewin:close', (e) => {
  if (gameWin && e.sender === gameWin.webContents) gameWin.close();
  return true;
});

// ----- hosting
handle('hosting:state', () => hostingState());
handle('hosting:set', async (o) => {
  o = o && typeof o === 'object' ? o : {};
  const h = settings.hostServer;
  const wasRunning = !!hosting.server;
  if (typeof o.lan === 'boolean' && o.lan !== h.lan) { h.lan = o.lan; if (wasRunning) { await stopHosting(); } }
  if (typeof o.enabled === 'boolean') h.enabled = o.enabled;
  saveSettings();
  if (h.enabled) {
    await startHosting();
    // Point this app at the server it now hosts (if it isn't already).
    if (hosting.server && !/^ws:\/\/(127\.0\.0\.1|localhost):/.test(settings.serverUrl)) setServerUrl(`ws://127.0.0.1:${h.port}`);
  } else {
    await stopHosting();
  }
  return hostingState();
});
handle('hosting:tunnel', (on) => { if (on) startTunnel(); else { stopTunnel(); pushHosting(); } return hostingState(); });

// ----- library
handle('library:list', () => library.list());
handle('library:addDialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add games to Lobby', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Games', extensions: ['exe'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => library.add(p));
});
// Only accept paths that the scan just returned (renderer can't add arbitrary paths).
let lastScan = new Set();
handle('library:scanDialog', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Pick a folder that contains games', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  const found = library.scan(r.filePaths[0]);
  lastScan = new Set(found.map((f) => f.exePath));
  return { root: r.filePaths[0], found };
});
handle('library:addScanned', (items) => {
  if (!Array.isArray(items)) return [];
  return items.filter((i) => i && lastScan.has(i.exePath)).map((i) => library.add(i.exePath, typeof i.name === 'string' ? i.name : undefined));
});
handle('library:update', (id, fields) => library.update(String(id), fields || {}));
handle('library:remove', (id) => library.remove(String(id)));
handle('library:launch', (id) => { library.launch(String(id)); return true; });
handle('library:stop', (id) => { library.stop(String(id)); return true; });
handle('library:reveal', (id) => { const g = library.get(String(id)); if (g) shell.showItemInFolder(g.exePath); return true; });
handle('library:openMods', (id) => {
  const g = library.get(String(id));
  if (g?.modsDir && fs.existsSync(g.modsDir)) shell.openPath(g.modsDir);
  return true;
});
handle('library:pickMods', async (id) => {
  const g = library.get(String(id));
  if (!g) return null;
  const r = await dialog.showOpenDialog(win, { title: `Mods folder for ${g.name}`, defaultPath: path.dirname(g.exePath), properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return library.update(g.id, { modsDir: r.filePaths[0] });
});
handle('library:mods', (id) => {
  const g = library.get(String(id));
  if (!g?.modsDir) return [];
  try {
    return fs.readdirSync(g.modsDir, { withFileTypes: true }).slice(0, 300).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch { return []; }
});
handle('library:icon', async (id) => {
  const g = library.get(String(id));
  if (!g) return null;
  if (iconCache.has(g.exePath)) return iconCache.get(g.exePath);
  try {
    const img = await app.getFileIcon(g.exePath, { size: 'large' });
    const url = img.toDataURL();
    iconCache.set(g.exePath, url);
    return url;
  } catch { return null; }
});

// ----- relay tunnels
handle('tunnel:share', (proto, port, label) => tunnels.share(proto, port, label));
handle('tunnel:unshare', (id) => tunnels.unshare(String(id)));
handle('tunnel:connect', (id, proto, localPort) => tunnels.connect(String(id), proto === 'udp' ? 'udp' : 'tcp', localPort));
handle('tunnel:disconnect', (id) => { tunnels.disconnectTunnel(String(id)); return true; });
handle('tunnel:state', () => tunnels.state());

handle('app:openExternal', (url) => { if (/^https:\/\/[^\s]+$/.test(String(url))) shell.openExternal(String(url)); return true; });
