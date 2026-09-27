/**
 * Minimal schema layer used for AI tool arguments.
 * One spec produces both the Gemini function-declaration schema and a strict validator,
 * so the model's contract and the app's checks can never drift apart.
 */
export type Param =
  | { type: 'string'; description?: string; enum?: readonly string[]; maxLength?: number; required?: boolean }
  | { type: 'number'; description?: string; min?: number; max?: number; required?: boolean }
  | { type: 'boolean'; description?: string; required?: boolean };

export type ParamsSpec = Record<string, Param>;

export function toGeminiParameters(spec: ParamsSpec) {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [k, p] of Object.entries(spec)) {
    const out: Record<string, unknown> = { type: p.type };
    if (p.description) out.description = p.description;
    if (p.type === 'string' && p.enum) out.enum = [...p.enum];
    if (p.type === 'number') {
      if (p.min !== undefined) out.minimum = p.min;
      if (p.max !== undefined) out.maximum = p.max;
    }
    properties[k] = out;
    if (p.required) required.push(k);
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

export type Validated<T = Record<string, unknown>> = { ok: true; value: T } | { ok: false; error: string };

export function validateArgs(spec: ParamsSpec, raw: unknown): Validated {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) return { ok: false, error: 'arguments must be an object' };
  const args = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(args)) if (!(k in spec)) return { ok: false, error: `unknown argument "${k}"` };
  const value: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(spec)) {
    const v = args[k];
    if (v === undefined || v === null) {
      if (p.required) return { ok: false, error: `missing "${k}"` };
      continue;
    }
    if (p.type === 'string') {
      if (typeof v !== 'string') return { ok: false, error: `"${k}" must be a string` };
      const s = v.trim();
      if (!s && p.required) return { ok: false, error: `"${k}" is empty` };
      if (p.maxLength && s.length > p.maxLength) return { ok: false, error: `"${k}" is too long` };
      if (p.enum && !p.enum.includes(s)) return { ok: false, error: `"${k}" must be one of ${p.enum.join(', ')}` };
      value[k] = s;
    } else if (p.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: `"${k}" must be a number` };
      if (p.min !== undefined && v < p.min) return { ok: false, error: `"${k}" below ${p.min}` };
      if (p.max !== undefined && v > p.max) return { ok: false, error: `"${k}" above ${p.max}` };
      value[k] = v;
    } else {
      if (typeof v !== 'boolean') return { ok: false, error: `"${k}" must be true or false` };
      value[k] = v;
    }
  }
  return { ok: true, value };
}
