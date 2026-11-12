// Local game library: just .exe files on this PC. Stored in the user's app-data folder.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

// Things in a game folder that are almost never "the game".
const JUNK_EXE = /(unins|uninst|setup|install|redist|vcredist|vc_redist|dxsetup|directx|dotnet|crash|report|ue4prereq|ueprereq|prereq|helper|updater|update|cleanup|benchmark|easyanticheat_setup|be_service|cefprocess|webhelper|7z|unitycrashhandler)/i;
const SKIP_DIRS = /^(\$recycle\.bin|windows|system32|node_modules|\.git|_commonredist|redist|redistributables|directx|dotnet|vcredist|support|__installer|installers|prereqs?)$/i;

function parseArgs(s) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function prettyName(exePath) {
  const base = path.basename(exePath, path.extname(exePath));
  const parent = path.basename(path.dirname(exePath));
  // "Game-Win64-Shipping" style names: prefer the folder name
  const generic = /^(game|launcher|start|play|bin|win64|win32|x64)$|shipping|win64|win32/i;
  const pick = generic.test(base) && parent && !/^(bin|binaries|win64|win32|x64|x86)$/i.test(parent) ? parent : base;
  return pick.replace(/[_\-.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

class Library extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.games = [];
    this.running = new Map(); // id -> { child, start }
    this.games = [];
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) this.games = parsed.filter((g) => g && typeof g.exePath === 'string' && typeof g.id === 'string');
      } catch {
        // Never silently wipe someone's library: keep the broken file aside.
        try { fs.copyFileSync(file, `${file}.broken-${Date.now()}`); } catch {}
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.games, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return this.games.map((g) => ({ ...g, running: this.running.has(g.id), missing: !fs.existsSync(g.exePath) }));
  }

  get(id) { return this.games.find((g) => g.id === id); }

  add(exePath, name) {
    exePath = path.resolve(exePath);
    if (path.extname(exePath).toLowerCase() !== '.exe') throw new Error('Only .exe files can be added');
    const existing = this.games.find((g) => g.exePath.toLowerCase() === exePath.toLowerCase());
    if (existing) return existing;
    const g = {
      id: crypto.randomUUID(), name: (name || prettyName(exePath)).slice(0, 80), exePath,
      args: '', addedAt: Date.now(), lastPlayed: null, playtimeSec: 0, favorite: false, modsDir: '', notes: '',
    };
    this.games.push(g);
    this.save();
    this.emit('changed');
    return g;
  }

  update(id, fields) {
    const g = this.get(id);
    if (!g) throw new Error('Game not found');
    if (typeof fields.name === 'string' && fields.name.trim()) g.name = fields.name.trim().slice(0, 80);
    if (typeof fields.args === 'string') g.args = fields.args.slice(0, 500);
    if (typeof fields.favorite === 'boolean') g.favorite = fields.favorite;
    if (typeof fields.notes === 'string') g.notes = fields.notes.slice(0, 2000);
    if (typeof fields.modsDir === 'string') g.modsDir = fields.modsDir.slice(0, 500);
    this.save();
    this.emit('changed');
    return g;
  }

  remove(id) {
    this.games = this.games.filter((g) => g.id !== id);
    this.save();
    this.emit('changed');
  }

  launch(id) {
    const g = this.get(id);
    if (!g) throw new Error('Game not found');
    if (this.running.has(id)) throw new Error(`${g.name} is already running`);
    if (!fs.existsSync(g.exePath)) throw new Error('The .exe is missing. Was the game moved?');
    // No shell: the exe and args go straight to CreateProcess, so nothing can be injected.
    const child = spawn(g.exePath, parseArgs(g.args), {
      cwd: path.dirname(g.exePath), detached: true, stdio: 'ignore', shell: false, windowsHide: false,
    });
    const start = Date.now();
    this.running.set(id, { child, start });
    g.lastPlayed = start;
    this.save();
    child.on('error', (e) => { this.running.delete(id); this.emit('exit', g, e.message); this.emit('changed'); });
    child.on('exit', () => {
      this.running.delete(id);
      g.playtimeSec += Math.round((Date.now() - start) / 1000);
      this.save();
      this.emit('exit', g);
      this.emit('changed');
    });
    child.unref();
    this.emit('launch', g);
    this.emit('changed');
    return g;
  }

  stop(id) {
    const r = this.running.get(id);
    if (r) r.child.kill();
  }

  // Walk a folder (depth-limited) and suggest .exe files that look like games.
  scan(root, maxDepth = 4) {
    const found = [];
    const walk = (dir, depth) => {
      if (depth > maxDepth || found.length > 500) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) walk(full, depth + 1); }
        else if (e.isFile() && /\.exe$/i.test(e.name) && !JUNK_EXE.test(e.name)) {
          let size = 0; try { size = fs.statSync(full).size; } catch {}
          if (size < 200 * 1024) continue; // tiny stubs are rarely the game
          const already = this.games.some((g) => g.exePath.toLowerCase() === full.toLowerCase());
          found.push({ exePath: full, name: prettyName(full), sizeMB: Math.round(size / 1048576), already });
        }
      }
    };
    walk(root, 0);
    // Largest exe per folder first - usually the real game binary.
    found.sort((a, b) => b.sizeMB - a.sizeMB);
    return found;
  }
}

module.exports = { Library, parseArgs, prettyName };
