// Lobby Certified games: HTML5 game packages that run inside Lobby with lobby/multiplayer support.
// A package is a folder (or .zip of one) containing lobby-game.json + the game's files.
// Built-in packages ship in <app>/certified/, user-added ones are copied to <userData>/certified/.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024; // 1 GB
const MAX_FILES = 20000;

function readManifest(dir) {
  const file = path.join(dir, 'lobby-game.json');
  let m;
  try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(fs.existsSync(file) ? `lobby-game.json is not valid JSON (${e.message})` : 'No lobby-game.json found in that folder');
  }
  const err = (msg) => { throw new Error(`lobby-game.json: ${msg}`); };
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) err('"id" must be 3-40 chars: lowercase letters, numbers, dashes (e.g. "space-race")');
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 40) err('"name" is required (max 40 chars)');
  if (typeof m.version !== 'string' || !/^[0-9A-Za-z.+-]{1,20}$/.test(m.version)) err('"version" is required (e.g. "1.0.0")');
  const entry = m.entry === undefined ? 'index.html' : m.entry;
  if (typeof entry !== 'string' || !/\.html?$/i.test(entry)) err('"entry" must be an .html file');
  const minPlayers = m.minPlayers === undefined ? 1 : m.minPlayers;
  const maxPlayers = m.maxPlayers === undefined ? 8 : m.maxPlayers;
  if (!Number.isInteger(minPlayers) || minPlayers < 1 || minPlayers > 32) err('"minPlayers" must be 1-32');
  if (!Number.isInteger(maxPlayers) || maxPlayers < minPlayers || maxPlayers > 32) err('"maxPlayers" must be minPlayers-32');
  if (m.lobbyApi !== undefined && m.lobbyApi !== 1) err('"lobbyApi" must be 1 (this version of Lobby)');
  const clean = {
    id: m.id, name: m.name.trim(), version: m.version, entry,
    description: typeof m.description === 'string' ? m.description.slice(0, 300) : '',
    author: typeof m.author === 'string' ? m.author.slice(0, 60) : '',
    minPlayers, maxPlayers,
    solo: m.solo !== false, // can be played alone ("Practice")
    icon: typeof m.icon === 'string' ? m.icon : null,
    window: {
      width: Number.isInteger(m.window?.width) ? Math.min(Math.max(m.window.width, 320), 3840) : 1280,
      height: Number.isInteger(m.window?.height) ? Math.min(Math.max(m.window.height, 240), 2160) : 760,
    },
  };
  if (!safeJoin(dir, clean.entry) || !fs.existsSync(safeJoin(dir, clean.entry))) err(`entry file "${clean.entry}" not found`);
  if (clean.icon && (!safeJoin(dir, clean.icon) || !/\.(png|jpe?g|webp|svg)$/i.test(clean.icon))) clean.icon = null;
  return clean;
}

// Resolve a relative path inside a folder; null if it would escape the folder.
function safeJoin(root, rel) {
  const full = path.resolve(root, '.' + path.sep + String(rel).replace(/^[/\\]+/, ''));
  const r = path.resolve(root) + path.sep;
  return full.startsWith(r) ? full : null;
}

// Refuse symlinks/junctions and absurd sizes before copying anything.
function inspectTree(dir) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`Packages can't contain links/shortcuts (${e.name})`);
      if (st.isDirectory()) walk(full);
      else { bytes += st.size; files += 1; }
      if (bytes > MAX_PACKAGE_BYTES) throw new Error('Package is larger than 1 GB');
      if (files > MAX_FILES) throw new Error('Package has too many files');
    }
  };
  walk(dir);
}

class Certified {
  constructor(builtinDir, userDir) {
    this.builtinDir = builtinDir;
    this.userDir = userDir;
    fs.mkdirSync(userDir, { recursive: true });
  }

  _scan(root, builtin) {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      try {
        const m = readManifest(dir);
        if (m.id !== e.name) continue; // folder name must match id
        out.push({ ...m, builtin, dir });
      } catch { /* skip broken packages */ }
    }
    return out;
  }

  list() {
    const builtins = this._scan(this.builtinDir, true);
    const ids = new Set(builtins.map((g) => g.id));
    return [...builtins, ...this._scan(this.userDir, false).filter((g) => !ids.has(g.id))];
  }

  get(id) { return this.list().find((g) => g.id === id) || null; }

  resolveFile(id, rel) {
    const g = this.get(id);
    if (!g) return null;
    const f = safeJoin(g.dir, rel);
    if (!f) return null;
    try { return fs.statSync(f).isFile() ? f : null; } catch { return null; }
  }

  iconDataUrl(id) {
    const g = this.get(id);
    if (!g || !g.icon) return null;
    const f = safeJoin(g.dir, g.icon);
    try {
      const st = fs.statSync(f);
      if (st.size > 512 * 1024) return null;
      const ext = path.extname(f).slice(1).toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }[ext];
      return `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;
    } catch { return null; }
  }

  // Install from a folder: validate, then copy into userData/certified/<id>.
  addFolder(src) {
    const m = readManifest(src);
    if (this._scan(this.builtinDir, true).some((g) => g.id === m.id)) throw new Error(`"${m.id}" is a built-in game id; pick another id`);
    inspectTree(src);
    const dest = path.join(this.userDir, m.id);
    const tmp = dest + '.installing';
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.cpSync(src, tmp, { recursive: true, dereference: false, verbatimSymlinks: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    return m;
  }

  // Install from a .zip (uses Windows' built-in tar, which refuses ../ paths).
  addZip(zipFile) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lobby-pkg-'));
    try {
      // Always Windows' own bsdtar (Git's GNU tar on PATH misreads "C:" as a remote host).
      const tar = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'tar.exe');
      execFileSync(fs.existsSync(tar) ? tar : 'tar', ['-xf', zipFile, '-C', work], { windowsHide: true, timeout: 120000 });
      let root = work;
      if (!fs.existsSync(path.join(root, 'lobby-game.json'))) {
        // allow a single top-level folder inside the zip
        const kids = fs.readdirSync(work, { withFileTypes: true }).filter((e) => e.isDirectory());
        if (kids.length === 1 && fs.existsSync(path.join(work, kids[0].name, 'lobby-game.json'))) root = path.join(work, kids[0].name);
      }
      return this.addFolder(root);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  remove(id) {
    const g = this.get(id);
    if (!g) throw new Error('Game not found');
    if (g.builtin) throw new Error("Built-in games can't be removed");
    fs.rmSync(path.join(this.userDir, g.id), { recursive: true, force: true });
  }
}

module.exports = { Certified, readManifest, safeJoin };
