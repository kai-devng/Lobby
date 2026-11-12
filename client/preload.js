// The only bridge between the UI and the system. Exposes a fixed set of functions, no Node access.
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('lobby', {
  net: {
    state: () => ipcRenderer.invoke('net:state'),
    setServer: (url) => ipcRenderer.invoke('net:setServer', url),
    login: (u, p) => ipcRenderer.invoke('net:login', u, p),
    register: (u, p) => ipcRenderer.invoke('net:register', u, p),
    logout: () => ipcRenderer.invoke('net:logout'),
    req: (op, d) => ipcRenderer.invoke('net:req', op, d),
    onStatus: on('net:status'),
    onAuth: on('net:auth'),
    onEvent: on('net:event'),
  },
  game: {
    open: (opts) => ipcRenderer.invoke('game:open', opts),
    onClosed: on('game:closed'),
  },
  certified: {
    list: () => ipcRenderer.invoke('certified:list'),
    add: (kind) => ipcRenderer.invoke('certified:add', kind),
    remove: (id) => ipcRenderer.invoke('certified:remove', id),
    reveal: (id) => ipcRenderer.invoke('certified:reveal', id),
    onChanged: on('certified:changed'),
  },
  profile: {
    pickAvatar: () => ipcRenderer.invoke('profile:pickAvatar'),
    clearAvatar: () => ipcRenderer.invoke('profile:clearAvatar'),
  },
  hosting: {
    state: () => ipcRenderer.invoke('hosting:state'),
    set: (o) => ipcRenderer.invoke('hosting:set', o),
    tunnel: (on) => ipcRenderer.invoke('hosting:tunnel', on),
    onState: on('hosting:state'),
  },
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    addDialog: () => ipcRenderer.invoke('library:addDialog'),
    scanDialog: () => ipcRenderer.invoke('library:scanDialog'),
    addScanned: (items) => ipcRenderer.invoke('library:addScanned', items),
    update: (id, f) => ipcRenderer.invoke('library:update', id, f),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    launch: (id) => ipcRenderer.invoke('library:launch', id),
    stop: (id) => ipcRenderer.invoke('library:stop', id),
    reveal: (id) => ipcRenderer.invoke('library:reveal', id),
    icon: (id) => ipcRenderer.invoke('library:icon', id),
    pickMods: (id) => ipcRenderer.invoke('library:pickMods', id),
    openMods: (id) => ipcRenderer.invoke('library:openMods', id),
    mods: (id) => ipcRenderer.invoke('library:mods', id),
    onChanged: on('library:changed'),
  },
  tunnels: {
    share: (proto, port, label) => ipcRenderer.invoke('tunnel:share', proto, port, label),
    unshare: (id) => ipcRenderer.invoke('tunnel:unshare', id),
    connect: (id, proto, localPort) => ipcRenderer.invoke('tunnel:connect', id, proto, localPort),
    disconnect: (id) => ipcRenderer.invoke('tunnel:disconnect', id),
    state: () => ipcRenderer.invoke('tunnel:state'),
    onState: on('tunnels:state'),
  },
  onToast: on('toast'),
});
