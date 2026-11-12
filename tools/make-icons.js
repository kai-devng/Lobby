// Renders the app icon + Blast Arena icon to PNG using an offscreen Electron canvas.
// Run: client\node_modules\electron\dist\electron.exe tools\make-icons.js
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'client');

const draw = {
  // App icon: gradient tile with three "friends" around a lobby table.
  app: `(() => {
    const s = 512, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
    const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    const bg = g.createLinearGradient(0, 0, s, s); bg.addColorStop(0, '#6b7bff'); bg.addColorStop(1, '#25b889');
    rr(16, 16, 480, 480, 112); g.fillStyle = bg; g.fill();
    const shine = g.createRadialGradient(150, 110, 10, 150, 110, 360); shine.addColorStop(0, 'rgba(255,255,255,.28)'); shine.addColorStop(1, 'rgba(255,255,255,0)');
    rr(16, 16, 480, 480, 112); g.fillStyle = shine; g.fill();
    g.fillStyle = '#fff';
    const person = (x, y, sc, a) => { g.globalAlpha = a; g.beginPath(); g.arc(x, y, 44 * sc, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(x, y + 112 * sc, 78 * sc, 58 * sc, 0, Math.PI, 0); g.fill(); g.globalAlpha = 1; };
    person(156, 218, 0.78, 0.75); person(356, 218, 0.78, 0.75); person(256, 196, 1, 1);
    rr(108, 330, 296, 52, 26); g.fillStyle = 'rgba(255,255,255,.95)'; g.fill();
    return c.toDataURL('image/png');
  })()`,
  // Blast Arena icon.
  arena: `(() => {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s; const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, s, s); bg.addColorStop(0, '#2a1f3d'); bg.addColorStop(1, '#0f1626');
    g.fillStyle = bg; g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(255,255,255,.06)'; for (let i = 0; i < s; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(s, i); g.stroke(); }
    const blob = (x, y, col, ang) => { g.save(); g.translate(x, y); g.fillStyle = col; g.beginPath(); g.arc(0, 0, 34, 0, Math.PI * 2); g.fill();
      g.rotate(ang); g.fillStyle = '#e8ecf4'; g.fillRect(26, -9, 34, 18); g.restore(); };
    blob(80, 170, '#7c8cff', -0.6); blob(186, 86, '#ff7a6b', 2.5);
    g.fillStyle = '#ffe9a8'; for (const [x, y] of [[124, 136], [146, 120], [168, 104]]) { g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill(); }
    return c.toDataURL('image/png');
  })()`,
};

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html,<html><body></body></html>');
  const save = async (expr, file) => {
    const url = await w.webContents.executeJavaScript(expr);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    console.log('wrote', file);
  };
  await save(draw.app, path.join(ROOT, 'build', 'icon.png'));
  await save(draw.arena, path.join(ROOT, 'certified', 'blast-arena', 'icon.png'));
  app.quit();
});
