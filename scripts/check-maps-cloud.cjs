// Uses the existing Firebase CLI login. Never prints API keys or access tokens.
const fs = require('node:fs');
const path = require('node:path');
const auth = require(path.join(process.env.APPDATA, 'npm/node_modules/firebase-tools/lib/auth.js'));
async function main() {
  const env = Object.fromEntries(fs.readFileSync('.env', 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i=l.indexOf('='); return [l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error('Firebase CLI login required');
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const request = async (url, options={}) => {
    const r=await fetch(url, {...options, headers:{Authorization:`Bearer ${token.access_token}`, 'Content-Type':'application/json'}, signal:AbortSignal.timeout(30000)});
    const data=await r.json();
    if(!r.ok) throw new Error(`Cloud API HTTP ${r.status}: ${data.error?.status || 'failed'}`);
    return data;
  };
  const lookup = await request('https://apikeys.googleapis.com/v2/keys:lookupKey?keyString='+encodeURIComponent(env.VITE_GOOGLE_MAPS_BROWSER_KEY));
  const key = await request('https://apikeys.googleapis.com/v2/'+lookup.name);
  console.log('Configured Maps key: '+key.displayName);
  const keys = await request('https://apikeys.googleapis.com/v2/'+lookup.parent+'/keys?pageSize=100');
  console.log(JSON.stringify((keys.keys||[]).map(k=>({name:k.name,displayName:k.displayName,services:k.restrictions?.apiTargets?.map(t=>t.service)})),null,2));
  if(process.argv.includes('--use-existing-map')) {
    const maps = keys.keys.filter(k=>k.displayName==='Map' && k.restrictions?.apiTargets?.some(t=>t.service==='maps-backend.googleapis.com'));
    if(maps.length!==1) throw new Error('Expected exactly one existing Map key');
    const value=await request('https://apikeys.googleapis.com/v2/'+maps[0].name+'/keyString');
    if(!value.keyString) throw new Error('No key returned');
    fs.writeFileSync('.env',fs.readFileSync('.env','utf8').replace(/^VITE_GOOGLE_MAPS_BROWSER_KEY=.*$/m,'VITE_GOOGLE_MAPS_BROWSER_KEY='+value.keyString));
    console.log('Updated local Maps build configuration to the existing Map key. Firebase keys unchanged.');
  }
  for(const service of ['maps-backend.googleapis.com','places.googleapis.com','routes.googleapis.com']) {
    const result=await request(`https://serviceusage.googleapis.com/v1/${lookup.parent.split('/locations/')[0]}/services/${service}`);
    console.log(service+': '+result.state);
  }
  if(process.argv.includes('--repair-server')) {
    const maps=keys.keys.filter(k=>k.displayName==='Map');
    if(maps.length!==1) throw new Error('Expected one Map key');
    const value=await request('https://apikeys.googleapis.com/v2/'+maps[0].name+'/keyString');
    if(!value.keyString) throw new Error('No Maps key returned');
    const version=await request(`https://secretmanager.googleapis.com/v1/projects/${env.VITE_FIREBASE_PROJECT_ID}/secrets/MAPS_SERVER_KEY:addVersion`, {method:'POST',body:JSON.stringify({payload:{data:Buffer.from(value.keyString).toString('base64')}})});
    console.log('Created corrected server key version: '+version.name);
  }
  if(process.argv.includes('--check-server') || process.argv.includes('--repair-server')) {
    const secret=await request(`https://secretmanager.googleapis.com/v1/projects/${env.VITE_FIREBASE_PROJECT_ID}/secrets/MAPS_SERVER_KEY/versions/latest:access`);
    const serverKey=Buffer.from(secret.payload.data,'base64').toString('utf8').trim();
    const serverLookup=await request('https://apikeys.googleapis.com/v2/keys:lookupKey?keyString='+encodeURIComponent(serverKey));
    const metadata=await request('https://apikeys.googleapis.com/v2/'+serverLookup.name);
    console.log('Server Maps key: '+metadata.displayName);
    const result=await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':serverKey,'X-Goog-FieldMask':'routes.distanceMeters'},body:JSON.stringify({origin:{location:{latLng:{latitude:18.5204,longitude:73.8567}}},destination:{location:{latLng:{latitude:18.521,longitude:73.857}}},travelMode:'WALK'}),signal:AbortSignal.timeout(30000)});
    const body=await result.json();
    console.log('Server walking route check: HTTP '+result.status+', '+(body.error?.status||'routes='+body.routes?.length));
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
