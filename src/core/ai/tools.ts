import type { PlaceCategory } from '../types';

/**
 * DEMO brain tool surface ("phone control"). The assistant never touches the
 * phone directly: the model picks a tool, the app executes it. Adding a new
 * ability = add a declaration here + a case in the executor (assistant.ts).
 */
export type ToolCall =
  | { name: 'describe_scene' }
  | { name: 'read_text' }
  | { name: 'identify_currency' }
  | { name: 'where_am_i' }
  | { name: 'navigate_to'; args: { category?: PlaceCategory; query?: string } }
  | { name: 'stop_navigation' }
  | { name: 'call_contact'; args: { contact: string } }
  | { name: 'send_message'; args: { contact: string; text: string } }
  | { name: 'get_status' }
  | { name: 'get_time' }
  | { name: 'trigger_sos' }
  | { name: 'cancel_sos' }
  | { name: 'repeat_last' };

export type ToolName = ToolCall['name'];

/**
 * Gemini function declarations. The backend sends these as
 * `tools: [{ functionDeclarations }]` with the user's words (and, for vision
 * tools, the stick camera frame). Gemini answers with functionCall parts,
 * which the backend returns to the app as `calls`.
 */
export const functionDeclarations = [
  {
    name: 'describe_scene',
    description:
      "Take a photo with the stick camera and describe what is in front of the user: obstacles, steps, vehicles, people, doors, signs. Use short calm sentences, distances in steps or metres, and left/right. Never claim it is safe to cross a road.",
  },
  { name: 'read_text', description: 'Take a photo with the stick camera and read out any printed text: signs, labels, menus, documents.' },
  { name: 'identify_currency', description: 'Take a close photo and say which Indian banknote or coin the user is holding.' },
  { name: 'where_am_i', description: "Tell the user the street they are on, the nearest landmark, and how far home is." },
  {
    name: 'navigate_to',
    description: 'Start walking directions inside the app to the nearest place of a category, or to a named place.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['mall', 'pharmacy', 'hospital', 'bus', 'atm', 'cafe', 'home'] },
        query: { type: 'string', description: 'Free-text place name when no category fits.' },
      },
    },
  },
  { name: 'stop_navigation', description: 'Stop the current walking directions.' },
  {
    name: 'call_contact',
    description: 'Place a phone call to one of the user’s saved contacts.',
    parameters: { type: 'object', properties: { contact: { type: 'string', description: 'Contact id or name, e.g. mom, papa, riya' } }, required: ['contact'] },
  },
  {
    name: 'send_message',
    description: 'Send a short text message to a saved contact.',
    parameters: {
      type: 'object',
      properties: { contact: { type: 'string' }, text: { type: 'string' } },
      required: ['contact', 'text'],
    },
  },
  { name: 'get_status', description: 'Report stick battery and connection.' },
  { name: 'get_time', description: 'Tell the current time.' },
  { name: 'trigger_sos', description: 'Start the SOS countdown. Only when the user clearly asks for help or emergency.' },
  { name: 'cancel_sos', description: 'Cancel an SOS the user says they no longer need.' },
  { name: 'repeat_last', description: 'Repeat the last thing the assistant said.' },
] as const;
