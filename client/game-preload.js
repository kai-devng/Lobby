// Bridge for Lobby Certified game windows. A game gets exactly this: who is playing, and a relay
// channel to the other players. No Node, no network, no file system.
const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Belt and braces against IP leaks: games can't create WebRTC connections at all.
webFrame.executeJavaScript(`(() => {
  for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceCandidate', 'RTCSessionDescription']) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch {}
  }
})()`);

const on = (ch) => (fn) => {
  const h = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('lobbyGame', {
  apiVersion: 1,
  init: () => ipcRenderer.invoke('gamewin:init'),
  send: (data, to) => ipcRenderer.send('gamewin:send', data, to),
  close: () => ipcRenderer.invoke('gamewin:close'),
  onMessage: on('gamewin:msg'),
  onMembers: on('gamewin:members'),
});
