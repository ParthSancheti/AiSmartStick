import type { ParamsSpec } from './validate';

/**
 * AI Smart Stick tool registry (contract only; execution lives in the app:
 * src/core/ai/executor.ts). Gemini may REQUEST these; the app decides.
 */
export type ToolCategory = 'device' | 'vision' | 'navigation' | 'safety' | 'communication' | 'audio' | 'history' | 'settings';
export type Requirement = 'device' | 'internet' | 'location' | 'guardian';

export interface ToolSpec {
  /** Gemini function name (letters, digits, underscore). */
  name: string;
  /** Structured action type used across the app, e.g. "navigation.searchPlace". */
  type: string;
  category: ToolCategory;
  description: string;
  params: ParamsSpec;
  requires: Requirement[];
  /** Ask the user before running (spoken yes/no or button press). */
  confirm?: boolean;
  /** Changes something in the world (vs. read-only). */
  sideEffect: boolean;
}

const cat = ['mall', 'pharmacy', 'hospital', 'bus_stop', 'atm', 'cafe', 'restaurant', 'salon', 'supermarket', 'police', 'train_station', 'home'] as const;
export const PLACE_CATEGORIES = cat;

export const SETTING_KEYS = ['voiceRate', 'replyLang', 'earcons', 'haptics', 'textScale', 'highContrast', 'assistantVolume'] as const;

