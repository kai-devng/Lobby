// Lobby server core: accounts, friends, presence, lobbies, invites, chat, and the traffic relay.
// Runs standalone (server/src/index.js) or inside the Lobby app ("Host a server" in Settings).
//
// PRIVACY MODEL: clients only ever talk to this server. Game traffic between friends is relayed
// here (WebSocket binary frames), so no client ever learns another client's IP address. The server
// never puts an IP address in any message it sends. Only whoever runs this server can see IPs.
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { openDb } = require('./db');

/**
 * opts: { port=47420, host='127.0.0.1', dataDir, trustProxy=false, log=console.log }
 * trustProxy: read CF-Connecting-IP / X-Forwarded-For, but only from loopback (a local tunnel).
 */
function startServer(opts = {}) {
  const PORT = Number(opts.port || 47420);
  const HOST = opts.host || '127.0.0.1';
  const TRUST_PROXY = !!opts.trustProxy;
  const DATA_DIR = opts.dataDir;
  const log = opts.log || console.log;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = openDb(path.join(DATA_DIR, 'lobby.db'));

  const LIMITS = {
    maxFrame: 1024 * 1024,        // max websocket message
    gameMsgBytes: 16 * 1024,      // max built-in game message
    gameMsgsPerSec: 240,
    reqsPerSec: 30,
    authPerMinute: 10,
    streamsPerUser: 128,
    tunnelsPerLobby: 8,
    relayBufferTcp: 32 * 1024 * 1024,
    relayBufferUdp: 2 * 1024 * 1024,
    inviteTtlMs: 15 * 60 * 1000,
  };

  // ---------------------------------------------------------------- state
  /** userId -> Client */
  const clients = new Map();
  /** lobbyId -> Lobby */
  const lobbies = new Map();
  /** tunnelId -> { id, lobbyId, ownerId, proto, label } */
  const tunnels = new Map();
  /** streamId -> { id, tunnelId, hostId, peerId, proto } */
  const streams = new Map();
  let nextStreamId = 1;

  const rid = (n = 9) => crypto.randomBytes(n).toString('base64url');

  class Client {
    constructor(ws, ip) {
      this.ws = ws;
      this.ip = ip; // never sent to anyone
      this.user = null;
      this.token = null;
      this.status = 'online';
      this.game = null;
      this.lobbyId = null;
      this.reqBucket = bucket(LIMITS.reqsPerSec);
      this.gameBucket = bucket(LIMITS.gameMsgsPerSec);
      this.alive = true;
    }
    send(obj) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }
    evt(e, d) { this.send({ t: 'evt', e, d }); }
  }

  function bucket(perSec) {
    let tokens = perSec, last = Date.now();
    return () => {
      const now = Date.now();
      tokens = Math.min(perSec, tokens + ((now - last) / 1000) * perSec);
      last = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
  }

  const authAttempts = new Map(); // ip -> { n, reset }
  function authAllowed(ip) {
    const now = Date.now();
    let a = authAttempts.get(ip);
    if (!a || a.reset < now) { a = { n: 0, reset: now + 60_000 }; authAttempts.set(ip, a); }
    a.n += 1;
    return a.n <= LIMITS.authPerMinute;
  }
  const authSweep = setInterval(() => { const now = Date.now(); for (const [k, v] of authAttempts) if (v.reset < now) authAttempts.delete(k); }, 60_000).unref();

  // ---------------------------------------------------------------- validation helpers
  class UserError extends Error {}
  const fail = (msg) => { throw new UserError(msg); };
  function str(v, name, min, max) {
    if (typeof v !== 'string') fail(`${name} is required`);
    const s = v.trim();
    if (s.length < min || s.length > max) fail(`${name} must be ${min}-${max} characters`);
    return s;
  }
  function int(v, name, min, max) {
    if (!Number.isInteger(v) || v < min || v > max) fail(`${name} must be a whole number ${min}-${max}`);
    return v;
  }
  const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

  // ---------------------------------------------------------------- presence
  function lobbyCardFor(lobby, viewerId) {
    if (!lobby) return null;
    const host = clients.get(lobby.hostId);
    const invited = lobby.invites.has(viewerId);
    const friendOfHost = db.areFriends(viewerId, lobby.hostId);
    const joinable = lobby.members.size < lobby.maxPlayers &&
      (invited || (lobby.privacy === 'friends' && friendOfHost));
    return {
      id: lobby.id, name: lobby.name, game: lobby.game, privacy: lobby.privacy,
      count: lobby.members.size, max: lobby.maxPlayers, host: host?.user.username, joinable,
    };
  }

  function presenceFor(userId, viewerId) {
    const c = clients.get(userId);
    const u = c?.user || db.userById(userId);
    if (!u) return null;
    return {
      id: u.id, username: u.username, av: u.av || null,
      online: !!c, status: c ? c.status : 'offline', game: c ? c.game : null,
      lobby: c?.lobbyId ? lobbyCardFor(lobbies.get(c.lobbyId), viewerId) : null,
    };
  }

  function broadcastPresence(userId) {
    for (const fid of db.friendIds(userId)) {
      const fc = clients.get(fid);
      if (fc) fc.evt('friend.update', presenceFor(userId, fid));
    }
  }

  function friendsPayload(userId) {
    return {
      friends: db.friendIds(userId).map((id) => presenceFor(id, userId)).filter(Boolean),
      ...db.requests(userId),
    };
  }

  // ---------------------------------------------------------------- lobbies
  function lobbySnapshot(l) {
    return {
      id: l.id, name: l.name, hostId: l.hostId, game: l.game, privacy: l.privacy, maxPlayers: l.maxPlayers,
      started: l.started,
      members: [...l.members.values()].map((m) => ({ id: m.id, username: m.username, ready: m.ready, av: clients.get(m.id)?.user.av || null })),
      tunnels: [...tunnels.values()].filter((t) => t.lobbyId === l.id)
        .map((t) => ({ id: t.id, proto: t.proto, label: t.label, ownerId: t.ownerId })),
    };
  }

  function broadcastLobby(l) {
    const snap = lobbySnapshot(l);
    for (const id of l.members.keys()) clients.get(id)?.evt('lobby.state', snap);
    for (const id of l.members.keys()) broadcastPresence(id);
  }

  function lobbyOf(client) {
    const l = client.lobbyId && lobbies.get(client.lobbyId);
    if (!l) fail('You are not in a lobby');
    return l;
  }

  function closeStream(id, exceptUserId) {
    const s = streams.get(id);
    if (!s) return;
    streams.delete(id);
    const frame = Buffer.alloc(5);
    frame[0] = 2; frame.writeUInt32BE(id, 1);
    for (const uid of [s.hostId, s.peerId]) {
      if (uid === exceptUserId) continue;
      const c = clients.get(uid);
      if (c?.ws.readyState === 1) c.ws.send(frame);
    }
  }

  function closeTunnel(tid) {
    tunnels.delete(tid);
    for (const s of [...streams.values()]) if (s.tunnelId === tid) closeStream(s.id);
  }

  function leaveLobby(client, reason = 'You left the lobby', closing = null) {
    const l = closing || (client.lobbyId && lobbies.get(client.lobbyId));
    client.lobbyId = null;
    if (!l) return;
    const uid = client.user.id;
    l.members.delete(uid);
    for (const t of [...tunnels.values()]) if (t.lobbyId === l.id && t.ownerId === uid) closeTunnel(t.id);
    for (const s of [...streams.values()]) if (s.peerId === uid || s.hostId === uid) closeStream(s.id);
    client.evt('lobby.left', { lobbyId: l.id, reason });
    broadcastPresence(uid);

    if (closing) return;
    if (uid === l.hostId) {
      lobbies.delete(l.id);
      for (const t of [...tunnels.values()]) if (t.lobbyId === l.id) closeTunnel(t.id);
      for (const mid of [...l.members.keys()]) {
        const mc = clients.get(mid);
        if (mc && mc.lobbyId === l.id) leaveLobby(mc, 'The host closed the lobby', l);
      }
    } else {
      systemChat(l, `${client.user.username} left`);
      broadcastLobby(l);
    }
  }

  function systemChat(l, text) {
    for (const id of l.members.keys()) clients.get(id)?.evt('lobby.chat', { system: true, text, at: Date.now() });
  }

  function joinLobby(client, l) {
    if (client.lobbyId === l.id) return;
    if (client.lobbyId) leaveLobby(client);
    if (l.members.size >= l.maxPlayers) fail('Lobby is full');
    l.members.set(client.user.id, { id: client.user.id, username: client.user.username, ready: false });
    l.invites.delete(client.user.id);
    client.lobbyId = l.id;
    systemChat(l, `${client.user.username} joined`);
    broadcastLobby(l);
  }

  // ---------------------------------------------------------------- request handlers
  const handlers = {
    // ----- friends
    'friends.list': (c) => friendsPayload(c.user.id),

    'friends.request': (c, d) => {
      const name = str(d.username, 'Username', 3, 20);
      const target = db.userByName(name);
      // Same error for "no such user" so you can't probe the user list freely.
      if (!target || target.id === c.user.id) fail('No user with that name');
      if (db.areFriends(c.user.id, target.id)) fail('Already friends');
      if (db.hasRequest(target.id, c.user.id)) { // they already asked us: accept
        db.addFriendship(c.user.id, target.id);
        notifyFriendsChanged(c.user.id, target.id);
        return { accepted: true };
      }
      db.addRequest(c.user.id, target.id);
      notifyFriendsChanged(c.user.id, target.id);
      return { sent: true };
    },

    'friends.accept': (c, d) => {
      const id = int(d.userId, 'userId', 1, 2 ** 31);
      if (!db.hasRequest(id, c.user.id)) fail('No such friend request');
      db.addFriendship(c.user.id, id);
      notifyFriendsChanged(c.user.id, id);
      return {};
    },

    'friends.decline': (c, d) => {
      const id = int(d.userId, 'userId', 1, 2 ** 31);
      db.clearRequests(c.user.id, id);
      notifyFriendsChanged(c.user.id, id);
      return {};
    },

    'friends.remove': (c, d) => {
      const id = int(d.userId, 'userId', 1, 2 ** 31);
      db.removeFriendship(c.user.id, id);
      notifyFriendsChanged(c.user.id, id);
      return {};
    },

    'dm.send': (c, d) => {
      const to = int(d.userId, 'userId', 1, 2 ** 31);
      const text = str(d.text, 'Message', 1, 1000);
      if (!db.areFriends(c.user.id, to)) fail('You can only message friends');
      const tc = clients.get(to);
      if (!tc) fail('Friend is offline');
      const msg = { from: c.user.id, fromName: c.user.username, to, text, at: Date.now() };
      tc.evt('dm', msg);
      return msg;
    },

    // ----- profile
    // Profile photos: PNG only (the app re-encodes any picked image to a 128px PNG, which also strips
    // EXIF/location data). Visible to yourself, your friends, and people in your lobby.
    'profile.setAvatar': (c, d) => {
      let png = null;
      if (d.data !== null) {
        if (typeof d.data !== 'string' || d.data.length > 200_000) fail('Image too large');
        png = Buffer.from(d.data, 'base64');
        const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        if (png.length < 33 || png.length > 140_000 || !sig.every((b, i) => png[i] === b)) fail('Not a valid PNG');
        const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
        if (w < 16 || h < 16 || w > 512 || h > 512) fail('Image must be 16-512 px');
      }
      c.user.av = db.setAvatar(c.user.id, png);
      broadcastPresence(c.user.id);
      const l = c.lobbyId && lobbies.get(c.lobbyId);
      if (l) broadcastLobby(l);
      return { av: c.user.av };
    },

    'profile.avatar': (c, d) => {
      const id = int(d.userId, 'userId', 1, 2 ** 31);
      const other = clients.get(id);
      const sameLobby = c.lobbyId && other && other.lobbyId === c.lobbyId;
      if (id !== c.user.id && !db.areFriends(c.user.id, id) && !sameLobby) fail('Not allowed');
      const a = db.getAvatar(id);
      return a ? { av: a.av, data: a.png.toString('base64') } : { av: null, data: null };
    },

    // ----- presence
    'presence.set': (c, d) => {
      if (d.status !== undefined) {
        if (!['online', 'away', 'busy'].includes(d.status)) fail('Bad status');
        c.status = d.status;
      }
      if (d.game !== undefined) c.game = d.game === null ? null : str(d.game, 'Game', 1, 80);
      broadcastPresence(c.user.id);
      return {};
    },

    // ----- lobbies
    'lobby.create': (c, d) => {
      const name = str(d.name, 'Lobby name', 1, 40);
      const game = str(d.game, 'Game', 1, 80);
      // Lobby Certified games are identified by their package id (+ version, so mismatches can be shown).
      let certified = null, version = null;
      if (d.certified !== undefined && d.certified !== null) {
        certified = str(d.certified, 'Game id', 3, 40);
        if (!/^[a-z0-9][a-z0-9-]*$/.test(certified)) fail('Bad game id');
        version = d.version === undefined ? null : str(d.version, 'Version', 1, 20);
      }
      const privacy = d.privacy === 'friends' ? 'friends' : 'invite';
      const maxPlayers = int(d.maxPlayers ?? 8, 'Max players', 2, 32);
      if (c.lobbyId) leaveLobby(c);
      const l = {
        id: rid(), name, game: { title: game, certified, version }, privacy, maxPlayers,
        hostId: c.user.id, members: new Map(), invites: new Map(), started: null,
      };
      lobbies.set(l.id, l);
      joinLobby(c, l);
      return lobbySnapshot(l);
    },

    'lobby.invite': (c, d) => {
      const l = lobbyOf(c);
      const to = int(d.userId, 'userId', 1, 2 ** 31);
      if (!db.areFriends(c.user.id, to)) fail('You can only invite friends');
      if (l.privacy === 'invite' && c.user.id !== l.hostId && !db.areFriends(l.hostId, to)) {
        fail('Only friends of the host can be invited');
      }
      const tc = clients.get(to);
      if (!tc) fail('Friend is offline');
      if (l.members.has(to)) fail('Already in the lobby');
      l.invites.set(to, Date.now() + LIMITS.inviteTtlMs);
      tc.evt('lobby.invite', { lobbyId: l.id, name: l.name, game: l.game, from: c.user.username });
      broadcastPresence(c.user.id); // joinable flag changed for the invitee
      return {};
    },

    'lobby.join': (c, d) => {
      const id = str(d.lobbyId, 'lobbyId', 4, 40);
      const l = lobbies.get(id);
      if (!l) fail('That lobby no longer exists');
      const exp = l.invites.get(c.user.id);
      const invited = exp && exp > Date.now();
      const allowed = invited || (l.privacy === 'friends' && db.areFriends(c.user.id, l.hostId));
      if (!allowed) fail('You need an invite to join this lobby');
      joinLobby(c, l);
      return lobbySnapshot(l);
    },

    'lobby.decline': (c, d) => {
      const l = lobbies.get(str(d.lobbyId, 'lobbyId', 4, 40));
      if (l) l.invites.delete(c.user.id);
      return {};
    },

    'lobby.leave': (c) => { leaveLobby(c); return {}; },

    'lobby.kick': (c, d) => {
      const l = lobbyOf(c);
      if (l.hostId !== c.user.id) fail('Only the host can kick');
      const id = int(d.userId, 'userId', 1, 2 ** 31);
      if (id === c.user.id) fail("You can't kick yourself");
      const tc = clients.get(id);
      if (tc && tc.lobbyId === l.id) leaveLobby(tc, 'You were removed from the lobby');
      l.invites.delete(id);
      return {};
    },

    'lobby.ready': (c, d) => {
      const l = lobbyOf(c);
      const m = l.members.get(c.user.id);
      m.ready = !!d.ready;
      broadcastLobby(l);
      return {};
    },

    'lobby.chat': (c, d) => {
      const l = lobbyOf(c);
      const text = str(d.text, 'Message', 1, 500);
      const msg = { from: c.user.id, fromName: c.user.username, text, at: Date.now() };
      for (const id of l.members.keys()) clients.get(id)?.evt('lobby.chat', msg);
      return {};
    },

    'lobby.start': (c) => {
      const l = lobbyOf(c);
      if (l.hostId !== c.user.id) fail('Only the host can start');
      l.started = { at: Date.now(), session: rid(6) };
      broadcastLobby(l);
      for (const id of l.members.keys()) clients.get(id)?.evt('lobby.started', { lobbyId: l.id, game: l.game, session: l.started.session, hostId: l.hostId });
      return {};
    },

    'lobby.stop': (c) => {
      const l = lobbyOf(c);
      if (l.hostId !== c.user.id) fail('Only the host can stop');
      l.started = null;
      broadcastLobby(l);
      for (const id of l.members.keys()) clients.get(id)?.evt('lobby.stopped', { lobbyId: l.id });
      return {};
    },

    // Built-in games: small JSON messages relayed to lobby members.
    'game.send': (c, d) => {
      const l = lobbyOf(c);
      if (!c.gameBucket()) return { dropped: true };
      const raw = JSON.stringify(d.data ?? null);
      if (raw.length > LIMITS.gameMsgBytes) fail('Game message too large');
      const to = d.to === undefined ? null : int(d.to, 'to', 1, 2 ** 31);
      const payload = JSON.stringify({ t: 'evt', e: 'game.msg', d: { from: c.user.id, data: d.data ?? null } });
      for (const id of l.members.keys()) {
        if (id === c.user.id || (to && id !== to)) continue;
        const mc = clients.get(id);
        if (mc?.ws.readyState === 1) mc.ws.send(payload);
      }
      return null; // fire and forget
    },

    // ----- relay tunnels (virtual LAN for .exe games / mods)
    // A member exposes a port that is running on THEIR OWN machine at 127.0.0.1. The server only
    // stores protocol+label; the actual port number never leaves the owner's computer.
    'tunnel.open': (c, d) => {
      const l = lobbyOf(c);
      const proto = d.proto === 'udp' ? 'udp' : 'tcp';
      const label = str(d.label ?? 'Game server', 'Label', 1, 40);
      if ([...tunnels.values()].filter((t) => t.lobbyId === l.id).length >= LIMITS.tunnelsPerLobby) fail('Too many shared ports');
      const t = { id: rid(), lobbyId: l.id, ownerId: c.user.id, proto, label };
      tunnels.set(t.id, t);
      broadcastLobby(l);
      return { tunnelId: t.id };
    },

    'tunnel.close': (c, d) => {
      const t = tunnels.get(str(d.tunnelId, 'tunnelId', 4, 40));
      if (!t || t.ownerId !== c.user.id) fail('Not your tunnel');
      closeTunnel(t.id);
      const l = lobbies.get(t.lobbyId);
      if (l) broadcastLobby(l);
      return {};
    },

    'stream.open': (c, d) => {
      const l = lobbyOf(c);
      const t = tunnels.get(str(d.tunnelId, 'tunnelId', 4, 40));
      if (!t || t.lobbyId !== l.id) fail('That shared port is gone');
      if (t.ownerId === c.user.id) fail("That's your own shared port");
      const owner = clients.get(t.ownerId);
      if (!owner) fail('Host is offline');
      let mine = 0;
      for (const s of streams.values()) if (s.peerId === c.user.id) mine++;
      if (mine >= LIMITS.streamsPerUser) fail('Too many open connections');
      let id;
      do { id = nextStreamId; nextStreamId = nextStreamId >= 0xfffffff0 ? 1 : nextStreamId + 1; } while (streams.has(id));
      streams.set(id, { id, tunnelId: t.id, hostId: t.ownerId, peerId: c.user.id, proto: t.proto });
      owner.evt('stream.incoming', { streamId: id, tunnelId: t.id, from: c.user.username });
      return { streamId: id };
    },
  };

  function notifyFriendsChanged(...userIds) {
    for (const id of userIds) clients.get(id)?.evt('friends.changed', friendsPayload(id));
  }

  // ---------------------------------------------------------------- binary relay
  // Frame: [op u8][streamId u32 BE][payload]. op 1 = data, 2 = close, 3 = half-close (FIN).
  function handleBinary(c, buf) {
    if (buf.length < 5) return;
    const op = buf[0];
    const id = buf.readUInt32BE(1);
    const s = streams.get(id);
    if (!s) return;
    const me = c.user.id;
    if (me !== s.hostId && me !== s.peerId) return; // not your stream: ignore
    const otherId = me === s.hostId ? s.peerId : s.hostId;
    if (op === 2) { closeStream(id, me); return; }
    if (op !== 1 && op !== 3) return;
    const oc = clients.get(otherId);
    if (!oc || oc.ws.readyState !== 1) { closeStream(id); return; }
    const buffered = oc.ws.bufferedAmount;
    if (s.proto === 'udp') {
      if (buffered > LIMITS.relayBufferUdp) return; // UDP: dropping is fine
    } else if (buffered > LIMITS.relayBufferTcp) {
      closeStream(id); return; // receiver can't keep up
    }
    oc.ws.send(buf); // forwarded untouched; sender identity is implied by the stream
  }

  // ---------------------------------------------------------------- connection lifecycle
  async function handleAuth(c, op, d) {
    if (!authAllowed(c.ip)) fail('Too many attempts, wait a minute');
    let user;
    if (op === 'auth.register') {
      const username = str(d.username, 'Username', 3, 20);
      if (!USERNAME_RE.test(username)) fail('Username: letters, numbers and _ only (3-20)');
      const password = typeof d.password === 'string' ? d.password : '';
      if (password.length < 8 || password.length > 128) fail('Password must be 8-128 characters');
      try { user = await db.register(username, password); } catch (e) { fail(e.message); }
    } else if (op === 'auth.login') {
      const username = str(d.username, 'Username', 1, 40);
      const password = typeof d.password === 'string' ? d.password.slice(0, 256) : '';
      try { user = await db.login(username, password); } catch (e) { fail(e.message); }
    } else if (op === 'auth.token') {
      const token = typeof d.token === 'string' ? d.token.slice(0, 200) : '';
      user = db.userForToken(token);
      if (!user) fail('Session expired, please log in again');
      c.token = token;
    } else {
      fail('Not logged in');
    }
    if (!c.token) c.token = db.createSession(user.id);

    // One live connection per account: kick the older one.
    const old = clients.get(user.id);
    if (old && old !== c) {
      old.evt('session.replaced', {});
      old.ws.close(4001, 'Logged in elsewhere');
      onClose(old);
    }
    c.user = { id: user.id, username: user.username, av: user.av || null };
    clients.set(user.id, c);
    broadcastPresence(user.id);
    return { user: c.user, token: c.token, ...friendsPayload(user.id) };
  }

  function onClose(c) {
    if (!c.user || clients.get(c.user.id) !== c) return;
    if (c.lobbyId) leaveLobby(c, 'Disconnected');
    clients.delete(c.user.id);
    broadcastPresence(c.user.id);
  }

  async function onMessage(c, raw, isBinary) {
    if (isBinary) { if (c.user) handleBinary(c, raw); return; }
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (!msg || msg.t !== 'req' || typeof msg.op !== 'string') return;
    const reply = (ok, d) => { if (msg.id !== undefined) c.send({ t: 'res', id: msg.id, ok, ...(ok ? { d } : { err: d }) }); };
    const d = msg.d && typeof msg.d === 'object' ? msg.d : {};
    try {
      if (msg.op.startsWith('auth.')) {
        if (msg.op === 'auth.logout') {
          if (c.token) db.deleteSession(c.token);
          reply(true, {});
          c.ws.close(1000, 'Logged out');
          return;
        }
        reply(true, await handleAuth(c, msg.op, d));
        return;
      }
      if (!c.user) fail('Not logged in');
      if (msg.op !== 'game.send' && !c.reqBucket()) fail('Slow down');
      const h = Object.hasOwn(handlers, msg.op) ? handlers[msg.op] : null;
      if (!h) fail('Unknown request');
      const result = await h(c, d);
      if (result !== null) reply(true, result);
    } catch (e) {
      if (e instanceof UserError) reply(false, e.message);
      else { log('[lobby] handler error', msg.op, e && e.stack); reply(false, 'Server error'); }
    }
  }

  function clientIp(req) {
    const remote = req.socket.remoteAddress || 'unknown';
    if (TRUST_PROXY && /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(remote)) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string') return cf;
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string') return xff.split(',')[0].trim();
    }
    return remote;
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, online: clients.size, lobbies: lobbies.size }));
      return;
    }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ server, maxPayload: LIMITS.maxFrame, perMessageDeflate: false });
  // ws re-emits http server errors (e.g. port in use); handle them so they reject below instead of crashing.
  wss.on('error', () => {});
  wss.on('connection', (ws, req) => {
    const c = new Client(ws, clientIp(req));
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => { onMessage(c, data, isBinary); });
    ws.on('close', () => onClose(c));
    ws.on('error', () => {});
    c.send({ t: 'hello', v: 1 });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const c = [...clients.values()].find((x) => x.ws === ws);
      if (c && !c.alive) { ws.terminate(); continue; }
      if (c) c.alive = false;
      ws.ping();
    }
    const now = Date.now();
    for (const l of lobbies.values()) for (const [uid, exp] of l.invites) if (exp < now) l.invites.delete(uid);
  }, 30_000).unref();

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, () => {
        server.off('error', reject);
        log(`[lobby] server listening on ws://${HOST}:${PORT}  (data: ${DATA_DIR})`);
        if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
          log('[lobby] WARNING: listening beyond localhost without TLS. Use only on a trusted LAN, or put it behind TLS (wss://).');
        }
        resolve({
          port: PORT,
          host: HOST,
          stats: () => ({ online: clients.size, lobbies: lobbies.size }),
          close: () => new Promise((res) => {
            clearInterval(heartbeat); clearInterval(authSweep);
            for (const ws of wss.clients) ws.terminate();
            wss.close(); server.close(() => { try { db.close(); } catch {} res(); });
          }),
        });
      });
    });
}

module.exports = { startServer };
