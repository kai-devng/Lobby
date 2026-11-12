// Boots Blast Arena in its Lobby game window. Talks to Lobby only via window.lobbyGame.
(async () => {
  const G = window.lobbyGame;
  const ctx = await G.init();
  if (!ctx) { window.close(); return; }
  document.title = ctx.solo ? 'Blast Arena - Practice' : 'Blast Arena';
  const arena = new window.BlastArena({
    canvas: document.getElementById('c'),
    me: ctx.me, hostId: ctx.hostId, members: ctx.members, solo: ctx.solo,
    send: (data, to) => G.send(data, to),
    onExit: () => G.close(),
  });
  window.__arena = arena; // debugging aid (dev tools)
  G.onMessage(({ from, data }) => arena.onMessage(from, data));
  G.onMembers((members) => arena.setMembers(members));
})();
