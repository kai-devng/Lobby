// Standalone Lobby server (for an always-on PC/VPS). The same server also runs inside the Lobby app
// via Settings -> "Host a Lobby server on this PC". Core code lives in client/src/server/.
//   LOBBY_PORT=47420  LOBBY_HOST=127.0.0.1  LOBBY_DATA=./data  LOBBY_TRUST_PROXY=1 (behind cloudflared)
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { startServer } = require('../../client/src/server/core.js');

startServer({
  port: Number(process.env.LOBBY_PORT || 47420),
  host: process.env.LOBBY_HOST || '127.0.0.1',
  dataDir: process.env.LOBBY_DATA || path.join(__dirname, '..', 'data'),
  trustProxy: process.env.LOBBY_TRUST_PROXY === '1',
}).catch((e) => { console.error('[lobby] could not start:', e.message); process.exit(1); });
