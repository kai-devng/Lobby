// Persistent storage: accounts, sessions, friendships. Lobbies are in-memory only.
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SESSION_DAYS = 30;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pass TEXT NOT NULL,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friendships (
      a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      PRIMARY KEY (a, b)
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created INTEGER NOT NULL,
      PRIMARY KEY (from_id, to_id)
    );
  `);

  // Migration: profile photos (PNG, re-encoded by the client, size-checked by the server).
  const cols = db.prepare('PRAGMA table_info(users)').all().map((r) => r.name);
  if (!cols.includes('avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar BLOB');
  if (!cols.includes('avatar_hash')) db.exec('ALTER TABLE users ADD COLUMN avatar_hash TEXT');

  const q = {
    userByName: db.prepare('SELECT id, username, pass, avatar_hash AS av FROM users WHERE username = ?'),
    userById: db.prepare('SELECT id, username, avatar_hash AS av FROM users WHERE id = ?'),
    setAvatar: db.prepare('UPDATE users SET avatar = ?, avatar_hash = ? WHERE id = ?'),
    getAvatar: db.prepare('SELECT avatar, avatar_hash AS av FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (username, pass, created) VALUES (?, ?, ?)'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)'),
    sessionUser: db.prepare(`SELECT u.id, u.username, u.avatar_hash AS av FROM sessions s JOIN users u ON u.id = s.user_id
                             WHERE s.token_hash = ? AND s.expires > ?`),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    friendIds: db.prepare('SELECT b AS id FROM friendships WHERE a = ?'),
    areFriends: db.prepare('SELECT 1 FROM friendships WHERE a = ? AND b = ?'),
    addFriend: db.prepare('INSERT OR IGNORE INTO friendships (a, b, created) VALUES (?, ?, ?)'),
    removeFriend: db.prepare('DELETE FROM friendships WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)'),
    addRequest: db.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created) VALUES (?, ?, ?)'),
    hasRequest: db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?'),
    delRequest: db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)'),
    incoming: db.prepare(`SELECT u.id, u.username FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = ?`),
    outgoing: db.prepare(`SELECT u.id, u.username FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = ?`),
  };

  const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

  async function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(pw, salt, 64, SCRYPT);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
  }
  async function verifyPassword(pw, stored) {
    const [, saltHex, keyHex] = stored.split('$');
    const key = await scrypt(pw, Buffer.from(saltHex, 'hex'), 64, SCRYPT);
    const expected = Buffer.from(keyHex, 'hex');
    return expected.length === key.length && crypto.timingSafeEqual(expected, key);
  }
  // Used when the username doesn't exist so login timing doesn't reveal which usernames exist.
  const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

  return {
    async register(username, password) {
      if (q.userByName.get(username)) throw new Error('That username is taken');
      const pass = await hashPassword(password);
      const r = q.insertUser.run(username, pass, Date.now());
      return { id: Number(r.lastInsertRowid), username };
    },
    async login(username, password) {
      const row = q.userByName.get(username);
      const ok = await verifyPassword(password, row ? row.pass : DUMMY_HASH);
      if (!row || !ok) throw new Error('Wrong username or password');
      return { id: row.id, username: row.username, av: row.av || null };
    },
    createSession(userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      q.insertSession.run(hashToken(token), userId, Date.now() + SESSION_DAYS * 86400e3);
      return token;
    },
    userForToken(token) {
      q.purgeSessions.run(Date.now());
      return q.sessionUser.get(hashToken(token), Date.now()) || null;
    },
    deleteSession(token) { q.deleteSession.run(hashToken(token)); },
    userByName(name) { const r = q.userByName.get(name); return r ? { id: r.id, username: r.username } : null; },
    userById(id) { return q.userById.get(id) || null; },
    friendIds(id) { return q.friendIds.all(id).map((r) => r.id); },
    areFriends(a, b) { return !!q.areFriends.get(a, b); },
    hasRequest(from, to) { return !!q.hasRequest.get(from, to); },
    addRequest(from, to) { q.addRequest.run(from, to, Date.now()); },
    clearRequests(a, b) { q.delRequest.run(a, b, b, a); },
    addFriendship(a, b) {
      const now = Date.now();
      q.addFriend.run(a, b, now);
      q.addFriend.run(b, a, now);
      q.delRequest.run(a, b, b, a);
    },
    removeFriendship(a, b) { q.removeFriend.run(a, b, b, a); },
    setAvatar(id, png) {
      const hash = png ? crypto.createHash('sha256').update(png).digest('hex').slice(0, 16) : null;
      q.setAvatar.run(png || null, hash, id);
      return hash;
    },
    getAvatar(id) { const r = q.getAvatar.get(id); return r && r.avatar ? { png: Buffer.from(r.avatar), av: r.av } : null; },
    close() { db.close(); },
    requests(id) { return { incoming: q.incoming.all(id), outgoing: q.outgoing.all(id) }; },
  };
}

module.exports = { openDb };
