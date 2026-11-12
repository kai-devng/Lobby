// Relay tunnels: a "virtual LAN" over the Lobby server so friends never see each other's IP.
//
//  HOST side   : "share" a port that your game server listens on (127.0.0.1:PORT). The port number
//                stays on this machine. When a friend connects, the server says "stream N for tunnel T"
//                and we open a socket to 127.0.0.1:PORT ourselves. A server can never make us connect
//                anywhere else: the target is looked up in our own local table, never taken from the wire.
//  FRIEND side : "connect" opens a listener on 127.0.0.1:<random or chosen port>. Point your game at it.
//                Bound to localhost only, so it isn't exposed to the friend's own network.
const net = require('node:net');
const dgram = require('node:dgram');

const OP_DATA = 1;
const OP_CLOSE = 2;
const OP_FIN = 3; // half-close: "I'm done sending"
const MAX_CHUNK = 60 * 1024;
const UDP_IDLE_MS = 120_000;

// Remote close is graceful (flush what we already received, then close); hard-kill after 5s.
function tcpStream(tunnelId, sock) {
  return {
    tunnelId,
    write: (b) => { if (!sock.destroyed) sock.write(b); },
    end: () => { if (!sock.destroyed) sock.end(); },
    close: () => {
      if (sock.destroyed) return;
      sock.end();
      setTimeout(() => sock.destroy(), 5000).unref();
    },
  };
}

function frame(op, id, payload) {
  const len = payload ? payload.length : 0;
  const b = Buffer.allocUnsafe(5 + len);
  b[0] = op; b.writeUInt32BE(id, 1);
  if (len) payload.copy(b, 5);
  return b;
}

class TunnelManager {
  constructor(conn, notify) {
    this.conn = conn;
    this.notify = notify; // (payload) => void, tells the UI what changed
    this.hosted = new Map();   // tunnelId -> { proto, port, label }
    this.joined = new Map();   // tunnelId -> { proto, localPort, server|socket, flows }
    this.streams = new Map();  // streamId -> { write(buf), close(), touch? }
    conn.on('binary', (buf) => this._onFrame(buf));
    conn.on('event', (e, d) => {
      if (e === 'stream.incoming') this._onIncoming(d);
      if (e === 'lobby.left') this.closeAll();
      if (e === 'lobby.state') this._prune(d);
    });
    conn.on('status', (s) => { if (!s.connected) this.closeAll(); });
    this.udpSweep = setInterval(() => this._sweepUdp(), 15_000);
  }

  state() {
    return {
      hosted: [...this.hosted].map(([id, t]) => ({ id, proto: t.proto, port: t.port, label: t.label })),
      joined: [...this.joined].map(([id, t]) => ({ id, proto: t.proto, localPort: t.localPort })),
    };
  }
  _changed() { this.notify(this.state()); }

  // ------------------------------------------------------------ host side
  async share(proto, port, label) {
    proto = proto === 'udp' ? 'udp' : 'tcp';
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535');
    const { tunnelId } = await this.conn.request('tunnel.open', { proto, label: String(label || 'Game server').slice(0, 40) });
    this.hosted.set(tunnelId, { proto, port, label });
    this._changed();
    return tunnelId;
  }

  async unshare(tunnelId) {
    this.hosted.delete(tunnelId);
    for (const [sid, s] of this.streams) if (s.tunnelId === tunnelId) { s.close(); this.streams.delete(sid); }
    try { await this.conn.request('tunnel.close', { tunnelId }); } catch {}
    this._changed();
  }

  _onIncoming({ streamId, tunnelId }) {
    const t = this.hosted.get(tunnelId);
    if (!t) { this.conn.sendBinary(frame(OP_CLOSE, streamId)); return; }
    if (t.proto === 'tcp') {
      const sock = net.connect({ host: '127.0.0.1', port: t.port, allowHalfOpen: true });
      sock.setNoDelay(true);
      this.streams.set(streamId, tcpStream(tunnelId, sock)); // writes before 'connect' are queued by Node
      this._pumpTcp(sock, streamId);
    } else {
      const sock = dgram.createSocket('udp4');
      sock.connect(t.port, '127.0.0.1');
      const pending = [];
      let open = false;
      sock.on('connect', () => { open = true; for (const p of pending) sock.send(p); pending.length = 0; });
      sock.on('message', (msg) => { st.last = Date.now(); this.conn.sendBinary(frame(OP_DATA, streamId, msg)); });
      sock.on('error', () => this._localClosed(streamId));
      const st = {
        tunnelId, udp: true, last: Date.now(),
        write: (b) => { st.last = Date.now(); open ? sock.send(b) : pending.push(b); },
        close: () => { try { sock.close(); } catch {} },
      };
      this.streams.set(streamId, st);
    }
  }

