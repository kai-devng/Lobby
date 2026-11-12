// Blast Arena - a built-in multiplayer game and the template for Lobby-native games.
// All messages go through the Lobby relay, so players never connect to each other directly.
//
// Netcode (built so joining players don't feel lag):
//  - Every player moves their OWN character locally, instantly (client-side prediction). They send
//    their position to the host 30x/s. The host sanity-checks it (speed + walls) and corrects cheaters.
//  - Everyone else is drawn 100 ms "in the past", smoothly interpolated between network updates,
//    instead of jumping 20 times a second.
//  - Bullets are sent once as a spawn event and then simulated on every machine at full frame rate.
//    Your own bullets appear the instant you click. The host alone decides hits, damage and score.
(function () {
  const W = 1280, H = 720;
  const R = 18, SPEED = 260, BULLET_SPEED = 900, BULLET_LIFE = 0.9, FIRE_CD = 0.18, DMG = 34, RESPAWN = 2, WIN_SCORE = 15;
  const NET_HZ = 30, INTERP_MS = 100;
  const COLORS = ['#7c8cff', '#ff7a6b', '#4fd1a5', '#ffc857', '#e879f9', '#38bdf8', '#f97316', '#a3e635'];
  const WALLS = [
    [240, 150, 60, 200], [980, 370, 60, 200], [560, 320, 160, 80],
    [420, 560, 220, 40], [640, 120, 220, 40], [0, 0, W, 10], [0, H - 10, W, 10], [0, 0, 10, H], [W - 10, 0, 10, H],
  ];
  const SPAWNS = [[80, 80], [W - 80, H - 80], [W - 80, 80], [80, H - 80], [W / 2, 60], [W / 2, H - 60], [120, H / 2], [W - 120, H / 2]];

  const hitWall = (x, y, r = 0) => WALLS.some(([wx, wy, ww, wh]) => {
    if (r === 0) return x >= wx && x <= wx + ww && y >= wy && y <= wy + wh;
    const cx = Math.max(wx, Math.min(x, wx + ww)), cy = Math.max(wy, Math.min(y, wy + wh));
    return (x - cx) ** 2 + (y - cy) ** 2 < r * r;
  });
  const num = (v) => (Number.isFinite(v) ? v : 0);
  const lerpAngle = (a, b, t) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return a + d * t; };

  class BlastArena {
    /** opts: { canvas, me:{id,username}, hostId, members:[{id,username}], send(data, to?), onExit(), solo } */
    constructor(opts) {
      Object.assign(this, opts);
      this.isHost = !!opts.solo || opts.me.id === opts.hostId;
      this.ctx = this.canvas.getContext('2d');
      this.players = new Map();  // id -> { id, name, ci, hp, score, alive, x, y, a, buf[], bot, ... }
      this.bullets = new Map();  // id -> { x, y, vx, vy, life, owner }
      this.feed = [];
      this.winner = null;
      this.roundResetAt = 0;
      this.nextColor = 0;
      this.bulletSeq = 0;
      this.input = { u: 0, d: 0, l: 0, r: 0, f: 0 };
      this.mouse = { x: W / 2, y: H / 2 };
      this.self = { x: 0, y: 0, a: 0, cd: 0, ready: false };
      this.memberIds = new Set(this.members.map((m) => m.id));
      this.running = true;

      if (this.isHost) {
        this.members.forEach((m) => this._addPlayer(m.id, m.username));
        this._addPlayer(this.me.id, this.me.username);
        if (this.solo) ['Bolt', 'Rusty', 'Pixel'].forEach((n, i) => this._addPlayer(-(i + 1), `${n} (bot)`, true));
        const p = this.players.get(this.me.id);
        Object.assign(this.self, { x: p.x, y: p.y, ready: true });
      } else {
        this._helloTimer = setInterval(() => { if (!this.self.ready) this.send({ t: 'hello' }, this.hostId); }, 500);
        this.send({ t: 'hello' }, this.hostId);
      }

      this._bind();
      this.last = performance.now();
      this.lastDraw = this.last;
      this.netAcc = 0;
      // Simulation + network on a timer (keeps running when the window is in the background).
      this.tickTimer = setInterval(() => this._tick(), 1000 / 60);
      requestAnimationFrame((t) => this._frame(t));
    }

    // ---------------------------------------------------------------- players
    _addPlayer(id, name, bot = false) {
      if (this.players.has(id)) return this.players.get(id);
      const [x, y] = SPAWNS[this.players.size % SPAWNS.length];
      const p = { id, name: String(name).slice(0, 30), ci: this.nextColor++ % COLORS.length, hp: 100, score: 0, alive: true,
        x, y, a: 0, buf: [], bot, respawnAt: 0, lastFire: 0, lastPosAt: performance.now(), cd: 0, wp: null, botCd: 0 };
      this.players.set(id, p);
      return p;
    }

    setMembers(members) {
      this.memberIds = new Set(members.map((m) => m.id));
      if (!this.isHost || this.solo) return;
      members.forEach((m) => this._addPlayer(m.id, m.username));
      for (const id of [...this.players.keys()]) if (!this.memberIds.has(id) && id !== this.me.id) this.players.delete(id);
    }

    _teleport(id, x, y) {
      if (id === this.me.id) { Object.assign(this.self, { x, y, ready: true }); clearInterval(this._helloTimer); }
      const p = this.players.get(id);
      if (p) { p.x = x; p.y = y; p.buf = [{ t: performance.now(), x, y, a: p.a }]; }
    }

    _spawnPoint() {
      // farthest spawn from everyone alive
      let best = SPAWNS[0], bestD = -1;
      for (const s of SPAWNS) {
        let d = 1e9;
        for (const p of this.players.values()) if (p.alive) d = Math.min(d, Math.hypot(p.x - s[0], p.y - s[1]));
        d += Math.random() * 80;
        if (d > bestD) { bestD = d; best = s; }
      }
      return best;
    }

    // ---------------------------------------------------------------- input
    _bind() {
      const keys = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
      this._kd = (e) => {
        if (e.code === 'Escape') { this.exit(); return; }
        if (keys[e.code]) { this.input[keys[e.code]] = 1; e.preventDefault(); }
        if (e.code === 'Space') { this.input.f = 1; e.preventDefault(); }
      };
      this._ku = (e) => { if (keys[e.code]) this.input[keys[e.code]] = 0; if (e.code === 'Space') this.input.f = 0; };
      this._mm = (e) => {
        const r = this.canvas.getBoundingClientRect();
        this.mouse.x = ((e.clientX - r.left) / r.width) * W;
        this.mouse.y = ((e.clientY - r.top) / r.height) * H;
      };
      this._md = (e) => { if (e.button === 0) this.input.f = 1; };
      this._mu = (e) => { if (e.button === 0) this.input.f = 0; };
      this._blur = () => { Object.keys(this.input).forEach((k) => { this.input[k] = 0; }); };
      this._rs = () => this._resize();
      window.addEventListener('keydown', this._kd);
      window.addEventListener('keyup', this._ku);
      window.addEventListener('mousemove', this._mm);
      this.canvas.addEventListener('mousedown', this._md);
      window.addEventListener('mouseup', this._mu);
      window.addEventListener('blur', this._blur);
      window.addEventListener('resize', this._rs);
      this._resize();
    }

    _resize() {
      const s = Math.min(window.innerWidth / W, window.innerHeight / H);
      this.canvas.width = W; this.canvas.height = H;
      this.canvas.style.width = `${W * s}px`; this.canvas.style.height = `${H * s}px`;
    }

    exit() {
      if (!this.running) return;
      this.running = false;
      clearInterval(this.tickTimer);
      clearInterval(this._helloTimer);
      ['keydown', 'keyup', 'mousemove', 'mouseup', 'blur', 'resize'].forEach((ev) =>
        window.removeEventListener(ev, { keydown: this._kd, keyup: this._ku, mousemove: this._mm, mouseup: this._mu, blur: this._blur, resize: this._rs }[ev]));
      this.onExit && this.onExit();
    }

    // ---------------------------------------------------------------- network in
    onMessage(from, m) {
      if (!m || typeof m !== 'object') return;
      if (this.isHost) this._hostReceive(from, m);
      else if (from === this.hostId) this._clientReceive(m);
    }

    _hostReceive(from, m) {
      if (!this.memberIds.has(from)) return;
      const p = this.players.get(from) || this._addPlayer(from, `Player ${from}`);
      const now = performance.now();
      if (m.t === 'hello') {
        this.send({ t: 'r', id: from, x: p.x, y: p.y }, from);
      } else if (m.t === 'p') {
        if (!p.alive) return;
        const x = num(m.x), y = num(m.y);
        const dt = Math.min(1, (now - p.lastPosAt) / 1000);
        const maxDist = SPEED * dt * 1.5 + 40;
        if (Math.hypot(x - p.x, y - p.y) <= maxDist && !hitWall(x, y, R - 3) && x > 0 && x < W && y > 0 && y < H) {
          p.x = x; p.y = y; p.a = num(m.a); p.lastPosAt = now;
          p.buf.push({ t: now, x, y, a: p.a });
          if (p.buf.length > 60) p.buf.splice(0, p.buf.length - 60);
        } else {
          this.send({ t: 'r', id: from, x: p.x, y: p.y }, from); // correction
        }
      } else if (m.t === 'f') {
        if (!p.alive || this.winner || now - p.lastFire < FIRE_CD * 600) return;
        const x = num(m.x), y = num(m.y), a = num(m.a);
        if (Math.hypot(x - p.x, y - p.y) > 90) return;
        const id = String(m.id || '');
        if (!id.startsWith(`${from}:`) || id.length > 24 || this.bullets.has(id)) return;
        p.lastFire = now;
        this._spawnBullet(id, from, x, y, a, true);
      }
    }

    _clientReceive(m) {
      const now = performance.now();
      if (m.t === 's') {
        const seen = new Set();
        for (const row of m.p || []) {
          const [id, x, y, a, hp, score, alive, ci, name] = row;
          seen.add(id);
          let p = this.players.get(id);
          if (!p) { p = { id, buf: [] }; this.players.set(id, p); }
          Object.assign(p, { hp, score, alive: !!alive, ci, name: String(name).slice(0, 30) });
          if (id !== this.me.id) { p.x = x; p.y = y; p.a = a; p.buf.push({ t: now, x, y, a }); if (p.buf.length > 60) p.buf.splice(0, p.buf.length - 60); }
        }
        for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
        this.winner = m.w || null;
      } else if (m.t === 'b') {
        if (m.o !== this.me.id && !this.bullets.has(m.id)) {
          this.bullets.set(m.id, { x: num(m.x), y: num(m.y), vx: Math.cos(num(m.a)) * BULLET_SPEED, vy: Math.sin(num(m.a)) * BULLET_SPEED, life: BULLET_LIFE, owner: m.o });
        }
      } else if (m.t === 'h') {
        this.bullets.delete(m.b);
        const v = this.players.get(m.v);
        if (v) { v.hp = m.hp; if (m.dead) v.alive = false; }
        if (m.text) this._pushFeed(m.text);
      } else if (m.t === 'r') {
        this._teleport(m.id, num(m.x), num(m.y));
        const p = this.players.get(m.id);
        if (p) { p.alive = true; p.hp = 100; }
      }
    }

    // ---------------------------------------------------------------- bullets
    _spawnBullet(id, owner, x, y, a, broadcast) {
      this.bullets.set(id, { x, y, vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED, life: BULLET_LIFE, owner });
      if (broadcast && !this.solo) this.send({ t: 'b', id, o: owner, x: Math.round(x), y: Math.round(y), a: +a.toFixed(3) });
    }

    _fireSelf() {
      const s = this.self;
      const x = s.x + Math.cos(s.a) * (R + 4), y = s.y + Math.sin(s.a) * (R + 4);
      const id = `${this.me.id}:${++this.bulletSeq}`;
      if (this.isHost) {
        this.players.get(this.me.id).lastFire = performance.now();
        this._spawnBullet(id, this.me.id, x, y, s.a, true);
      } else {
        this._spawnBullet(id, this.me.id, x, y, s.a, false); // shows instantly
        this.send({ t: 'f', id, x: Math.round(x), y: Math.round(y), a: +s.a.toFixed(3) }, this.hostId);
      }
    }

    // ---------------------------------------------------------------- main tick
    _tick() {
      if (!this.running) return;
      const t = performance.now();
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      const me = this.players.get(this.me.id);
      const s = this.self;

      // 1. move myself (instant, local)
      s.a = Math.atan2(this.mouse.y - s.y, this.mouse.x - s.x);
      if (s.ready && me && me.alive && !this.winner) {
        let vx = this.input.r - this.input.l, vy = this.input.d - this.input.u;
        const len = Math.hypot(vx, vy) || 1;
        vx = (vx / len) * SPEED * dt; vy = (vy / len) * SPEED * dt;
        if (!hitWall(s.x + vx, s.y, R)) s.x += vx;
        if (!hitWall(s.x, s.y + vy, R)) s.y += vy;
        s.cd -= dt;
        if (this.input.f && s.cd <= 0) { s.cd = FIRE_CD; this._fireSelf(); }
      }
      if (this.isHost && me) { me.x = s.x; me.y = s.y; me.a = s.a; }

      // 2. host-only game rules
      if (this.isHost) this._hostRules(dt, t / 1000);

      // 3. bullets (everyone simulates; only the host applies damage)
      for (const [id, b] of this.bullets) {
        b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
        if (b.life <= 0 || hitWall(b.x, b.y)) { this.bullets.delete(id); continue; }
        for (const p of this.players.values()) {
          if (!p.alive || p.id === b.owner) continue;
          const pos = this.isHost ? p : this._renderPos(p, t);
          if ((pos.x - b.x) ** 2 + (pos.y - b.y) ** 2 < R * R) {
            this.bullets.delete(id);
            if (this.isHost) this._hit(id, b, p, t / 1000);
            break;
          }
        }
      }

      // 4. network out
      this.netAcc += dt;
      if (this.netAcc >= 1 / NET_HZ) {
        this.netAcc = 0;
        if (this.isHost && !this.solo) this.send(this._snapshot());
        else if (!this.isHost && s.ready && me?.alive) this.send({ t: 'p', x: Math.round(s.x * 10) / 10, y: Math.round(s.y * 10) / 10, a: +s.a.toFixed(3) }, this.hostId);
      }
    }

    _hostRules(dt, now) {
      if (this.winner && now > this.roundResetAt) {
        this.winner = null;
        let i = 0;
        for (const p of this.players.values()) {
          const [x, y] = SPAWNS[i++ % SPAWNS.length];
          Object.assign(p, { score: 0, hp: 100, alive: true });
          this._teleport(p.id, x, y);
          if (!this.solo && !p.bot) this.send({ t: 'r', id: p.id, x, y });
        }
      }
      for (const p of this.players.values()) {
        if (!p.alive && now > p.respawnAt && !this.winner) {
          const [x, y] = this._spawnPoint();
          Object.assign(p, { hp: 100, alive: true });
          this._teleport(p.id, x, y);
          p.lastPosAt = performance.now();
          if (!this.solo) this.send({ t: 'r', id: p.id, x, y });
        }
        if (p.bot && p.alive && !this.winner) this._botStep(p, dt);
      }
    }

    _hit(bid, b, victim, now) {
      victim.hp -= DMG;
      let text = null, dead = false;
      if (victim.hp <= 0) {
        dead = true;
        victim.alive = false; victim.respawnAt = now + RESPAWN;
        const killer = this.players.get(b.owner);
        if (killer) {
          killer.score += 1;
          text = `${killer.name} blasted ${victim.name}`;
          if (killer.score >= WIN_SCORE && !this.winner) { this.winner = killer.name; this.roundResetAt = now + 5; }
        }
      }
      if (text) this._pushFeed(text);
      if (!this.solo) this.send({ t: 'h', b: bid, v: victim.id, hp: victim.hp, dead, text });
    }

    _snapshot() {
      const p = [...this.players.values()].map((q) => [q.id, Math.round(q.x), Math.round(q.y), +q.a.toFixed(2), q.hp, q.score, q.alive ? 1 : 0, q.ci, q.name]);
      return { t: 's', p, w: this.winner || undefined };
    }

    _botStep(p, dt) {
      if (!p.wp || Math.hypot(p.wp[0] - p.x, p.wp[1] - p.y) < 30 || Math.random() < 0.005) {
        p.wp = [60 + Math.random() * (W - 120), 60 + Math.random() * (H - 120)];
      }
      let target = null, best = 1e9;
      for (const q of this.players.values()) {
        if (q === p || !q.alive) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < best) { best = d; target = q; }
      }
      if (target) p.a = Math.atan2(target.y - p.y, target.x - p.x) + (Math.random() - 0.5) * 0.35;
      const dx = p.wp[0] - p.x, dy = p.wp[1] - p.y, len = Math.hypot(dx, dy) || 1;
      const vx = (dx / len) * SPEED * 0.8 * dt, vy = (dy / len) * SPEED * 0.8 * dt;
      if (!hitWall(p.x + vx, p.y, R)) p.x += vx; else p.wp = null;
      if (!hitWall(p.x, p.y + vy, R)) p.y += vy; else p.wp = null;
      p.botCd -= dt;
      if (target && best < 520 && p.botCd <= 0 && Math.random() < 0.08) {
        p.botCd = 0.35;
        this._spawnBullet(`${p.id}:${++this.bulletSeq}`, p.id, p.x + Math.cos(p.a) * (R + 4), p.y + Math.sin(p.a) * (R + 4), p.a, true);
      }
    }

    _pushFeed(text) {
      this.feed.unshift({ text, at: performance.now() });
      this.feed.length = Math.min(this.feed.length, 5);
    }

    // Where to draw a player: me = live local position; bots on host = live; everyone else is
    // interpolated 100 ms in the past between the two network updates around that moment.
    _renderPos(p, now) {
      if (p.id === this.me.id) return this.self;
      if (this.isHost && p.bot) return p;
      const buf = p.buf;
      if (!buf || !buf.length) return p;
      const rt = now - INTERP_MS;
      while (buf.length > 2 && buf[1].t <= rt) buf.shift();
      if (buf.length === 1 || rt <= buf[0].t) return buf[0];
      const a = buf[0], b = buf[1];
      if (rt >= b.t) return b;
      const k = (rt - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, a: lerpAngle(a.a, b.a, k) };
    }

    // ---------------------------------------------------------------- drawing
    _frame(t) {
      if (!this.running) return;
      this._draw(t);
      requestAnimationFrame((n) => this._frame(n));
    }

    _draw(now) {
      const c = this.ctx;
      c.fillStyle = '#0b0e14'; c.fillRect(0, 0, W, H);
      c.strokeStyle = 'rgba(255,255,255,0.035)'; c.lineWidth = 1;
      for (let x = 0; x < W; x += 40) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
      for (let y = 0; y < H; y += 40) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
      c.fillStyle = '#1f2633';
      for (const [x, y, w, h] of WALLS) c.fillRect(x, y, w, h);
      c.fillStyle = '#ffe9a8';
      for (const b of this.bullets.values()) { c.beginPath(); c.arc(b.x, b.y, 4, 0, Math.PI * 2); c.fill(); }

      for (const p of this.players.values()) {
        if (!p.alive || (p.id === this.me.id && !this.self.ready)) continue;
        const v = this._renderPos(p, now);
        const color = COLORS[(p.ci ?? 0) % COLORS.length];
        c.save(); c.translate(v.x, v.y);
        c.fillStyle = color; c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();
        c.rotate(v.a || 0); c.fillStyle = '#e8ecf4'; c.fillRect(R - 4, -4, 14, 8);
        c.restore();
        if (p.id === this.me.id) { c.strokeStyle = '#fff'; c.lineWidth = 2; c.beginPath(); c.arc(v.x, v.y, R + 4, 0, Math.PI * 2); c.stroke(); }
        c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(v.x - 22, v.y - R - 14, 44, 5);
        c.fillStyle = p.hp > 40 ? '#4fd1a5' : '#ff7a6b'; c.fillRect(v.x - 22, v.y - R - 14, 44 * Math.max(0, p.hp) / 100, 5);
        c.fillStyle = '#c9d1e0'; c.font = '13px Segoe UI, sans-serif'; c.textAlign = 'center';
        c.fillText(p.name, v.x, v.y - R - 20);
      }

      const list = [...this.players.values()].sort((a, b) => b.score - a.score);
      c.textAlign = 'right'; c.font = 'bold 14px Segoe UI, sans-serif';
      list.forEach((p, i) => { c.fillStyle = COLORS[(p.ci ?? 0) % COLORS.length]; c.fillText(`${p.name}  ${p.score ?? 0}`, W - 24, 36 + i * 20); });
      c.textAlign = 'center'; c.font = '13px Segoe UI, sans-serif';
      this.feed.filter((f) => now - f.at < 5000).forEach((f, i) => { c.fillStyle = 'rgba(232,236,244,0.85)'; c.fillText(f.text, W / 2, 34 + i * 18); });
      c.textAlign = 'left';
      c.fillStyle = 'rgba(232,236,244,0.45)';
      c.fillText(`WASD move · mouse aim · click/space shoot · first to ${WIN_SCORE} · Esc to leave`, 24, H - 22);
      const me = this.players.get(this.me.id);
      c.textAlign = 'center';
      if (!this.self.ready) { c.font = 'bold 24px Segoe UI'; c.fillStyle = '#c9d1e0'; c.fillText('Connecting to host…', W / 2, H / 2); }
      else if (me && !me.alive && !this.winner) { c.font = 'bold 28px Segoe UI'; c.fillStyle = '#ff7a6b'; c.fillText('Respawning…', W / 2, H / 2); }
      if (this.winner) {
        c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(0, H / 2 - 60, W, 120);
        c.font = 'bold 40px Segoe UI'; c.fillStyle = '#ffc857';
        c.fillText(`${this.winner} wins!`, W / 2, H / 2 + 14);
      }
    }
  }

  window.BlastArena = BlastArena;
})();
