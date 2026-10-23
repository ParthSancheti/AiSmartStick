// Requires an ADB debug-WebView forward on localhost:9222. Uploads only an explicitly
// selected JPEG fixture. The phone's existing token stays inside its WebView.
const fs = require('node:fs');
const WebSocket = require('ws');
async function main() {
  const fixtureIndex = process.argv.indexOf('--image');
  const fixturePath = fixtureIndex >= 0 ? process.argv[fixtureIndex + 1] : undefined;
  if (!fixturePath || fixturePath.startsWith('--')) throw new Error('Usage: node scripts/check-phone-vision.cjs --image <local-public-test.jpg>. The selected image is uploaded to the configured scene-analysis server.');
  const fixture = fs.readFileSync(fixturePath);
  if (fixture.length < 3 || fixture[0] !== 0xff || fixture[1] !== 0xd8 || fixture[2] !== 0xff) throw new Error('The explicit test fixture must be a JPEG image.');
  const tabs = await (await fetch('http://127.0.0.1:9222/json', { signal: AbortSignal.timeout(5000) })).json();
  const tab = tabs.find(t => t.url.startsWith('https://localhost'));
  if (!tab) throw new Error('SmartStick WebView is not available');
  const image = fixture.toString('base64');
  const project = JSON.parse(fs.readFileSync('.firebaserc','utf8')).projects.default;
  const expression = `(async () => {
    const db = await new Promise((resolve,reject) => { const r=indexedDB.open('firebaseLocalStorageDb'); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(Error('Auth storage unavailable')); });
    const rows = await new Promise((resolve,reject) => { const r=db.transaction('firebaseLocalStorage','readonly').objectStore('firebaseLocalStorage').getAll(); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(Error('Auth unavailable')); });
    db.close();
    const user = rows.find(r=>r.value?.stsTokenManager?.accessToken)?.value;
    if (!user) return {error:'No signed-in user'};
    const start=Date.now();
    const response=await fetch('https://asia-south1-${project}.cloudfunctions.net/assistantVision',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+user.stsTokenManager.accessToken},body:JSON.stringify({data:{task:'describe_scene',lang:'en',imageBase64:${JSON.stringify(image)}}}),signal:AbortSignal.timeout(40000)});
    const data=await response.json();
    return {elapsedMs:Date.now()-start,status:response.status,result:data.result,error:data.error};
  })()`;
  const ws = new WebSocket(tab.webSocketDebuggerUrl, { handshakeTimeout: 5000 });
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const result = await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.close();reject(Error('Phone test timed out'));},45000);
    ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id===1){clearTimeout(timer);resolve(m.result?.result?.value ?? {error:m.result?.exceptionDetails?.text ?? 'No result'});}});
    ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  });
  ws.close(); console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