  // ------------------------------------------------------------ friend side
  async connect(tunnelId, proto, localPort = 0) {
    if (this.joined.has(tunnelId)) return this.joined.get(tunnelId).localPort;
    localPort = Number(localPort) || 0;
    const entry = { proto, localPort: 0, flows: new Map() };
    if (proto === 'tcp') {
      const server = net.createServer({ allowHalfOpen: true }, (sock) => this._acceptTcp(tunnelId, sock));
      await new Promise((res, rej) => { server.once('error', rej); server.listen(localPort, '127.0.0.1', res); });
      entry.server = server;
      entry.localPort = server.address().port;
    } else {
      const sock = dgram.createSocket('udp4');
      await new Promise((res, rej) => { sock.once('error', rej); sock.bind(localPort, '127.0.0.1', res); });
      sock.on('message', (msg, rinfo) => this._udpFromGame(tunnelId, entry, msg, rinfo));
      entry.socket = sock;
      entry.localPort = sock.address().port;
    }
    this.joined.set(tunnelId, entry);
    this._changed();
    return entry.localPort;
  }

  disconnectTunnel(tunnelId) {
    const e = this.joined.get(tunnelId);
    if (!e) return;
    this.joined.delete(tunnelId);
    try { e.server?.close(); } catch {}
    try { e.socket?.close(); } catch {}
    for (const [sid, s] of this.streams) if (s.tunnelId === tunnelId) {
      s.close(); this.streams.delete(sid); this.conn.sendBinary(frame(OP_CLOSE, sid));
    }
    this._changed();
  }

  async _acceptTcp(tunnelId, sock) {
    sock.setNoDelay(true);
    sock.pause();
    let streamId;
    try { ({ streamId } = await this.conn.request('stream.open', { tunnelId })); }
    catch { sock.destroy(); return; }
    this.streams.set(streamId, tcpStream(tunnelId, sock));
    this._pumpTcp(sock, streamId);
    sock.resume();
  }

  async _udpFromGame(tunnelId, entry, msg, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    let flow = entry.flows.get(key);
    if (!flow) {
      flow = { queue: [msg], streamId: null };
      entry.flows.set(key, flow);
      try {
        const { streamId } = await this.conn.request('stream.open', { tunnelId });
        flow.streamId = streamId;
        const st = {
          tunnelId, udp: true, last: Date.now(),
          write: (b) => { st.last = Date.now(); entry.socket.send(b, rinfo.port, rinfo.address); },
          close: () => entry.flows.delete(key),
        };
        this.streams.set(streamId, st);
        for (const q of flow.queue) this.conn.sendBinary(frame(OP_DATA, streamId, q));
        flow.queue = null;
      } catch { entry.flows.delete(key); }
      return;
    }
    if (flow.streamId === null) { if (flow.queue.length < 64) flow.queue.push(msg); return; }
    const st = this.streams.get(flow.streamId);
    if (st) st.last = Date.now();
    this.conn.sendBinary(frame(OP_DATA, flow.streamId, msg));
  }

  // ------------------------------------------------------------ shared
  _pumpTcp(sock, streamId) {
    sock.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
        this.conn.sendBinary(frame(OP_DATA, streamId, chunk.subarray(i, i + MAX_CHUNK)));
      }
      // Simple backpressure: if the websocket is backed up, stop reading the game socket for a bit.
      if (this.conn.bufferedAmount > 4 * 1024 * 1024) {
        sock.pause();
        const t = setInterval(() => {
          if (sock.destroyed) return clearInterval(t);
          if (this.conn.bufferedAmount < 1024 * 1024) { clearInterval(t); sock.resume(); }
        }, 20);
      }
    });
    sock.on('end', () => this.conn.sendBinary(frame(OP_FIN, streamId)));
    sock.on('close', () => this._localClosed(streamId));
    sock.on('error', () => this._localClosed(streamId));
  }

  _localClosed(streamId) {
    const s = this.streams.get(streamId);
    if (!s) return;
    this.streams.delete(streamId);
    s.close();
    this.conn.sendBinary(frame(OP_CLOSE, streamId));
  }

  _onFrame(buf) {
    if (buf.length < 5) return;
    const op = buf[0];
    const id = buf.readUInt32BE(1);
    const s = this.streams.get(id);
    if (!s) return;
    if (op === OP_CLOSE) { this.streams.delete(id); s.close(); return; }
    if (op === OP_DATA) s.write(buf.subarray(5));
    else if (op === OP_FIN && s.end) s.end();
  }

  _sweepUdp() {
    const now = Date.now();
    for (const [sid, s] of this.streams) {
      if (s.udp && now - s.last > UDP_IDLE_MS) { this.streams.delete(sid); s.close(); this.conn.sendBinary(frame(OP_CLOSE, sid)); }
    }
  }

  _prune(lobby) {
    const alive = new Set((lobby.tunnels || []).map((t) => t.id));
    for (const id of [...this.joined.keys()]) if (!alive.has(id)) this.disconnectTunnel(id);
    for (const id of [...this.hosted.keys()]) if (!alive.has(id)) this.hosted.delete(id);
  }

  closeAll() {
    for (const s of this.streams.values()) s.close();
    this.streams.clear();
    for (const id of [...this.joined.keys()]) this.disconnectTunnel(id);
    this.hosted.clear();
    this._changed();
  }
}

module.exports = { TunnelManager };
