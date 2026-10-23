// Real API smoke test with synthetic text; no phone audio, photos, or secret values logged.
const fs=require('node:fs'),path=require('node:path');
const {GoogleGenAI,Modality}=require('@google/genai');
const auth=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
const {TOOLS}=require('../functions/lib/shared/tools.js');
const {toGeminiParameters}=require('../functions/lib/shared/validate.js');
async function main(){
 const project=JSON.parse(fs.readFileSync('.firebaserc','utf8')).projects.default;
 const a=auth.getGlobalDefaultAccount(); const token=await auth.getAccessToken(a.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
 const r=await fetch(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/GEMINI_API_KEY/versions/latest:access`,{headers:{Authorization:`Bearer ${token.access_token}`}});
 if(!r.ok) throw new Error('Secret access HTTP '+r.status);
 const secret=await r.json();const apiKey=Buffer.from(secret.payload.data,'base64').toString('utf8').trim();
 const model=/^GEMINI_LIVE_MODEL=(.+)$/m.exec(fs.readFileSync('functions/.env','utf8'))[1].trim();
 const ai=new GoogleGenAI({apiKey,httpOptions:{apiVersion:'v1alpha'}});
 const source=fs.readFileSync('src/core/ai/liveSession.ts','utf8');
 const promptSource=source.slice(source.indexOf('function systemPrompt()'),source.indexOf('type StopReason'));
 const stub={useSession:{getState:()=>({person:{name:'Test'}})},useDevice:{getState:()=>({link:'connected'})},useNavView:{getState:()=>({active:false})},useLocation:{getState:()=>({fix:{}})},isLinked:()=>true};
 const prompt=Function(...Object.keys(stub),promptSource+';return systemPrompt();')(...Object.values(stub));
 const ephemeral=await ai.authTokens.create({config:{uses:1,newSessionExpireTime:new Date(Date.now()+120000).toISOString(),expireTime:new Date(Date.now()+300000).toISOString(),liveConnectConstraints:{model},...(process.argv.includes('--fixed')?{lockAdditionalFields:[]}:{}),httpOptions:{apiVersion:'v1alpha'}}});
 const live=new GoogleGenAI({apiKey:process.argv.includes('--direct')?apiKey:ephemeral.name,httpOptions:{apiVersion:'v1alpha'}});
 let finish;const done=new Promise(r=>finish=r);
 const session=await live.live.connect({model,config:{responseModalities:[Modality.AUDIO],systemInstruction:{parts:[{text:prompt}]},tools:[{functionDeclarations:TOOLS.map(t=>({name:t.name,description:t.description,parameters:toGeminiParameters(t.params)}))}],outputAudioTranscription:{}},callbacks:{onmessage:m=>{if(m.toolCall){console.log('TOOL',JSON.stringify(m.toolCall));finish();}if(m.serverContent?.outputTranscription?.text)console.log('TEXT',m.serverContent.outputTranscription.text);if(m.serverContent?.turnComplete)finish();},onerror:e=>{console.log('Live error');finish();},onclose:()=>finish()}});
 session.sendClientContent({turns:[{role:'user',parts:[{text:process.argv.includes('--status')?'How much time and distance are left on my walk?':process.argv.includes('--navigation')?'Take me to MG Road, Pune.':'What is in front of me? Please use the stick camera.'}]}],turnComplete:true});
 let timer;await Promise.race([done,new Promise(r=>timer=setTimeout(r,25000))]);clearTimeout(timer);session.close();
}
main().catch(e=>{console.error('Smoke test failed: '+String(e.message).replace(/AIza[\w-]+/g,'[redacted]'));process.exitCode=1;});