export const TOOLS: ToolSpec[] = [
  // DEVICE
  { name: 'get_device_status', type: 'device.getDeviceStatus', category: 'device', description: 'Stick connection, battery, sensors and firmware in one summary.', params: {}, requires: [], sideEffect: false },
  { name: 'get_battery', type: 'device.getBattery', category: 'device', description: 'Stick battery estimate, with how fresh and how reliable it is.', params: {}, requires: [], sideEffect: false },
  { name: 'get_charging_state', type: 'device.getChargingState', category: 'device', description: 'Whether the stick is charging and whether that is measured or inferred.', params: {}, requires: [], sideEffect: false },
  { name: 'get_connection_state', type: 'device.getConnectionState', category: 'device', description: 'Stick link and phone internet state.', params: {}, requires: [], sideEffect: false },
  { name: 'get_firmware', type: 'device.getFirmware', category: 'device', description: 'Stick firmware and protocol version.', params: {}, requires: ['device'], sideEffect: false },
  { name: 'get_sensor_state', type: 'device.getSensorState', category: 'device', description: 'Obstacle sensor distance and status, motion sensor status.', params: {}, requires: [], sideEffect: false },
  { name: 'get_phone_info', type: 'device.getPhoneInfo', category: 'device', description: 'This phone model, OS version and phone battery where available.', params: {}, requires: [], sideEffect: false },
  // VISION
  { name: 'capture_scene', type: 'vision.captureScene', category: 'vision', description: 'Take a photo with the stick camera (no interpretation).', params: {}, requires: ['device'], sideEffect: false },
  { name: 'describe_scene', type: 'vision.describeScene', category: 'vision', description: "Photo + interpretation of what is in front of the user: obstacles, people, vehicles, steps, curbs, doors, signs, with left/centre/right and rough distance. Reports uncertainty. Never says it is safe to cross or walk.", params: {}, requires: ['device', 'internet'], sideEffect: false },
  { name: 'read_text', type: 'vision.readText', category: 'vision', description: 'Photo + read out printed text (signs, labels, documents).', params: {}, requires: ['device', 'internet'], sideEffect: false },
  { name: 'identify_object', type: 'vision.identifyObject', category: 'vision', description: 'Photo + identify the object held in front of the camera (including Indian banknotes).', params: { hint: { type: 'string', maxLength: 80, description: 'What the user thinks it is, if they said' } }, requires: ['device', 'internet'], sideEffect: false },
  { name: 'read_sign', type: 'vision.readSign', category: 'vision', description: 'Photo + read a sign or signboard ahead.', params: {}, requires: ['device', 'internet'], sideEffect: false },
  { name: 'describe_environment', type: 'vision.describeEnvironment', category: 'vision', description: 'Photo + broad description of the surroundings (indoor/outdoor, type of place).', params: {}, requires: ['device', 'internet'], sideEffect: false },
  // NAVIGATION
  { name: 'get_current_location', type: 'navigation.getCurrentLocation', category: 'navigation', description: 'Current GPS position with accuracy and nearest address (asks the phone for a fresh fix).', params: {}, requires: [], sideEffect: false },
  // Search and destinations never require a GPS fix: the newest position (any age) only biases the
  // search, and directions start by themselves once GPS has a position (waitingForGps).
  { name: 'search_place', type: 'navigation.searchPlace', category: 'navigation', description: 'Search real places by name or address (Google Places), near the user when a position is known. Works without GPS. Returns an offered place and alternatives with ids.', params: { query: { type: 'string', required: true, maxLength: 120 } }, requires: ['internet'], sideEffect: false },
  { name: 'find_nearest_place', type: 'navigation.findNearestPlace', category: 'navigation', description: 'Find the nearest place of a category, e.g. salon or pharmacy. Works without GPS (then not sorted by distance).', params: { category: { type: 'string', enum: cat }, query: { type: 'string', maxLength: 80, description: 'Use when no category fits' } }, requires: ['internet'], sideEffect: false },
  { name: 'set_destination', type: 'navigation.setDestination', category: 'navigation', description: 'Set where the user wants to go AND start walking directions. Give placeId from a search, or query (a place name or address) when the user names one specific place ("set destination to City Hospital"). Works without GPS: directions then start automatically as soon as GPS has a position.', params: { placeId: { type: 'string', maxLength: 300, description: 'From search_place / find_nearest_place' }, query: { type: 'string', maxLength: 120, description: 'Place name or address, when there is no placeId' } }, requires: ['internet'], sideEffect: true },
  { name: 'start_navigation', type: 'navigation.startNavigation', category: 'navigation', description: 'Start walking directions to the offered/chosen destination (or placeId). Works without GPS: directions then start automatically once GPS has a position.', params: { placeId: { type: 'string', maxLength: 300 } }, requires: ['internet'], sideEffect: true },
  { name: 'stop_navigation', type: 'navigation.stopNavigation', category: 'navigation', description: 'Stop walking directions.', params: {}, requires: [], sideEffect: true },
  { name: 'reroute', type: 'navigation.reroute', category: 'navigation', description: 'Recalculate the route from the current position.', params: {}, requires: ['internet', 'location'], sideEffect: true },
  { name: 'repeat_direction', type: 'navigation.repeatDirection', category: 'navigation', description: 'Repeat the next walking instruction.', params: {}, requires: [], sideEffect: false },
  { name: 'get_route_status', type: 'navigation.getRouteStatus', category: 'navigation', description: 'Distance and time left, next instruction.', params: {}, requires: [], sideEffect: false },
  // SAFETY
  { name: 'get_safety_state', type: 'safety.getSafetyState', category: 'safety', description: 'Overall safety state and why.', params: {}, requires: [], sideEffect: false },
  { name: 'trigger_sos', type: 'safety.triggerSOS', category: 'safety', description: 'Start the SOS countdown. Only when the user clearly asks for help or says it is an emergency.', params: { reason: { type: 'string', maxLength: 120 } }, requires: [], sideEffect: true },
  { name: 'cancel_sos', type: 'safety.cancelSOS', category: 'safety', description: 'Cancel an SOS countdown or mark an active SOS as safe, when the user says they are okay.', params: {}, requires: [], sideEffect: true },
  // COMMUNICATION
  { name: 'get_guardian_contact', type: 'communication.getGuardianContact', category: 'communication', description: "The safety contact's (or guardian's) name and whether a phone number is saved.", params: {}, requires: [], sideEffect: false },
  { name: 'call_guardian', type: 'communication.callGuardian', category: 'communication', description: 'Place a real phone call to the safety contact (or guardian).', params: {}, requires: [], sideEffect: true },
  { name: 'send_sms_to_guardian', type: 'communication.sendSmsToGuardian', category: 'communication', description: "Send a short text message to the safety contact (or guardian). For help/emergency messages or when the user asks to share where they are, the app adds a Google Maps link to the user's position itself; never type coordinates.", params: { text: { type: 'string', required: true, maxLength: 300 } }, requires: [], confirm: true, sideEffect: true },
  // AUDIO
  { name: 'speak', type: 'audio.speak', category: 'audio', description: 'Say a short announcement aloud (use for reminders the user asks to hear again).', params: { text: { type: 'string', required: true, maxLength: 400 } }, requires: [], sideEffect: true },
  { name: 'stop_speaking', type: 'audio.stopSpeaking', category: 'audio', description: 'Stop the current speech.', params: {}, requires: [], sideEffect: true },
  { name: 'repeat_last_announcement', type: 'audio.repeatLastAnnouncement', category: 'audio', description: 'Repeat the last thing that was said.', params: {}, requires: [], sideEffect: false },
  { name: 'set_assistant_volume', type: 'audio.setAssistantVolume', category: 'audio', description: 'Set the assistant voice volume, 0-100.', params: { level: { type: 'number', required: true, min: 0, max: 100 } }, requires: [], sideEffect: true },
  // HISTORY
  { name: 'get_conversation_history', type: 'history.getConversationHistory', category: 'history', description: 'Recent messages from this conversation.', params: { limit: { type: 'number', min: 1, max: 20 } }, requires: ['internet'], sideEffect: false },
  // SETTINGS
  { name: 'get_setting', type: 'settings.getSetting', category: 'settings', description: 'Read an app setting.', params: { key: { type: 'string', required: true, enum: SETTING_KEYS } }, requires: [], sideEffect: false },
  { name: 'change_setting', type: 'settings.changeSetting', category: 'settings', description: 'Change an app setting. SOS and privacy settings cannot be changed by voice.', params: { key: { type: 'string', required: true, enum: SETTING_KEYS }, value: { type: 'string', required: true, maxLength: 20 } }, requires: [], sideEffect: true },
  { name: 'escalate_to_flash', type: 'ai.escalate', category: 'settings', description: 'Use this when the user asks a complex question requiring deep reasoning, complex planning, or heavy document/OCR tasks that need the Flash model.', params: { text: { type: 'string', required: true, description: 'The original user request' } }, requires: ['internet'], sideEffect: false },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const TOOL_BY_TYPE = new Map(TOOLS.map((t) => [t.type, t]));
