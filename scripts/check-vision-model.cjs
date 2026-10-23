// Explicitly selected JPEG fixture only. Never prints credentials or captures phone images.
const fs = require('node:fs'), path = require('node:path');
const { GoogleGenAI, ThinkingLevel } = require('../functions/node_modules/@google/genai');
const auth = require(path.join(process.env.APPDATA, 'npm/node_modules/firebase-tools/lib/auth.js'));
async function main() {
  const fixtureIndex = process.argv.indexOf('--image');
  const fixturePath = fixtureIndex >= 0 ? process.argv[fixtureIndex + 1] : undefined;
  const listOnly = process.argv.includes('--list');
  if (!listOnly && (!fixturePath || fixturePath.startsWith('--'))) throw new Error('Usage: node scripts/check-vision-model.cjs --image <local-public-test.jpg> [--model=...] (or --list). The selected image is uploaded to Gemini.');
  const fixture = !listOnly ? fs.readFileSync(fixturePath) : null;
  if (fixture && (fixture.length < 3 || fixture[0] !== 0xff || fixture[1] !== 0xd8 || fixture[2] !== 0xff)) throw new Error('The explicit test fixture must be a JPEG image.');
  const project = JSON.parse(fs.readFileSync('.firebaserc', 'utf8')).projects.default;
  const account = auth.getGlobalDefaultAccount();
  const token = await auth.getAccessToken(account.tokens.refresh_token, ['https://www.googleapis.com/auth/cloud-platform']);
  const response = await fetch(`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/GEMINI_API_KEY/versions/latest:access`, {headers: {Authorization: `Bearer ${token.access_token}`}});
  if (!response.ok) throw new Error('Secret access HTTP ' + response.status);
  const secret = await response.json();
  const ai = new GoogleGenAI({apiKey: Buffer.from(secret.payload.data, 'base64').toString('utf8').trim()});
  const source = fs.readFileSync('functions/src/assistant.ts', 'utf8');
  const schema = Function(source.slice(source.indexOf('const VISION_SCHEMA'), source.indexOf('export const VISION_TASK_INSTRUCTIONS')) + '; return VISION_SCHEMA;')();
  if (listOnly) {
    const models = await ai.models.list();
    for await (const m of models) if (/flash/.test(m.name)) console.log(m.name);
    return;
  }
  const model = process.argv.find(a => a.startsWith('--model='))?.slice(8) || /^GEMINI_VISION_MODEL=(.+)$/m.exec(fs.readFileSync('functions/.env','utf8'))[1].trim();
  const start = Date.now();
  const res = await ai.models.generateContent({model, contents: [{role:'user', parts:[{inlineData:{mimeType:'image/jpeg',data:fixture.toString('base64')}},{text:'Describe this photo in one short sentence. Image left/right only. Never infer clearance, safe walking, or measured distances. State uncertainty.'}]}], config:{responseMimeType:'application/json',responseJsonSchema:schema,maxOutputTokens:1500,thinkingConfig:{thinkingLevel:ThinkingLevel.MINIMAL},httpOptions:{timeout:20000,retryOptions:{attempts:1}}}});
  console.log(JSON.stringify({elapsedMs:Date.now()-start,finishReason:res.candidates?.[0]?.finishReason,text:res.text,usage:res.usageMetadata}));
}
main().catch(e=>{console.error(String(e.message).replace(/AIza[\w-]+/g,'[redacted]'));process.exitCode=1;});

