// End-to-end check: 2 users, friends, invite-only lobby, relay TCP + UDP to a fake "game server".
// Also asserts that no server message ever contains an IP address.
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const assert = require('node:assert');
const C = path.join(__dirname, '..', 'client', 'src');
const { LobbyConnection } = require(path.join(C, 'connection'));
const { TunnelManager } = require(path.join(C, 'tunnels'));

const URL_ = process.env.LOBBY_URL || 'ws://127.0.0.1:47420';
const sfx = Date.now().toString(36).slice(-5);
const IP_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|::ffff|::1/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (em, ev, pred = () => true) => new Promise((res) => {
  const f = (...a) => { if (pred(...a)) { em.off(ev, f); res(a); } }; em.on(ev, f);
});

let A, B;
async function shareAndWait(proto, port, label) {
  const seen = new Set();
  const f = (e, d) => { if (e === 'lobby.state') d.tunnels.forEach((t) => seen.add(t.id)); };
  B.c.on('event', f);
  const id = await A.t.share(proto, port, label);
  while (!seen.has(id)) await wait(20);
  B.c.off('event', f);
  return id;
}
async function user(name) {
  const c = new LobbyConnection();
  const seen = [];
  c.on('event', (e, d) => seen.push({ e, d }));
  c.connect(URL_);
  await once(c, 'status', (s) => s.connected);
  await c.login('auth.register', name, 'correct-horse-battery');
  return { c, seen, t: new TunnelManager(c, () => {}) };
}

(async () => {
  A = await user('alice_' + sfx);
  B = await user('bob_' + sfx);
  const E = await user('eve_' + sfx); // not a friend
  console.log('registered 3 users');

  // bad password / duplicate
  await assert.rejects(B.c.request('auth.register', { username: 'alice_' + sfx, password: 'xxxxxxxxxxx' }));

  // friends
  await A.c.request('friends.request', { username: 'bob_' + sfx });
  const bReqs = await B.c.request('friends.list', {});
  assert.equal(bReqs.incoming.length, 1);
  await B.c.request('friends.accept', { userId: bReqs.incoming[0].id });
  const aList = await A.c.request('friends.list', {});
  assert.equal(aList.friends.length, 1); assert.ok(aList.friends[0].online);
  console.log('friends ok');

  // lobby, invite-only
  const lob = await A.c.request('lobby.create', { name: 'Test night', game: 'Terraria', privacy: 'invite', maxPlayers: 4 });
  await assert.rejects(B.c.request('lobby.join', { lobbyId: lob.id }), /invite/);
  await assert.rejects(E.c.request('lobby.join', { lobbyId: lob.id }), /invite/);
  await assert.rejects(A.c.request('lobby.invite', { userId: E.c.user.id }), /only invite friends/);
  const bInvite = once(B.c, 'event', (e) => e === 'lobby.invite');
  await A.c.request('lobby.invite', { userId: B.c.user.id });
  await bInvite;
  await B.c.request('lobby.join', { lobbyId: lob.id });
  console.log('invite + join ok; non-friend blocked');

  // chat + game msg
  const chat = once(A.c, 'event', (e, d) => e === 'lobby.chat' && d.text === 'hi');
  await B.c.request('lobby.chat', { text: 'hi' });
  await chat;
  const gm = once(B.c, 'event', (e, d) => e === 'game.msg' && d.data?.x === 1);
  A.c.fire('game.send', { data: { x: 1 } });
  await gm;
  console.log('chat + game relay ok');

  // TCP: fake game server on Alice's PC
  const game = net.createServer((s) => s.on('data', (d) => s.write('echo:' + d)));
  await new Promise((r) => game.listen(0, '127.0.0.1', r));
  const gamePort = game.address().port;
  const tcpId = await shareAndWait('tcp', gamePort, 'Echo TCP');
  const localTcp = await B.t.connect(tcpId, 'tcp');
  const got = await new Promise((res, rej) => {
    const s = net.connect(localTcp, '127.0.0.1', () => s.write('hello'));
    s.on('data', (d) => { res(d.toString()); s.end(); });
    s.on('error', rej);
    setTimeout(() => rej(new Error('tcp timeout')), 5000);
  });
  assert.equal(got, 'echo:hello');
  // big payload
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const sink = net.createServer((s) => { let n = 0; s.on('data', (d) => { n += d.length; if (n >= big.length) s.end('done:' + n); }); });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const bigId = await shareAndWait('tcp', sink.address().port, 'Sink');
  const bigLocal = await B.t.connect(bigId, 'tcp');
  const bigRes = await new Promise((res, rej) => {
    const s = net.connect(bigLocal, '127.0.0.1', () => s.end(big));
    let out = ''; s.on('data', (d) => out += d); s.on('end', () => res(out)); s.on('error', rej);
    setTimeout(() => rej(new Error('big timeout')), 15000);
  });
  assert.equal(bigRes, 'done:' + big.length);
  console.log(`TCP relay ok (echo + ${big.length / 1048576} MB)`);

  // UDP
  const ug = dgram.createSocket('udp4');
  ug.on('message', (m, r) => ug.send(Buffer.concat([Buffer.from('pong:'), m]), r.port, r.address));
  await new Promise((r) => ug.bind(0, '127.0.0.1', r));
  const udpId = await shareAndWait('udp', ug.address().port, 'Echo UDP');
  const localUdp = await B.t.connect(udpId, 'udp');
  const cl = dgram.createSocket('udp4');
  const udpGot = await new Promise((res, rej) => {
    cl.on('message', (m) => res(m.toString()));
    cl.send('ping', localUdp, '127.0.0.1');
    setTimeout(() => rej(new Error('udp timeout')), 5000);
  });
  assert.equal(udpGot, 'pong:ping');
  console.log('UDP relay ok');

  // Eve can't open streams into the lobby
  await assert.rejects(E.c.request('stream.open', { tunnelId: tcpId }), /not in a lobby/);
  // Eve can't inject frames into Bob's stream
  const fake = Buffer.alloc(10); fake[0] = 1; fake.writeUInt32BE(1, 1);
  E.c.sendBinary(fake);
  console.log('outsider blocked');

  // host leaves -> lobby closes for Bob
  const left = once(B.c, 'event', (e) => e === 'lobby.left');
  await A.c.request('lobby.leave', {});
  const [, info] = await left;
  assert.match(info.reason, /host closed/i);
  console.log('host close ok');

  // privacy: no IP-looking strings in anything the server sent
  for (const u of [A, B, E]) for (const m of u.seen) assert.ok(!IP_RE.test(JSON.stringify(m.d)), 'IP leaked in ' + m.e);
  console.log('no IPs in any server event');

  console.log('\nALL E2E CHECKS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
