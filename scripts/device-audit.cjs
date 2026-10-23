// Read-only diagnostics of this app's debug WebView. No account tokens are accessed.
const fs = require('node:fs');
const WebSocket = require('ws');

async function main() {
  const port = Number(process.env.AISS_CDP_PORT || 9223);
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
  const tab = tabs.find(t => t.url.startsWith('https://localhost'));
  if (!tab) throw new Error('Forward this app’s debug WebView with ADB first.');
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { handshakeTimeout: 5000 });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const request = ++id;
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error(method + ' timeout')); }, 10000);
    function receive(raw) { const result = JSON.parse(raw); if (result.id !== request) return; clearTimeout(timer); ws.off('message', receive); result.error ? reject(new Error(result.error.message)) : resolve(result.result); }
    ws.on('message', receive); ws.send(JSON.stringify({ id: request, method, params }));
  });
  try {
    const expression = `(async () => {
      const C = window.Capacitor;
      const plugin = C?.Plugins?.AissLocation;
      const native = plugin ? await plugin.getWalkingState().catch(e => ({error:e.message})) : null;
      const bg = await C?.Plugins?.AissNative?.isBackgroundServiceRunning().catch(e => ({error:e.message}));
      const floating = document.querySelector('.home-floating-header');
      return {title:document.title, role:await fetch('/build-role.json').then(r=>r.json()).catch(()=>null), nativeWalking:native && {enabled:native.enabled,tracking:native.tracking,today:native.today,paused:native.paused,error:native.error}, background:bg,
        viewport:{width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth}, header:floating && {background:getComputedStyle(floating).backgroundColor,backdropFilter:getComputedStyle(floating).backdropFilter}, atmosphere:[...document.querySelectorAll('.atmo-field')].map(e=>({transform:getComputedStyle(e).transform,animation:getComputedStyle(e).animationPlayState})), errors:[...document.querySelectorAll('[role="alert"]')].map(e=>e.textContent), text:document.body.innerText.slice(0,900)};
    })()`;
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    console.log(JSON.stringify(result.result.value, null, 2));
    const screenshot = process.argv[2];
    if (screenshot) { const shot = await call('Page.captureScreenshot', {format:'png'}); fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64')); }
  } finally { ws.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
