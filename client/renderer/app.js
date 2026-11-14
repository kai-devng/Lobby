// Lobby UI. Vanilla JS, no build step. All user-provided text goes through textContent (never
// innerHTML) so a friend's username or chat message can't inject markup/script.
(() => {
  const L = window.lobby;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- tiny DOM helper
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
  // Re-rendering replaces DOM nodes; keep typed text + focus for inputs marked data-keep.
  function keepInputs(root, fn) {
    const saved = new Map();
    root.querySelectorAll('[data-keep]').forEach((el) => saved.set(el.dataset.keep, el.value));
    const a = document.activeElement;
    const focusKey = a && root.contains(a) ? a.dataset?.keep : null;
    let sel = null; try { sel = focusKey ? [a.selectionStart, a.selectionEnd] : null; } catch {}
    fn();
    root.querySelectorAll('[data-keep]').forEach((el) => { if (saved.has(el.dataset.keep)) el.value = saved.get(el.dataset.keep); });
    if (focusKey) {
      const el = root.querySelector(`[data-keep="${CSS.escape(focusKey)}"]`);
      if (el) { el.focus(); try { if (sel && sel[0] !== null) el.setSelectionRange(sel[0], sel[1]); } catch {} }
    }
  }

  const DEFAULT_CERT = 'cert:blast-arena';
  const PALETTE = ['#5b6cf0', '#e0565b', '#2fae86', '#d99a2b', '#b65bd6', '#2b94c9', '#d9692b', '#7aa82b'];
  const colorFor = (name) => { let x = 0; for (const ch of String(name)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[x % PALETTE.length]; };

  // Profile photos: presence/lobby data carries a short hash ("av"); the image itself is fetched
  // once per hash and cached. Falls back to a colored initial.
  const AV = new Map();
  let avRerender = null;
  function avatarUrl(id, av) {
    const k = `${id}:${av}`;
    if (AV.has(k)) return AV.get(k);
    AV.set(k, null);
    L.net.req('profile.avatar', { userId: id }).then((r) => {
      if (r && r.data && r.av === av) {
        AV.set(k, `data:image/png;base64,${r.data}`);
        clearTimeout(avRerender);
        avRerender = setTimeout(() => { if (S.user) { renderMe(); renderAll(); } }, 30);
      }
    }).catch(() => {});
    return null;
  }
  function avatar(u, statusClass, size) {
    if (typeof u === 'string') u = { username: u };
    const cls = 'avatar' + (size === true || size === 'sm' ? ' sm' : size === 'xl' ? ' xl' : '');
    const dot = statusClass ? h('span', { class: 'dot ' + statusClass }) : null;
    const url = u && u.id && u.av ? avatarUrl(u.id, u.av) : null;
    if (url) return h('span', { class: cls + ' has-img' }, h('img', { src: url, alt: '' }), dot);
    const a = h('span', { class: cls }, String((u && u.username) || '?')[0].toUpperCase(), dot);
    a.style.background = colorFor(u && u.username);
    return a;
  }
  const fmtTime = (sec) => sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1)} hrs`;
  const fmtAgo = (t) => {
    if (!t) return 'Never';
    const d = (Date.now() - t) / 1000;
    if (d < 90) return 'Just now'; if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} hrs ago`; return new Date(t).toLocaleDateString();
  };

  // ---------------------------------------------------------------- state
  const S = {
    connected: false, user: null, serverUrl: '', profile: '',
    view: 'library', selected: DEFAULT_CERT, search: '',
    library: [], icons: new Map(), certified: [], hosting: null, version: '',
    friends: [], incoming: [], outgoing: [],
    lobby: null, chat: [], invites: [],
    tunnels: { hosted: [], joined: [] },
    dms: new Map(), openDms: [], unread: new Map(),
  };

  // ---------------------------------------------------------------- toasts & modal
  function toast(text, kind = 'info', actions, ttl = 5000) {
    const t = h('div', { class: 'toast ' + kind }, h('div', null, text));
    if (actions?.length) t.append(h('div', { class: 'actions' }, actions.map((a) =>
      h('button', { class: 'btn small ' + (a.primary ? 'primary' : ''), onclick: () => { a.run(); t.remove(); } }, a.label))));
    $('toasts').append(t);
    if (ttl) setTimeout(() => t.remove(), ttl);
    return t;
  }
  const errToast = (e) => toast(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
  const call = async (p) => { try { return await p; } catch (e) { errToast(e); throw e; } };

  function modal(title, body, foot) {
    const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back) close(); } });
    const close = () => back.remove();
    back.append(h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'btn ghost small', onclick: close }, 'Close')),
      h('div', { class: 'modal-body' }, body),
      foot ? h('div', { class: 'modal-foot' }, foot(close)) : null));
    $('modal-root').append(back);
    return close;
  }

  // ---------------------------------------------------------------- login
  function showLogin(err) {
    $('app').hidden = true; $('login').hidden = false;
    $('l-error').textContent = err || '';
    $('l-server').value = S.serverUrl;
    $('l-server-label').textContent = S.serverUrl;
    $('l-conn').className = 'dot' + (S.connected ? ' on' : '');
    // Not connected: instead of a dead login form, ask "hosting or joining?"
    const offline = !S.connected && S.statusSeen;
    $('l-offline').hidden = !offline;
    $('l-creds').hidden = !S.connected;
    $('l-connecting').hidden = S.connected || S.statusSeen;
    if (S.connected) setTimeout(() => $('l-user').focus(), 0);
  }
  const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  $('l-host').onclick = async () => {
    $('l-offline-error').textContent = '';
    $('l-host').disabled = true; $('l-host').textContent = 'Starting server…';
    try {
      const st = await L.hosting.set({ enabled: true });
      S.hosting = st;
      if (st.error) $('l-offline-error').textContent = st.error;
      else toast('Your server is running. Now create your account.', 'good', null, 6000);
    } catch (e) { $('l-offline-error').textContent = cleanErr(e); }
    $('l-host').disabled = false; $('l-host').textContent = 'Start a server on this PC';
  };
  const joinAddr = async () => {
    $('l-offline-error').textContent = '';
    if (/^\s*wss?:\/\/(127\.0\.0\.1|localhost|\[?::1\]?)([:/]|\s*$)/i.test($('l-join-addr').value)) {
      $('l-offline-error').textContent = "That address (127.0.0.1) only works on the host's own PC. Ask your host for the wss://….trycloudflare.com address from their Settings → Share over the internet.";
      return;
    }
    try {
      const r = await L.net.setServer($('l-join-addr').value);
      S.serverUrl = r.serverUrl;
      $('l-offline-error').textContent = 'Connecting…';
      setTimeout(() => { if (!S.connected) $('l-offline-error').textContent = "Couldn't reach that address. Check it's the latest one your host sent, and that their Lobby is open."; }, 8000);
    } catch (e) { $('l-offline-error').textContent = cleanErr(e); }
  };
  $('l-join').onclick = joinAddr;
  $('l-join-addr').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinAddr(); });
  async function doAuth(register) {
    const u = $('l-user').value.trim(), p = $('l-pass').value;
    $('l-error').textContent = '';
    try { await (register ? L.net.register(u, p) : L.net.login(u, p)); $('l-pass').value = ''; }
    catch (e) { $('l-error').textContent = String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  }
  $('l-login').onclick = () => doAuth(false);
  $('l-register').onclick = () => doAuth(true);
  $('l-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(false); });
  $('l-server-save').onclick = async () => {
    try {
      const r = await L.net.setServer($('l-server').value);
      S.serverUrl = r.serverUrl; $('l-server-label').textContent = r.serverUrl;
      if (r.insecure) $('l-error').textContent = 'Warning: ws:// is unencrypted. Over the internet use wss:// (TLS).';
    } catch (e) { $('l-error').textContent = String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  };

  function renderMe() {
    $('me-name').textContent = S.user.username + (S.profile ? ` · ${S.profile}` : '');
    const av = avatar(S.user); av.id = 'me-avatar';
    $('me-avatar').replaceWith(av);
  }
  function showApp() {
    $('login').hidden = true; $('app').hidden = false;
    renderMe();
    renderAll();
  }
  $('me-chip').onclick = (e) => { if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'OPTION') { S.view = 'settings'; renderAll(); } };
  $('me-status').onchange = (e) => L.net.req('presence.set', { status: e.target.value }).catch(errToast);

  // ---------------------------------------------------------------- tabs
  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => { S.view = b.dataset.view; renderAll(); });

  function renderAll() {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
    $('app').dataset.view = S.view; // CSS shows the library sidebar only in Library, friends only in Hub
    $('lobby-pill').hidden = !S.lobby;
    if (S.lobby) $('lobby-pill').textContent = S.lobby.members.length;
    $('conn-status').replaceChildren(h('span', { class: 'dot' + (S.connected ? ' on' : '') }), S.connected ? 'Connected' : 'Reconnecting…');
    renderLibraryList();
    renderFriends();
    renderView();
    renderDms();
  }

  // ---------------------------------------------------------------- library sidebar
  $('search').oninput = (e) => { S.search = e.target.value.toLowerCase(); renderLibraryList(); };
  $('add-game').onclick = async () => {
    const added = await call(L.library.addDialog());
    if (added?.length) { S.selected = added[added.length - 1].id; S.view = 'library'; toast(`Added ${added.length} game${added.length > 1 ? 's' : ''}`, 'good'); }
  };
  $('scan-games').onclick = scanFlow;

  function gameIcon(g, lg) {
    if (g.cert) {
      if (g.icon) return h('img', { class: 'gicon' + (lg ? ' lg' : ''), src: g.icon, alt: '' });
      const el = h('div', { class: 'gicon cert' + (lg ? ' lg' : '') }, g.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
      el.style.background = `linear-gradient(135deg, ${colorFor(g.id)}, ${colorFor(g.name + 'x')})`;
      return el;
    }
    const url = S.icons.get(g.id);
    if (url) return h('img', { class: 'gicon' + (lg ? ' lg' : ''), src: url, alt: '' });
    if (!S.icons.has(g.id)) {
      S.icons.set(g.id, null);
      L.library.icon(g.id).then((u) => { if (u) { S.icons.set(g.id, u); renderLibraryList(); if (S.selected === g.id) renderView(); } });
    }
    return h('div', { class: 'gicon' + (lg ? ' lg' : '') }, g.name.slice(0, 2).toUpperCase());
  }

  function renderLibraryList() {
    const el = clear($('game-list'));
    const match = (g) => !S.search || g.name.toLowerCase().includes(S.search);
    const item = (g) => h('div', {
      class: 'game-item' + (S.selected === g.id && S.view === 'library' ? ' active' : '') + (g.missing ? ' missing' : ''),
      onclick: () => { S.selected = g.id; S.view = 'library'; renderAll(); },
      ondblclick: () => { if (!g.cert) launch(g); },
      title: g.missing ? 'File not found' : g.name,
    }, gameIcon(g), h('span', { class: 'gname' }, g.name), g.running ? h('span', { class: 'run' }, '● Running') : null);

    el.append(h('div', { class: 'list-section' }, h('span', null, 'Lobby Certified'),
      h('button', { class: 'icon-btn', title: 'Add a Lobby Certified game', onclick: addCertifiedFlow }, '+')));
    certGames().filter(match).forEach((g) => el.append(item(g)));
    const games = S.library.filter(match).sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name));
    const favs = games.filter((g) => g.favorite), rest = games.filter((g) => !g.favorite);
    if (favs.length) { el.append(h('div', { class: 'list-section' }, 'Favorites')); favs.forEach((g) => el.append(item(g))); }
    el.append(h('div', { class: 'list-section' }, h('span', null, 'Your games'), h('span', null, String(S.library.length))));
    rest.forEach((g) => el.append(item(g)));
    if (!S.library.length) el.append(h('div', { class: 'muted small' }, h('p', { class: 'small' }, 'Add .exe files with “+ Add”, or scan a folder like D:\\Games.')));
  }

  async function scanFlow() {
    const r = await call(L.library.scanDialog());
    if (!r) return;
    const rows = r.found.filter((f) => !f.already).map((f) => ({ ...f, pick: true }));
    if (!rows.length) { toast(`No new games found in ${r.root}`); return; }
    // pre-select only the largest exe per folder (usually the real game)
    const seenDir = new Set();
    for (const row of rows) {
      const dir = row.exePath.split('\\').slice(0, -1).join('\\');
      row.pick = !seenDir.has(dir); seenDir.add(dir);
    }
    const body = h('div', null, h('p', { class: 'muted small' }, `Found ${rows.length} executables in ${r.root}. Untick anything that isn't a game and fix names if you like.`),
      rows.map((row) => h('div', { class: 'scan-row' },
        h('input', { type: 'checkbox', checked: row.pick, onchange: (e) => { row.pick = e.target.checked; } }),
        h('input', { type: 'text', value: row.name, oninput: (e) => { row.name = e.target.value; } }),
        h('span', { class: 'p', title: row.exePath }, row.exePath),
        h('span', { class: 'muted small' }, `${row.sizeMB} MB`))));
    modal('Add games from folder', body, (close) => [
      h('button', { class: 'btn', onclick: close }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: async () => {
        const picked = rows.filter((x) => x.pick).map((x) => ({ exePath: x.exePath, name: x.name.trim() || undefined }));
        const added = await call(L.library.addScanned(picked));
        close(); toast(`Added ${added.length} games`, 'good');
      } }, 'Add selected'),
    ]);
  }

  const certGames = () => S.certified.map((c) => ({ ...c, cert: true, certId: c.id, id: 'cert:' + c.id }));
  const certById = (id) => certGames().find((c) => c.certId === id) || null;

  function addCertifiedFlow() {
    const add = async (kind, close) => {
      const g = await call(L.certified.add(kind));
      if (!g) return;
      close();
      S.selected = 'cert:' + g.id; S.view = 'library';
      toast(`${g.name} ${g.version} added to Lobby Certified`, 'good');
      renderAll();
    };
    modal('Add a Lobby Certified game', h('div', { class: 'col gap' },
      h('p', { class: 'muted' }, 'Lobby Certified games are packages built for Lobby: a folder (or .zip of it) with a lobby-game.json inside. They run in a sandboxed window with no internet access, and multiplayer goes through your lobby.'),
      h('p', { class: 'muted small' }, 'Building one? Hand LOBBY-DEV-INSTRUCTIONS.md to any AI or developer. Everyone in a lobby needs the same game installed.')),
    (close) => [
      h('button', { class: 'btn', onclick: () => add('zip', close) }, 'Add .zip package'),
      h('button', { class: 'btn primary', onclick: () => add('folder', close) }, 'Add game folder'),
    ]);
  }

  async function launch(g) {
    if (g.running) { await call(L.library.stop(g.id)); return; }
    await call(L.library.launch(g.id));
    toast(`Launching ${g.name}…`, 'good', null, 2500);
  }

  // ---------------------------------------------------------------- main view
  function renderView() { keepInputs($('view'), renderViewInner); }
  function renderViewInner() {
    const v = clear($('view'));
    if (S.view === 'hub') return v.append(renderLobby());
    if (S.view === 'settings') return v.append(renderSettings());
    let g = S.selected.startsWith('cert:') ? certById(S.selected.slice(5)) : S.library.find((x) => x.id === S.selected);
    if (!g) { S.selected = DEFAULT_CERT; g = certById('blast-arena') || certGames()[0]; }
    if (!g) return v.append(h('div', { class: 'empty' }, h('h2', null, 'Your library is empty'), h('p', null, 'Add games with + Add or Scan.')));
    v.append(g.cert ? renderCertPage(g) : renderGamePage(g));
  }

  function renderCertPage(g) {
    const players = g.minPlayers === g.maxPlayers ? `${g.maxPlayers} players` : `${g.minPlayers}-${g.maxPlayers} players`;
    return h('div', null,
      h('div', { class: 'hero cert' },
        h('div', { class: 'hero-top' }, gameIcon(g, true),
          h('div', { class: 'grow' }, h('h1', null, g.name),
            h('div', { class: 'row gap wrap' }, h('span', { class: 'badge accent' }, 'Lobby Certified'),
              h('span', { class: 'muted' }, `${players} · v${g.version}${g.author ? ' · by ' + g.author : ''}`)))),
        h('div', { class: 'hero-bar' },
          h('button', { class: 'btn play', onclick: () => hostLobbyFor(g) }, 'HOST LOBBY'),
          g.solo ? h('button', { class: 'btn', onclick: () => startCert({ gameId: g.certId, solo: true }) }, 'Play solo') : null,
          h('div', { class: 'grow' }),
          !g.builtin ? h('button', { class: 'btn ghost', onclick: () => L.certified.reveal(g.certId) }, 'Open folder') : null,
          !g.builtin ? h('button', { class: 'btn danger', onclick: () => {
            modal('Remove game?', h('p', null, `Remove ${g.name} from Lobby Certified? You can add it again later.`), (close) => [
              h('button', { class: 'btn', onclick: close }, 'Cancel'),
              h('button', { class: 'btn danger', onclick: async () => { await call(L.certified.remove(g.certId)); S.selected = DEFAULT_CERT; close(); renderAll(); } }, 'Remove')]);
          } }, 'Remove') : null)),
      h('div', { class: 'section grid2' },
        h('div', { class: 'card' }, h('h4', null, 'About'), h('p', { class: 'muted' }, g.description || 'No description.')),
        h('div', { class: 'card' }, h('h4', null, 'How Lobby Certified games work'),
          h('p', { class: 'muted' }, "Host a lobby, invite friends, press Start, and the game opens in its own window for everyone. All game traffic goes through the Lobby relay and games have no internet access, so nobody gets anyone else's IP address. Everyone in the lobby needs the same game installed."))));
  }

  function renderGamePage(g) {
    const argsInput = h('input', { value: g.args || '', placeholder: 'e.g. -windowed -nosplash', spellcheck: 'false', 'data-keep': `g-args-${g.id}` });
    const nameInput = h('input', { value: g.name, maxlength: '80', 'data-keep': `g-name-${g.id}` });
    const modsBox = h('div', { class: 'mods-list' });
    if (g.modsDir) L.library.mods(g.id).then((list) => {
      clear(modsBox).append(...(list.length ? list.map((m) => h('div', null, (m.dir ? '📁 ' : '· ') + m.name)) : [h('div', null, 'Folder is empty')]));
    });
    return h('div', null,
      h('div', { class: 'hero' },
        h('div', { class: 'hero-top' }, gameIcon(g, true),
          h('div', { class: 'grow' }, h('h1', null, g.name), h('div', { class: 'path' }, g.exePath),
            g.missing ? h('div', { class: 'error' }, 'This .exe was not found. It may have been moved or uninstalled.') : null)),
        h('div', { class: 'hero-bar' },
          h('button', { class: 'btn play' + (g.running ? ' running' : ''), disabled: g.missing, onclick: () => launch(g) }, g.running ? 'STOP' : 'PLAY'),
          h('button', { class: 'btn', onclick: () => hostLobbyFor(g) }, 'Host lobby'),
          h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Last played'), h('span', { class: 'v' }, fmtAgo(g.lastPlayed))),
          h('div', { class: 'stat' }, h('span', { class: 'k' }, 'Play time'), h('span', { class: 'v' }, fmtTime(g.playtimeSec || 0))),
          h('div', { class: 'grow' }),
          h('button', { class: 'btn ghost', title: 'Favorite', onclick: () => call(L.library.update(g.id, { favorite: !g.favorite })) }, g.favorite ? '★ Favorited' : '☆ Favorite'),
          h('button', { class: 'btn ghost', onclick: () => L.library.reveal(g.id) }, 'Show in folder'))),
      h('div', { class: 'section grid2' },
        h('div', { class: 'card col gap' }, h('h4', null, 'Settings'),
          h('label', { class: 'field' }, h('span', null, 'Name'), nameInput),
          h('label', { class: 'field' }, h('span', null, 'Launch options'), argsInput),
          h('div', { class: 'row gap' },
            h('button', { class: 'btn primary', onclick: async () => { await call(L.library.update(g.id, { name: nameInput.value, args: argsInput.value })); toast('Saved', 'good', null, 1500); } }, 'Save'),
            h('div', { class: 'grow' }),
            h('button', { class: 'btn danger', onclick: () => {
              modal('Remove game?', h('p', null, `Remove “${g.name}” from your Lobby library? The game files are not touched.`), (close) => [
                h('button', { class: 'btn', onclick: close }, 'Cancel'),
                h('button', { class: 'btn danger', onclick: async () => { await call(L.library.remove(g.id)); S.selected = DEFAULT_CERT; close(); } }, 'Remove')]);
            } }, 'Remove from library'))),
        h('div', { class: 'card' }, h('h4', null, 'Mods (preview)'),
          h('p', { class: 'muted small' }, 'Point Lobby at this game\'s mods folder. Later: one-click mod sets you can sync with your lobby, plus Lobby Link for multiplayer mods.'),
          h('div', { class: 'row gap' },
            h('button', { class: 'btn small', onclick: () => call(L.library.pickMods(g.id)) }, g.modsDir ? 'Change folder' : 'Set mods folder'),
            g.modsDir ? h('button', { class: 'btn small', onclick: () => L.library.openMods(g.id) }, 'Open') : null),
          g.modsDir ? h('div', { class: 'path muted small' }, g.modsDir) : null,
          g.modsDir ? modsBox : null)));
  }

  // ---------------------------------------------------------------- lobby view
  function hostLobbyFor(g) { S.view = 'hub'; S.prefillGame = g; renderAll(); }

  function renderLobby() {
    if (!S.lobby) return renderLobbyBrowser();
    const l = S.lobby;
    const amHost = l.hostId === S.user.id;
    const me = l.members.find((m) => m.id === S.user.id);
    const inLobby = new Set(l.members.map((m) => m.id));

    const chatLog = h('div', { class: 'chat-log' }, S.chat.map((c) => c.system
      ? h('div', { class: 'chat-line system' }, c.text)
      : h('div', { class: 'chat-line' }, h('span', { class: 'who' }, c.fromName + ':'), c.text)));
    setTimeout(() => { chatLog.scrollTop = chatLog.scrollHeight; }, 0);
    const chatInput = h('input', { class: 'grow', placeholder: 'Say something…', maxlength: '500', 'data-keep': 'chat' });

    const invitable = S.friends.filter((f) => f.online && !inLobby.has(f.id));
    const certGame = l.game.certified ? certById(l.game.certified) : null;
    const localGame = !l.game.certified && findLocalGame(l.game.title);

    return h('div', { class: 'lobby-wrap' },
      h('div', { class: 'lobby-head' },
        certGame ? gameIcon(certGame) : (localGame ? gameIcon(localGame) : h('div', { class: 'gicon' }, '?')),
        h('div', { class: 'grow' }, h('h1', null, l.name),
          h('div', { class: 'row gap wrap' }, h('span', { class: 'muted' }, l.game.title),
            l.game.certified ? h('span', { class: 'badge accent' }, 'Lobby Certified') : null,
            l.game.certified && !certGame ? h('span', { class: 'badge warn' }, 'Not installed') : null,
            h('span', { class: 'badge' }, l.privacy === 'friends' ? 'Friends of host can join' : 'Invite only'),
            h('span', { class: 'badge' }, `${l.members.length}/${l.maxPlayers}`),
            l.started ? h('span', { class: 'badge good' }, 'In game') : null)),
        h('button', { class: 'btn' + (me?.ready ? ' good' : ''), onclick: () => L.net.req('lobby.ready', { ready: !me?.ready }).catch(errToast) }, me?.ready ? '✓ Ready' : 'Ready up'),
        amHost ? (l.started
          ? h('button', { class: 'btn', onclick: () => L.net.req('lobby.stop').catch(errToast) }, 'End game')
          : h('button', { class: 'btn primary', onclick: () => L.net.req('lobby.start').catch(errToast) }, 'Start game'))
          : (l.started ? h('button', { class: 'btn primary', onclick: () => onStarted({ game: l.game, hostId: l.hostId }) }, 'Rejoin game') : null),
        h('button', { class: 'btn danger', onclick: () => L.net.req('lobby.leave').catch(errToast) }, amHost ? 'Close lobby' : 'Leave')),

      h('div', { class: 'lobby-grid' },
        h('div', { class: 'col gap-lg' },
          h('div', { class: 'card' }, h('h4', null, 'Players'),
            l.members.map((m) => h('div', { class: 'member' }, avatar(m, null, true),
              h('span', { class: 'grow' }, m.username, m.id === S.user.id ? h('span', { class: 'muted' }, ' (you)') : null),
              m.id === l.hostId ? h('span', { class: 'crown' }, '♛ Host') : null,
              h('span', { class: m.ready ? 'ready' : 'notready' }, m.ready ? '✓ Ready' : 'Not ready'),
              amHost && m.id !== S.user.id ? h('button', { class: 'btn ghost small', title: 'Remove from lobby', onclick: () => L.net.req('lobby.kick', { userId: m.id }).catch(errToast) }, '✕') : null))),
          h('div', { class: 'card' }, h('h4', null, 'Invite friends'),
            invitable.length ? invitable.map((f) => h('div', { class: 'member' }, avatar(f, statusClass(f), true), h('span', { class: 'grow' }, f.username),
              h('button', { class: 'btn small', onclick: async () => { await call(L.net.req('lobby.invite', { userId: f.id })); toast(`Invited ${f.username}`, 'good', null, 2000); } }, 'Invite')))
              : h('p', { class: 'muted small' }, 'No online friends to invite right now.'))),
        h('div', { class: 'col gap-lg' },
          h('div', { class: 'card chat' }, h('h4', null, 'Lobby chat'), chatLog,
            h('form', { class: 'row gap', onsubmit: (e) => { e.preventDefault(); const t = chatInput.value.trim(); if (!t) return; chatInput.value = ''; L.net.req('lobby.chat', { text: t }).catch(errToast); } },
              chatInput, h('button', { class: 'btn' }, 'Send'))),
          renderNetworkCard(l))));
  }

  function renderNetworkCard(l) {
    const proto = h('select', { 'data-keep': 't-proto' }, h('option', { value: 'tcp' }, 'TCP'), h('option', { value: 'udp' }, 'UDP'));
    const port = h('input', { placeholder: 'Port, e.g. 7777', inputmode: 'numeric', maxlength: '5', 'data-keep': 't-port' });
    port.style.width = '140px';
    const label = h('input', { class: 'grow', placeholder: 'Label (e.g. Terraria server)', maxlength: '40', 'data-keep': 't-label' });
    const others = l.tunnels.filter((t) => t.ownerId !== S.user.id);
    const mine = l.tunnels.filter((t) => t.ownerId === S.user.id);
    const ownerName = (id) => l.members.find((m) => m.id === id)?.username || '?';

    return h('div', { class: 'card col gap' },
      h('h4', null, 'Relay network (play LAN / direct-IP games together)'),
      h('div', { class: 'shield' }, h('span', null, '🛡'), h('div', null,
        h('b', null, 'IP-safe: '),
        'all traffic is relayed through the Lobby server. Friends connect to 127.0.0.1 on their own PC, never to your address, and you never see theirs.')),
      h('p', { class: 'muted small' }, 'Running a game server or hosting in-game? Share its port here. Friends click Connect and point their game at the 127.0.0.1 address Lobby gives them.'),
      h('div', { class: 'row gap wrap share-row' }, proto, port, label,
        h('button', { class: 'btn', onclick: async () => {
          await call(L.tunnels.share(proto.value, Number(port.value), label.value.trim() || 'Game server'));
          document.querySelectorAll('[data-keep=t-port],[data-keep=t-label]').forEach((el) => { el.value = ''; });
          toast('Port shared with the lobby', 'good', null, 2000);
        } }, 'Share')),
      mine.map((t) => {
        const local = S.tunnels.hosted.find((x) => x.id === t.id);
        return h('div', { class: 'tunnel' }, h('span', { class: 'badge accent' }, t.proto.toUpperCase()), h('b', null, t.label),
          h('span', { class: 'muted small' }, `sharing your 127.0.0.1:${local ? local.port : '?'}`), h('div', { class: 'grow' }),
          h('button', { class: 'btn danger small', onclick: () => call(L.tunnels.unshare(t.id)) }, 'Stop sharing'));
      }),
      others.map((t) => {
        const j = S.tunnels.joined.find((x) => x.id === t.id);
        return h('div', { class: 'tunnel' }, h('span', { class: 'badge accent' }, t.proto.toUpperCase()), h('b', null, t.label),
          h('span', { class: 'muted small' }, `from ${ownerName(t.ownerId)}`), h('div', { class: 'grow' }),
          j ? [h('span', { class: 'muted small' }, 'Connect your game to'), h('span', { class: 'addr', title: 'Click to select' }, `127.0.0.1:${j.localPort}`),
               h('button', { class: 'btn small', onclick: () => call(L.tunnels.disconnect(t.id)) }, 'Disconnect')]
            : h('button', { class: 'btn primary small', onclick: () => call(L.tunnels.connect(t.id, t.proto)) }, 'Connect'));
      }));
  }

  function renderLobbyBrowser() {
    const certs = certGames();
    const games = [...certs, ...S.library];
    const pre = S.prefillGame || certs[0] || S.library[0] || {};
    S.prefillGame = null;
    const opt = (g) => h('option', { value: g.id, selected: g.id === pre.id ? true : null }, g.name);
    const gameSel = h('select', null,
      certs.length ? h('optgroup', { label: 'Lobby Certified' }, certs.map(opt)) : null,
      S.library.length ? h('optgroup', { label: 'Your games' }, S.library.map(opt)) : null,
      h('option', { value: '__other' }, 'Other game (type a name)…'));
    const other = h('input', { placeholder: 'Game name', maxlength: '80', hidden: true });
    gameSel.onchange = () => { other.hidden = gameSel.value !== '__other'; };
    const name = h('input', { value: `${S.user.username}'s lobby`, maxlength: '40', 'data-keep': 'lb-name' });
    const privacy = h('select', null, h('option', { value: 'invite' }, 'Invite only'), h('option', { value: 'friends' }, 'Friends can join'));
    const max = h('input', { type: 'number', min: '2', max: '32', value: '8' });

    const seen = new Set();
    const lobbiesList = S.friends.filter((f) => f.lobby?.joinable).map((f) => f.lobby).filter((lb) => !seen.has(lb.id) && seen.add(lb.id));

    return h('div', { class: 'lobby-wrap' },
      h('h1', null, 'Hub'),
      h('div', { class: 'grid2' },
        h('div', { class: 'card col gap' }, h('h4', null, 'Host a lobby'),
          h('label', { class: 'field' }, h('span', null, 'Name'), name),
          h('label', { class: 'field' }, h('span', null, 'Game'), gameSel, other),
          h('div', { class: 'row gap' },
            h('label', { class: 'field grow' }, h('span', null, 'Who can join'), privacy),
            h('label', { class: 'field' }, h('span', null, 'Max players'), max)),
          h('button', { class: 'btn primary', onclick: async () => {
            let game, certified = null, version;
            if (gameSel.value === '__other') game = other.value.trim();
            else { const g = games.find((x) => x.id === gameSel.value); if (g) { game = g.name; if (g.cert) { certified = g.certId; version = g.version; } } }
            if (!game) return toast('Pick a game', 'error');
            S.chat = [];
            const snap = await call(L.net.req('lobby.create', { name: name.value, game, certified, version, privacy: privacy.value, maxPlayers: Number(max.value) }));
            S.lobby = snap; renderAll();
          } }, 'Create lobby')),
        h('div', { class: 'card' }, h('h4', null, 'Invites & friends\' lobbies'),
          S.invites.map((inv) => h('div', { class: 'lobby-card' }, h('div', { class: 'grow' }, h('b', null, inv.name), h('div', { class: 'muted small' }, `${inv.game.title} · invited by ${inv.from}`)),
            h('button', { class: 'btn primary small', onclick: () => joinLobby(inv.lobbyId) }, 'Join'),
            h('button', { class: 'btn ghost small', onclick: () => declineInvite(inv) }, 'Decline'))),
          lobbiesList.filter((lb) => !S.invites.some((i) => i.lobbyId === lb.id)).map((lb) => h('div', { class: 'lobby-card' },
            h('div', { class: 'grow' }, h('b', null, lb.name), h('div', { class: 'muted small' }, `${lb.game.title} · host ${lb.host} · ${lb.count}/${lb.max}`)),
            h('button', { class: 'btn primary small', onclick: () => joinLobby(lb.id) }, 'Join'))),
          !S.invites.length && !lobbiesList.length ? h('p', { class: 'muted small' }, 'Nothing yet. When a friend invites you, or opens a “friends can join” lobby, it shows up here.') : null)));
  }

  async function joinLobby(id) {
    S.chat = [];
    const snap = await call(L.net.req('lobby.join', { lobbyId: id }));
    S.invites = S.invites.filter((i) => i.lobbyId !== id);
    S.lobby = snap; S.view = 'hub'; renderAll();
  }
  function declineInvite(inv) {
    S.invites = S.invites.filter((i) => i !== inv);
    L.net.req('lobby.decline', { lobbyId: inv.lobbyId }).catch(() => {});
    renderAll();
  }

  const findLocalGame = (title) => S.library.find((g) => g.name.toLowerCase() === String(title).toLowerCase());

  // ---------------------------------------------------------------- game start
  function onStarted({ game, hostId }) {
    if (game.certified) {
      const cg = certById(game.certified);
      if (!cg) {
        toast(`The host started ${game.title}, but you don't have it installed. Get the game package from the host and add it with + under Lobby Certified.`, 'error', null, 12000);
        return;
      }
      if (game.version && cg.version !== game.version) toast(`Heads up: the host has ${game.title} v${game.version}, you have v${cg.version}. If things act weird, update to match.`, 'info', null, 9000);
      startCert({ gameId: cg.certId, solo: false, hostId });
      return;
    }
    const g = findLocalGame(game.title);
    if (!g) {
      toast(`The host started ${game.title}, but it isn't in your library under that name. Add it, then launch it yourself.`, 'error', null, 9000);
      return;
    }
    if (g.running) return;
    if (hostId === S.user.id) { launch(g); return; }
    toast(`${game.title} is starting!`, 'good', [{ label: 'Launch now', primary: true, run: () => launch(g) }], 15000);
  }

  // Lobby Certified games open in their own sandboxed game window (managed by the main process).
  function startCert({ gameId, solo, hostId }) {
    L.game.open({ gameId, solo, hostId, members: solo ? [] : (S.lobby?.members || []).map((m) => ({ id: m.id, username: m.username })) }).catch(errToast);
  }
  function leaveArena() { /* the main process closes the game window when the lobby ends */ }

  // ---------------------------------------------------------------- settings
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = h('textarea', null); t.value = text; document.body.append(t); t.select();
      document.execCommand('copy'); t.remove();
    }
    toast('Copied', 'good', null, 1500);
  }
  const copyRow = (text) => h('div', { class: 'copy-row' }, h('code', { class: 'grow' }, text),
    h('button', { class: 'btn small', onclick: () => copyText(text) }, 'Copy'));
  function toggle(checked, onchange, label, hint) {
    return h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }),
      h('span', { class: 'switch' }),
      h('span', { class: 'col' }, h('span', null, label), hint ? h('span', { class: 'muted small' }, hint) : null));
  }

  function renderSettings() {
    const H = S.hosting || {};
    const server = h('input', { class: 'grow', value: S.serverUrl, spellcheck: 'false', 'data-keep': 'set-server' });
    const insecureRemote = /^ws:\/\//i.test(S.serverUrl) && !/^ws:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(S.serverUrl);

    const hostCard = h('div', { class: 'card col gap' },
      h('h4', null, 'Host a Lobby server on this PC'),
      h('p', { class: 'muted small' }, 'One person in your group runs the server; everyone else just connects to it. Your friends connect to the server, never to each other, so nobody sees anyone else\'s IP. Lobbies, friends and accounts live on whoever hosts.'),
      toggle(!!H.enabled, (v) => call(L.hosting.set({ enabled: v })).then((st) => { S.hosting = st; renderView(); }),
        'Run the server while Lobby is open', H.running ? `Running on port ${H.port}` : H.starting ? 'Starting…' : 'Off'),
      H.error ? h('p', { class: 'error' }, H.error) : null,
      H.enabled ? toggle(!!H.lan, (v) => call(L.hosting.set({ lan: v })).then((st) => { S.hosting = st; renderView(); }),
        'Allow LAN connections', 'For LAN parties: people on your home network can connect directly.') : null,
      H.running && H.lanUrls?.length ? h('div', { class: 'col gap' }, h('span', { class: 'muted small' }, 'LAN address(es) for people on your network:'), H.lanUrls.map(copyRow)) : null,
      H.running ? h('div', { class: 'subcard col gap' },
        h('b', null, 'Play with friends over the internet'),
        H.cloudflared
          ? [h('p', { class: 'muted small' }, 'Uses a free Cloudflare Tunnel: friends connect through Cloudflare, so your home IP stays hidden and you don\'t need to open any ports.'),
             H.tunnelRunning
               ? (H.tunnelUrl
                 ? [h('span', { class: 'muted small' }, 'Send your friends this server address (it changes each time you start sharing):'), copyRow(H.tunnelUrl),
                    h('button', { class: 'btn danger small', onclick: () => L.hosting.tunnel(false) }, 'Stop sharing')]
                 : h('p', { class: 'muted small' }, 'Starting tunnel…'))
               : h('button', { class: 'btn primary', onclick: () => L.hosting.tunnel(true) }, 'Share over the internet')]
          : [h('p', { class: 'muted small' }, 'To let friends connect over the internet without opening ports or revealing your IP, install Cloudflare\'s free tunnel tool once, then restart Lobby. Open a terminal and run:'),
             copyRow('winget install --id Cloudflare.cloudflared')],
        H.tunnelError ? h('p', { class: 'error' }, H.tunnelError) : null) : null);

    return h('div', { class: 'settings-wrap' },
      h('h1', null, 'Settings'),
      h('div', { class: 'card profile-card' },
        avatar(S.user, null, 'xl'),
        h('div', { class: 'col gap grow' },
          h('h2', null, S.user.username),
          h('p', { class: 'muted small' }, 'Your profile photo is visible to your friends and to people in your lobbies. Any image works; Lobby crops it to a square and strips its metadata.'),
          h('div', { class: 'row gap' },
            h('button', { class: 'btn primary', onclick: async () => {
              const r = await call(L.profile.pickAvatar());
              if (r) { S.user.av = r.av; renderMe(); renderView(); toast('Profile photo updated', 'good', null, 2000); }
            } }, S.user.av ? 'Change photo' : 'Upload photo'),
            S.user.av ? h('button', { class: 'btn', onclick: async () => { await call(L.profile.clearAvatar()); S.user.av = null; renderMe(); renderView(); } }, 'Remove photo') : null))),
      h('div', { class: 'card col gap' },
        h('h4', null, 'Server'),
        h('p', { class: 'muted small' }, 'The Lobby server your group uses. Changing it signs you in on that server instead.'),
        h('div', { class: 'row gap' }, server,
          h('button', { class: 'btn', onclick: async () => {
            const r = await call(L.net.setServer(server.value));
            S.serverUrl = r.serverUrl;
            if (r.insecure) toast('ws:// is unencrypted. Over the internet, use a wss:// address.', 'error', null, 8000);
          } }, 'Connect')),
        h('div', { class: 'row gap muted small' }, h('span', { class: 'dot' + (S.connected ? ' on' : '') }), S.connected ? 'Connected' : 'Not connected'),
        insecureRemote ? h('p', { class: 'error' }, 'This address is unencrypted (ws://). Only use it on your own network.') : null),
      hostCard,
      h('div', { class: 'card row gap' },
        h('div', { class: 'grow col' }, h('h4', null, 'Account'), h('span', { class: 'muted small' }, `Lobby ${S.version ? 'v' + S.version : ''}`)),
        h('button', { class: 'btn danger', onclick: async () => { await L.net.logout(); } }, 'Log out')));
  }

  // ---------------------------------------------------------------- friends panel
  const statusClass = (f) => !f.online ? '' : f.game ? 'ingame' : f.status;
  function statusText(f) {
    if (!f.online) return 'Offline';
    if (f.game) return `Playing ${f.game}`;
    if (f.lobby) return `In lobby: ${f.lobby.game.title}`;
    return { online: 'Online', away: 'Away', busy: 'Do not disturb' }[f.status] || 'Online';
  }

  $('add-friend').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('friend-name').value.trim();
    if (!name) return;
    const r = await call(L.net.req('friends.request', { username: name }));
    $('friend-name').value = '';
    toast(r.accepted ? `You and ${name} are now friends` : `Friend request sent to ${name}`, 'good', null, 2500);
  };

  function renderFriends() {
    const online = S.friends.filter((f) => f.online).length;
    $('friends-count').textContent = `${online}/${S.friends.length}`;
    const req = clear($('friend-requests'));
    if (S.incoming.length || S.outgoing.length) {
      req.append(h('div', { class: 'requests' },
        S.incoming.map((u) => h('div', { class: 'request' }, avatar(u, null, true), h('span', { class: 'grow' }, u.username),
          h('button', { class: 'btn primary small', onclick: () => L.net.req('friends.accept', { userId: u.id }).catch(errToast) }, 'Accept'),
          h('button', { class: 'btn ghost small', onclick: () => L.net.req('friends.decline', { userId: u.id }).catch(errToast) }, '✕'))),
        S.outgoing.map((u) => h('div', { class: 'request muted small' }, h('span', { class: 'grow' }, `Pending: ${u.username}`),
          h('button', { class: 'btn ghost small', title: 'Cancel request', onclick: () => L.net.req('friends.decline', { userId: u.id }).catch(errToast) }, 'Cancel')))));
    }
    const list = clear($('friend-list'));
    const order = (f) => (f.online ? (f.game ? 0 : f.lobby ? 1 : 2) : 3);
    const sorted = [...S.friends].sort((a, b) => order(a) - order(b) || a.username.localeCompare(b.username));
    if (!sorted.length) list.append(h('p', { class: 'muted small' }, 'Add friends by their Lobby username. They\'ll see your request next time they\'re online.'));
    for (const f of sorted) {
      const unread = S.unread.get(f.id) || 0;
      const canJoin = f.lobby?.joinable && S.lobby?.id !== f.lobby.id;
      const canInvite = S.lobby && f.online && !S.lobby.members.some((m) => m.id === f.id);
      list.append(h('div', { class: 'friend' + (f.online ? '' : ' offline'), onclick: () => openDm(f.id), title: 'Click to chat' },
        avatar(f, statusClass(f), true),
        h('div', { class: 'ftext' }, h('div', { class: 'fname' }, f.username), h('div', { class: 'fsub' + (f.game ? ' ingame' : '') }, statusText(f))),
        unread ? h('span', { class: 'unread' }, String(unread)) : null,
        h('div', { class: 'friend-actions', onclick: (e) => e.stopPropagation() },
          canJoin ? h('button', { class: 'btn primary small', onclick: () => joinLobby(f.lobby.id) }, 'Join') : null,
          canInvite ? h('button', { class: 'btn small', onclick: async () => { await call(L.net.req('lobby.invite', { userId: f.id })); toast(`Invited ${f.username}`, 'good', null, 2000); } }, 'Invite') : null,
          h('button', { class: 'btn ghost small', title: 'Remove friend', onclick: () => {
            modal('Remove friend?', h('p', null, `Remove ${f.username} from your friends?`), (close) => [
              h('button', { class: 'btn', onclick: close }, 'Cancel'),
              h('button', { class: 'btn danger', onclick: () => { L.net.req('friends.remove', { userId: f.id }).catch(errToast); close(); } }, 'Remove')]);
          } }, '⋯'))));
    }
  }

  // ---------------------------------------------------------------- direct messages
  function openDm(id) {
    if (!S.openDms.includes(id)) S.openDms.push(id);
    if (S.openDms.length > 3) S.openDms.shift();
    S.unread.delete(id);
    renderFriends(); renderDms();
  }
  function renderDms() { keepInputs($('dm-dock'), renderDmsInner); }
  function renderDmsInner() {
    const dock = clear($('dm-dock'));
    for (const id of S.openDms) {
      const f = S.friends.find((x) => x.id === id);
      if (!f) continue;
      const msgs = S.dms.get(id) || [];
      const log = h('div', { class: 'dm-log' }, msgs.map((m) => h('div', { class: 'bubble' + (m.from === S.user.id ? ' mine' : '') }, m.text)),
        !f.online ? h('div', { class: 'muted small' }, `${f.username} is offline. Messages aren't stored, so they can't be sent right now.`) : null);
      const input = h('input', { placeholder: `Message ${f.username}`, maxlength: '1000', 'data-keep': `dm-${id}` });
      dock.append(h('div', { class: 'dm' },
        h('div', { class: 'dm-head' }, avatar(f, statusClass(f), true), h('span', { class: 'grow' }, f.username),
          h('button', { class: 'btn ghost small', onclick: () => { S.openDms = S.openDms.filter((x) => x !== id); renderDms(); } }, '✕')),
        log,
        h('form', { onsubmit: async (e) => {
          e.preventDefault();
          const text = input.value.trim(); if (!text) return;
          const m = await call(L.net.req('dm.send', { userId: id, text }));
          input.value = '';
          pushDm(id, m); renderDms();
        } }, input, h('button', { class: 'btn small' }, 'Send'))));
      setTimeout(() => { log.scrollTop = log.scrollHeight; }, 0);
    }
  }
  function pushDm(id, m) {
    const arr = S.dms.get(id) || [];
    arr.push(m); if (arr.length > 200) arr.shift();
    S.dms.set(id, arr);
  }

  // ---------------------------------------------------------------- server events
  function setFriends(p) { if (!p) return; S.friends = p.friends || []; S.incoming = p.incoming || []; S.outgoing = p.outgoing || []; }

  L.net.onStatus((s) => {
    S.connected = s.connected;
    S.statusSeen = true;
    if (s.connected) $('l-offline-error').textContent = '';
    if (s.serverUrl) S.serverUrl = s.serverUrl;
    if (!s.connected) { if (S.lobby) toast('Lost connection to the Lobby server', 'error'); S.lobby = null; leaveArena(); }
    if (S.user) renderAll(); else showLogin(s.connected ? '' : $('l-error').textContent);
  });

  L.net.onAuth((a) => {
    S.user = a.user;
    if (!a.user) { S.lobby = null; S.friends = []; leaveArena(); showLogin(a.error); return; }
    setFriends(a.friends);
    showApp();
  });

  L.net.onEvent(({ e, d }) => {
    switch (e) {
      case 'friend.update': {
        const i = S.friends.findIndex((f) => f.id === d.id);
        if (i >= 0) S.friends[i] = d; else S.friends.push(d);
        renderFriends(); renderDms(); if (S.view === 'hub') renderView();
        return;
      }
      case 'friends.changed':
        setFriends(d);
        renderAll(); return;
      case 'lobby.state':
        S.lobby = d;
        renderAll(); return;
      case 'lobby.left':
        S.lobby = null; S.chat = []; leaveArena();
        if (d.reason !== 'You left the lobby') toast(d.reason, 'info');
        renderAll(); return;
      case 'lobby.chat':
        S.chat.push(d); if (S.chat.length > 300) S.chat.shift();
        if (S.view === 'hub') renderView(); return;
      case 'lobby.invite':
        S.invites = S.invites.filter((i) => i.lobbyId !== d.lobbyId).concat(d);
        toast(`${d.from} invited you to “${d.name}” (${d.game.title})`, 'info', [
          { label: 'Join', primary: true, run: () => joinLobby(d.lobbyId) },
          { label: 'Decline', run: () => declineInvite(d) }], 30000);
        if (S.view === 'hub') renderView();
        return;
      case 'lobby.started': onStarted(d); return;
      case 'lobby.stopped': return;
      case 'dm': {
        pushDm(d.from, d);
        if (!S.openDms.includes(d.from)) { S.unread.set(d.from, (S.unread.get(d.from) || 0) + 1); toast(`${d.fromName}: ${d.text.slice(0, 80)}`, 'info', [{ label: 'Reply', primary: true, run: () => openDm(d.from) }]); }
        renderFriends(); renderDms(); return;
      }
      case 'session.replaced':
        toast('You logged in somewhere else, so this window was signed out.', 'error', null, 0); return;
      default:
    }
  });

  L.certified.onChanged((list) => { S.certified = list; renderAll(); });
  L.hosting.onState((st) => { S.hosting = st; if (S.view === 'settings') renderView(); });
  L.library.onChanged((list) => { S.library = list; renderLibraryList(); if (S.view === 'library') renderView(); });
  L.tunnels.onState((t) => { S.tunnels = t; if (S.view === 'hub') renderView(); });
  L.onToast((t) => toast(t.text, t.kind));

  // ---------------------------------------------------------------- boot
  (async () => {
    const st = await L.net.state();
    S.connected = st.connected; S.serverUrl = st.serverUrl; S.profile = st.profile; S.version = st.version;
    S.library = await L.library.list();
    S.certified = await L.certified.list();
    S.hosting = await L.hosting.state();
    S.tunnels = await L.tunnels.state();
    if (st.user) { S.user = st.user; setFriends(await L.net.req('friends.list').catch(() => null)); showApp(); }
    else {
      showLogin();
      // If no server answers quickly, stop saying "Connecting…" and offer host/join.
      setTimeout(() => { if (!S.connected && !S.user) { S.statusSeen = true; showLogin($('l-error').textContent); } }, 2500);
    }
  })();
})();
