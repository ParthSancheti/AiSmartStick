import type { Place, ReplyLang, RouteStep, SosTrigger } from '../types';

/**
 * Everything the AI SmartStick assistant says, in English and Hindi. Persona: a calm, friendly
 * companion. Short sentences, directions as left/right and metres, never robotic.
 * When the real Gemini backend is live, these stay as the offline fallback and
 * as the fixed safety lines (SOS, disconnects) that should never be improvised.
 */
export type L = { en: string; hi: string };
export const pick = (l: L, lang: ReplyLang) => l[lang];

const mEn = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} meters` : `${(m / 1000).toFixed(1)} kilometers`);
const mHi = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} मीटर` : `${(m / 1000).toFixed(1)} किलोमीटर`);
const turnHi = (t: 'left' | 'right') => (t === 'left' ? 'बाएँ' : 'दाएँ');

function durationL(mins: number): L {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return {
    en: h ? `${h} hour${h > 1 ? 's' : ''} ${m} minutes` : `${m} minutes`,
    hi: h ? `${h} घंटे ${m} मिनट` : `${m} मिनट`,
  };
}

export const P = {
  fallback: {
    en: "I'm right here. Ask me what's in front of you, where you are, or say “take me to” a place.",
    hi: 'मैं यहीं हूँ। पूछिए, मेरे आगे क्या है, मैं कहाँ हूँ, या बोलिए, मुझे कहीं ले चलो।',
  },
  didntCatch: {
    en: "Sorry, I didn't catch that. Press the button and try again.",
    hi: 'माफ़ कीजिए, मैं समझ नहीं पाया। बटन दबाकर फिर से बोलिए।',
  },
  micBlocked: {
    en: "I can't use the microphone. Please allow microphone access for AI SmartStick.",
    hi: 'माइक्रोफ़ोन की अनुमति नहीं है। कृपया AI SmartStick को माइक की अनुमति दीजिए।',
  },
  brainError: {
    en: "Something went wrong on my side. Please try again in a moment.",
    hi: 'मेरी तरफ़ कुछ गड़बड़ हुई। थोड़ी देर में फिर कोशिश कीजिए।',
  },
  offline: {
    en: "I can't reach the internet right now, so I can't see or search. Your stick is still watching for obstacles.",
    hi: 'अभी इंटरनेट नहीं है, इसलिए मैं देख या खोज नहीं सकता। आपकी स्टिक अब भी रुकावटों पर नज़र रख रही है।',
  },
  noStick: {
    en: "I can't reach your stick's camera right now. Its obstacle sensor still works on its own.",
    hi: 'अभी स्टिक का कैमरा कनेक्ट नहीं है। रुकावट वाला सेंसर अपने आप काम कर रहा है।',
  },
  scenes: [
    {
      en: "You're on a footpath. A parked scooter is about two steps ahead, a little to your left. There's a shop entrance on your right. After the scooter, the path is clear.",
      hi: 'आप फुटपाथ पर हैं। करीब दो कदम आगे, थोड़ा बाईं ओर एक स्कूटर खड़ा है। दाईं ओर एक दुकान का दरवाज़ा है। स्कूटर के बाद रास्ता साफ़ है।',
    },
    {
      en: "You're at a road crossing. There's a zebra crossing ahead and the car signal looks red. A car is waiting on your right. Please confirm with someone nearby before you cross.",
      hi: 'आप सड़क पार करने की जगह पर हैं। आगे ज़ेबरा क्रॉसिंग है और गाड़ियों का सिग्नल लाल लग रहा है। दाईं ओर एक कार रुकी है। पार करने से पहले पास में किसी से पूछ लीजिए।',
    },
    {
      en: 'About one meter ahead, three steps go up, with a railing on your right. At the top is a door with a sign that says City Pharmacy.',
      hi: 'करीब एक मीटर आगे तीन सीढ़ियाँ ऊपर जाती हैं, दाईं ओर रेलिंग है। ऊपर एक दरवाज़ा है जिस पर सिटी फ़ार्मेसी लिखा है।',
    },
    {
      en: "You're holding a banknote close to the camera.",
      hi: 'आप कैमरे के पास एक नोट पकड़े हुए हैं।',
    },
  ] as L[],
  readText: {
    en: 'The sign says: City Pharmacy. Open 8 AM to 10 PM.',
    hi: 'बोर्ड पर लिखा है: सिटी फ़ार्मेसी। सुबह 8 से रात 10 बजे तक खुला।',
  },
  currency: { en: "That's a 500 rupee note.", hi: 'यह 500 रुपये का नोट है।' },

  navStart: (place: Place, m: number, mins: number, first: RouteStep): L => ({
    en: `${place.name} is ${mEn(m)} away, about ${mins} minutes on foot. Starting directions. Walk straight along ${first.street}.`,
    hi: `${place.nameHi} ${mHi(m)} दूर है, पैदल करीब ${mins} मिनट। रास्ता शुरू करते हैं। ${first.street} पर सीधे चलिए।`,
  }),
  offlineNav: {
    en: "I need the internet to find places. You can still ask where you are, and your stick keeps detecting obstacles.",
    hi: 'जगह ढूँढने के लिए इंटरनेट चाहिए। आप अब भी पूछ सकते हैं कि आप कहाँ हैं, और स्टिक रुकावटें पकड़ती रहेगी।',
  },
  turnSoon: (turn: 'left' | 'right', street: string, m: number): L => ({
    en: `In ${mEn(m)}, turn ${turn} onto ${street}.`,
    hi: `${mHi(m)} बाद ${turnHi(turn)} मुड़िए, ${street} पर।`,
  }),
  turnNow: (turn: 'left' | 'right'): L => ({ en: `Turn ${turn} now.`, hi: `अब ${turnHi(turn)} मुड़िए।` }),
  arrive: (place: Place): L => ({
    en: `You've arrived at ${place.name}. The entrance is right in front of you.`,
    hi: `आप ${place.nameHi} पहुँच गए हैं। दरवाज़ा ठीक आपके सामने है।`,
  }),
  navStopped: { en: "Okay, I've stopped the directions.", hi: 'ठीक है, रास्ता बताना बंद कर दिया।' },
  noPlace: {
    en: "I couldn't find that nearby. Try a mall, pharmacy, hospital, bus stop, ATM or café.",
    hi: 'यह पास में नहीं मिला। मॉल, दवा की दुकान, अस्पताल, बस स्टॉप, एटीएम या कैफ़े बोलकर देखिए।',
  },
  whereAmI: (street: string, landmark: Place, landmarkM: number, homeM: number): L => ({
    en: `You're on ${street}, about ${mEn(landmarkM)} from ${landmark.name}. ${homeM < 40 ? "You're right by home." : `Home is ${mEn(homeM)} away.`}`,
    hi: `आप ${street} पर हैं, ${landmark.nameHi} से करीब ${mHi(landmarkM)} दूर। ${homeM < 40 ? 'आप घर के पास ही हैं।' : `घर ${mHi(homeM)} दूर है।`}`,
  }),
  calling: (name: string): L => ({ en: `Calling ${name}.`, hi: `${name} को कॉल कर रहा हूँ।` }),
  callEnded: { en: 'Call ended.', hi: 'कॉल खत्म।' },
  noContact: { en: "I couldn't find that person in your contacts.", hi: 'यह नाम आपके कॉन्टैक्ट्स में नहीं मिला।' },
  messageSent: (name: string, text: string): L => ({ en: `Sent to ${name}: ${text}`, hi: `${name} को भेज दिया: ${text}` }),
  status: (pct: number, linked: boolean): L => {
    const d = durationL(Math.round(pct * 3));
    return {
      en: `Your stick has ${pct} percent battery, about ${d.en} left. ${linked ? "It's connected." : "It's not connected right now."}`,
      hi: `स्टिक की बैटरी ${pct} प्रतिशत है, करीब ${d.hi} चलेगी। ${linked ? 'स्टिक कनेक्ट है।' : 'स्टिक अभी कनेक्ट नहीं है।'}`,
    };
  },
  time: (d: Date): L => {
    const h = d.getHours();
    const m = d.getMinutes();
    const t = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    return { en: `It's ${t}.`, hi: `अभी ${h % 12 || 12} बजकर ${m} मिनट हुए हैं।` };
  },
  nothingYet: { en: "I haven't said anything yet.", hi: 'मैंने अभी कुछ नहीं कहा है।' },

  sosIntro: (trigger: SosTrigger, secs: number): L =>
    trigger === 'fall'
      ? {
          en: `It looks like you fell. Sending SOS in ${secs} seconds. Press the button if you're okay.`,
          hi: `लगता है आप गिर गए। ${secs} सेकंड में SOS भेज रहा हूँ। ठीक हैं तो बटन दबाइए।`,
        }
      : {
          en: `Sending SOS in ${secs} seconds. Press the button to cancel.`,
          hi: `${secs} सेकंड में SOS भेज रहा हूँ। रोकने के लिए बटन दबाइए।`,
        },
  sosSent: (names: string): L => ({
    en: `SOS sent. ${names} have your location. Stay where you are if you can.`,
    hi: `SOS भेज दिया। ${names} को आपकी लोकेशन मिल गई है। हो सके तो वहीं रुकिए।`,
  }),
  sosSms: {
    en: 'There is no internet, so I sent your SOS by SMS. It will also go through the app when the internet is back.',
    hi: 'इंटरनेट नहीं है, इसलिए SOS एसएमएस से भेज दिया। इंटरनेट आते ही ऐप से भी चला जाएगा।',
  },
  sosCancelled: { en: 'SOS cancelled.', hi: 'SOS रद्द कर दिया।' },
  sosResolvedUser: { en: "Okay. I've told everyone you're safe.", hi: 'ठीक है। सबको बता दिया कि आप सुरक्षित हैं।' },
  guardianSeen: (name: string): L => ({ en: `${name} has seen your alert.`, hi: `${name} ने आपका अलर्ट देख लिया है।` }),
  guardianOnWay: (name: string): L => ({ en: `${name} is on the way.`, hi: `${name} आपके पास आ रहे हैं।` }),
  guardianResolved: (name: string): L => ({ en: `${name} closed the SOS.`, hi: `${name} ने SOS बंद कर दिया है।` }),

  viewing: (name: string): L => ({ en: `${name} is viewing your camera.`, hi: `${name} आपका कैमरा देख रहे हैं।` }),
  guardianMsg: (name: string, text: string): L => ({ en: `Message from ${name}. ${text}`, hi: `${name} का मैसेज। ${text}` }),

  linkUp: { en: 'Stick connected.', hi: 'स्टिक कनेक्ट हो गई।' },
  linkDown: {
    en: 'Your stick disconnected from the phone. It still vibrates for obstacles on its own.',
    hi: 'स्टिक फ़ोन से डिस्कनेक्ट हो गई है। रुकावट होने पर वह खुद वाइब्रेट करती रहेगी।',
  },
  cameraRequested: (n: string) => ({
    en: `${n} asked to see your camera. You will hear when it ends.`,
    hi: `${n} आपका कैमरा देखना चाहते हैं। खत्म होने पर बताऊँगा।`,
  }),
  cameraEnded: (n: string) => ({ en: `${n} stopped viewing your camera.`, hi: `${n} ने कैमरा देखना बंद कर दिया।` }),
  authFailed: {
    en: 'Your stick needs new firmware before it can connect.',
    hi: 'स्टिक को जुड़ने से पहले नया फ़र्मवेयर चाहिए।',
  },
  netDown: { en: "The internet dropped. I'll keep the basics working.", hi: 'इंटरनेट चला गया। ज़रूरी चीज़ें चालू रहेंगी।' },
  netUp: { en: 'Internet is back.', hi: 'इंटरनेट वापस आ गया।' },
  lowBattery: (pct: number): L => ({
    en: `Your stick battery is at ${pct} percent. Please charge it soon.`,
    hi: `स्टिक की बैटरी ${pct} प्रतिशत है। जल्दी चार्ज कर लीजिए।`,
  }),

  hello: {
    en: "Hi, I'm your AI SmartStick assistant. I'll walk with you and tell you what's around. First, let's link this phone with your family.",
    hi: 'नमस्ते, मैं आपका AI SmartStick असिस्टेंट हूँ। मैं आपके साथ चलूँगा और आसपास की बातें बताऊँगा। पहले इस फ़ोन को अपने परिवार से जोड़ते हैं।',
  },
  askCode: {
    en: 'Type or say the six digit code shown on your family member’s phone.',
    hi: 'परिवार वाले के फ़ोन पर दिखा छह अंकों का कोड बोलिए या टाइप कीजिए।',
  },
  codeWrong: { en: "That code didn't match. Let's try again.", hi: 'कोड मेल नहीं खाया। फिर से कोशिश करते हैं।' },
  linked: (name: string): L => ({ en: `You're linked with ${name}.`, hi: `आप ${name} से जुड़ गए हैं।` }),
  setupDone: {
    en: 'All set. Press your stick button once, anytime, to talk to me.',
    hi: 'सब तैयार है। मुझसे बात करने के लिए कभी भी स्टिक का बटन एक बार दबाइए।',
  },
  pocketOn: {
    en: 'Pocket mode on. Screen touches are ignored. Your stick button still works.',
    hi: 'पॉकेट मोड चालू। स्क्रीन को छूने से कुछ नहीं होगा। स्टिक का बटन काम करता रहेगा।',
  },
  pocketOff: { en: 'Pocket mode off.', hi: 'पॉकेट मोड बंद।' },
};

/** Short, third-person captions for the Guardian's Live Vision screen. */
export const GUARDIAN_SCENES = [
  'Footpath with a parked scooter two steps ahead on the left and a shop entrance on the right. The path is clear after the scooter.',
  'Road crossing with a zebra crossing ahead. The car signal looks red and a car is waiting on the right.',
  'Three steps going up about a metre ahead, railing on the right, below a City Pharmacy sign.',
  'Close-up of a 500 rupee note held near the camera.',
];
