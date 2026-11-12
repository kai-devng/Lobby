// Single WebSocket to the Lobby server: JSON requests/events + binary relay frames.
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

class LobbyConnection extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.url = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connected = false;
    this.user = null;
    this.token = null;
    this.wantOpen = false;
    this.retryMs = 1000;
    this.retryTimer = null;
  }

  connect(url, token) {
    this.url = url;
    this.token = token || null;
    this.wantOpen = true;
    this._open();
  }

  disconnect() {
    this.wantOpen = false;
    clearTimeout(this.retryTimer);
    if (this.ws) this.ws.close();
  }

  _open() {
    clearTimeout(this.retryTimer);
    if (this.ws) { this.ws.removeAllListeners(); try { this.ws.terminate(); } catch {} }
    let ws;
    try {
      ws = new WebSocket(this.url, { maxPayload: 2 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 8000 });
    } catch (e) {
      this.emit('status', { connected: false, error: 'Bad server address' });
      return;
    }
    this.ws = ws;
    ws.binaryType = 'nodebuffer';
    ws.on('open', async () => {
      this.connected = true;
      this.retryMs = 1000;
      this.emit('status', { connected: true });
      if (this.token) {
        try {
          const r = await this.request('auth.token', { token: this.token });
          this._authed(r);
        } catch (e) {
          this.token = null;
          this.emit('auth', { user: null, error: e.message, clearToken: true });
        }
      } else {
        this.emit('auth', { user: null });
      }
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { this.emit('binary', data); return; }
      let msg; try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.t === 'res') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.ok ? p.resolve(msg.d) : p.reject(new Error(msg.err || 'Request failed'));
      } else if (msg.t === 'evt') {
        if (msg.e === 'session.replaced') this.wantOpen = false;
        this.emit('event', msg.e, msg.d);
      }
    });
    ws.on('close', () => {
      const wasAuthed = !!this.user;
      this.connected = false;
      this.user = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Disconnected')); }
      this.pending.clear();
      this.emit('status', { connected: false, wasAuthed });
      if (this.wantOpen) {
        this.retryTimer = setTimeout(() => this._open(), this.retryMs);
        this.retryMs = Math.min(this.retryMs * 2, 15000);
      }
    });
    ws.on('error', () => {});
  }

  _authed(r) {
    this.user = r.user;
    this.token = r.token;
    this.emit('auth', { user: r.user, token: r.token, friends: { friends: r.friends, incoming: r.incoming, outgoing: r.outgoing } });
  }

  async login(op, username, password) {
    if (!this.connected) throw new Error('Not connected to the Lobby server');
    const r = await this.request(op, { username, password });
    this._authed(r);
    return r;
  }

  async logout() {
    try { await this.request('auth.logout', {}); } catch {}
    this.token = null;
    this.user = null;
    // server closes the socket; reconnect fresh without a token
  }

  request(op, d, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('Not connected'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Server did not respond')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ t: 'req', id, op, d }));
    });
  }

  // No reply expected (game messages).
  fire(op, d) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'req', op, d }));
  }

  sendBinary(buf) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(buf); return true; }
    return false;
  }

  get bufferedAmount() { return this.ws ? this.ws.bufferedAmount : 0; }
}

module.exports = { LobbyConnection };
