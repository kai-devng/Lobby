// Tap Race - the smallest useful Lobby Certified game. Shows the whole lobbyGame API:
//   init() -> who am I, who is host, who is playing
//   send(data, toUserId?) / onMessage(({from, data}) => ...)  -> relay messages
//   onMembers(list => ...) -> players joined/left
//   close() -> leave the game window
// Pattern: the HOST owns the game state. Everyone sends their input to the host; the host
// applies it and broadcasts the state. (Solo mode = you are the host and nobody else is there.)
(async () => {
  const G = window.lobbyGame;
  const ctx = await G.init();               // { gameId, solo, isHost, hostId, me:{id,username}, members:[...] }
  const GOAL = 100;

  // --- state (only the host's copy is authoritative)
  let state = { players: {}, winner: null };
  const addPlayer = (m) => { if (!state.players[m.id]) state.players[m.id] = { name: m.username, pos: 0 }; };
  if (ctx.isHost) ctx.members.forEach(addPlayer);

  // --- rendering
  const lanes = document.getElementById('lanes');
  const status = document.getElementById('status');
  function render() {
    lanes.replaceChildren(...Object.entries(state.players).map(([id, p]) => {
      const lane = document.createElement('div');
      lane.className = 'lane' + (Number(id) === ctx.me.id ? ' me' : '');
      const name = document.createElement('div'); name.className = 'name'; name.textContent = p.name; // textContent: never innerHTML with player names
      const track = document.createElement('div'); track.className = 'track';
      const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = `${Math.min(100, p.pos / GOAL * 100)}%`;
      track.append(bar); lane.append(name, track);
      return lane;
    }));
    status.textContent = state.winner ? `${state.winner} wins! Restarting…` : '';
  }

  // --- host logic
  function hostApplyTap(playerId) {
    const p = state.players[playerId];
    if (!p || state.winner) return;
    p.pos += 2;
    if (p.pos >= GOAL) {
      state.winner = p.name;
      setTimeout(() => { for (const q of Object.values(state.players)) q.pos = 0; state.winner = null; broadcast(); render(); }, 3000);
    }
    broadcast();
    render();
  }
  let pending = false;
  function broadcast() {                     // throttle: at most one state message per frame
    if (ctx.solo || pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; G.send({ t: 'state', state }); });
  }

  // --- input
  let held = false;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') { G.close(); return; }
    if (e.code !== 'Space' || held) return;  // one tap per key press, no auto-repeat
    held = true;
    if (ctx.isHost) hostApplyTap(ctx.me.id);
    else G.send({ t: 'tap' }, ctx.hostId);  // send input to the host only
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') held = false; });

  // --- network
  G.onMessage(({ from, data }) => {
    if (!data || typeof data !== 'object') return;              // always validate: data comes from other players
    if (ctx.isHost && data.t === 'tap') hostApplyTap(from);      // "from" is set by Lobby, can't be faked
    if (!ctx.isHost && data.t === 'state' && from === ctx.hostId && data.state) { state = data.state; render(); }
  });
  G.onMembers((members) => {
    if (!ctx.isHost) return;
    const ids = new Set(members.map((m) => String(m.id)));
    members.forEach(addPlayer);
    for (const id of Object.keys(state.players)) if (!ids.has(id)) delete state.players[id];
    broadcast(); render();
  });

  if (!ctx.isHost) G.send({ t: 'hello' }, ctx.hostId);        // ask the host for the current state
  G.onMessage(({ data }) => { if (ctx.isHost && data?.t === 'hello') broadcast(); });
  render();
})();
