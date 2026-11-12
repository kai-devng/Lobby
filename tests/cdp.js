// Dev helper: drive a Lobby window started with --remote-debugging-port.
// node tests/cdp.js <port> eval "<js>"   |   node tests/cdp.js <port> shot out.png
const WebSocket = require('ws');
const fs = require('node:fs');
const [port, cmd, arg] = process.argv.slice(2);
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const want = process.env.PAGE || 'renderer/index.html';
  const page = list.find((p) => p.type === 'page' && p.url.includes(want));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0;
  const send = (method, params) => new Promise((res) => {
    const my = ++id;
    ws.on('message', function f(m) { const d = JSON.parse(m); if (d.id === my) { ws.off('message', f); res(d); } });
    ws.send(JSON.stringify({ id: my, method, params }));
  });
  if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
    console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r, null, 1));
  } else if (cmd === 'reload') {
    console.log(JSON.stringify(await send('Page.reload', { ignoreCache: true })));
  } else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
    console.log('saved', arg);
  }
  ws.close();
})().catch((e) => { console.error(e); process.exit(1); });
