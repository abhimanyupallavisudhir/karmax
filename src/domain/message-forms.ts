/**
 * Message forms (wiki features/message-forms): what a ```form fence in an
 * agent's message is, and where a form may save. The one source of the policy:
 * the gateway checks every form an agent sends (escalate_to_human, notify,
 * pause's needs_input message, its final message) and every save a person makes
 * with one (POST /api/message-forms/save), and serves the save targets to the
 * console in /api/meta, which draws forms by them.
 *
 * `parseForm` mirrors web/markdown.js parseForm, which draws the form: the two
 * are held equal by tests/message-forms.test.ts over a shared corpus.
 *
 * Pure: no Node imports (workflows, activities, the gateway and tests share it).
 */

export type FormFieldType = 'text' | 'paragraph' | 'number' | 'date' | 'email' | 'url' | 'choice' | 'toggle' | 'secret';
export interface FormOption { value: string; label: string; hint?: string }
export interface FormField {
  name: string; type: FormFieldType; label: string; hint?: string; placeholder?: string; default?: unknown;
  options?: FormOption[]; multiple?: boolean; min?: number; max?: number; optional: boolean;
}
export interface FormSave { method: string; path: string; body: Record<string, unknown> }
export interface MessageForm { title?: string; fields: FormField[]; submit: string; save?: FormSave; quick: boolean }

const FORM_TYPES: readonly FormFieldType[] = ['text', 'paragraph', 'number', 'date', 'email', 'url', 'choice', 'toggle', 'secret'];
const FORM_LIMITS = { fields: 20, options: 50, text: 200 };
const clip = (value: unknown, max = FORM_LIMITS.text) => String(value ?? '').slice(0, max);
function humanize(name: string): string {
  const words = String(name).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`).trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
}
function formOption(option: unknown): FormOption | null {
  if (option && typeof option === 'object') {
    const o = option as Record<string, unknown>;
    const value = clip(o.value ?? o.label);
    return value ? { value, label: clip(o.label ?? value), ...(o.hint ? { hint: clip(o.hint) } : {}) } : null;
  }
  const value = clip(option);
  return value ? { value, label: value } : null;
}

/** A form fence's source → `{form}` (normalized) or `{error}` (said where the form would be). */
export function parseForm(source: string): { form: MessageForm; error?: undefined } | { error: string; form?: undefined } {
  let raw: any;
  try { raw = JSON.parse(String(source)); } catch { return { error: 'This form could not be read.' }; }
  if (Array.isArray(raw)) raw = { fields: raw };
  if (!raw || typeof raw !== 'object') return { error: 'This form could not be read.' };
  const listed: unknown[] = Array.isArray(raw.options) ? [{ name: 'answer', label: raw.label || raw.question || '', type: 'choice', options: raw.options }]
    : Array.isArray(raw.fields) ? raw.fields : [];
  const seen = new Set<string>();
  const fields: FormField[] = [];
  for (const [index, entry] of listed.slice(0, FORM_LIMITS.fields).entries()) {
    if (!entry || typeof entry !== 'object') continue;
    const field = entry as Record<string, any>;
    let name = clip(field.name || `field${index + 1}`, 60).replace(/[^\w.-]/g, '_');
    while (seen.has(name)) name += '_';
    seen.add(name);
    const options = Array.isArray(field.options) ? field.options.slice(0, FORM_LIMITS.options).map(formOption).filter((o): o is FormOption => !!o) : [];
    let type: FormFieldType = FORM_TYPES.includes(field.type) ? field.type : options.length ? 'choice'
      : field.type === 'boolean' || field.type === 'checkbox' ? 'toggle' : field.type === 'textarea' ? 'paragraph' : field.type === 'password' ? 'secret' : 'text';
    if (type === 'choice' && !options.length) type = 'text';
    const bound = (value: unknown) => type === 'number' && Number.isFinite(Number(value)) && value !== null && value !== '';
    fields.push({
      name, type, label: clip(field.label ?? (raw.options ? '' : humanize(name))),
      ...(field.hint ? { hint: clip(field.hint) } : {}),
      ...(field.placeholder ? { placeholder: clip(field.placeholder) } : {}),
      ...(field.default !== undefined && type !== 'secret' ? { default: field.default } : {}),
      ...(type === 'choice' ? { options, multiple: field.multiple === true } : {}),
      ...(bound(field.min) ? { min: Number(field.min) } : {}),
      ...(bound(field.max) ? { max: Number(field.max) } : {}),
      optional: field.optional === true || field.required === false || type === 'toggle',
    });
  }
  if (!fields.length) return { error: 'This form asks for nothing.' };
  let save: FormSave | undefined;
  if (raw.save != null) {
    const method = String(raw.save.method || 'POST').toUpperCase();
    const path = String(raw.save.path || '');
    if (!['POST', 'PUT', 'PATCH'].includes(method) || !/^\/api\/[\w./:@%?=&-]+$/.test(path) || path.includes('..'))
      return { error: 'This form saves somewhere it may not.' };
    save = { method, path, body: raw.save.body && typeof raw.save.body === 'object' ? raw.save.body : {} };
  }
  if (fields.some((field) => field.type === 'secret') && !save)
    return { error: 'This form asks for a secret without saying where it is kept, so it was not shown.' };
  const quick = !save && fields.length === 1 && fields[0]!.type === 'choice' && !fields[0]!.multiple && fields[0]!.options!.length <= 6;
  return { form: { ...(raw.title ? { title: clip(raw.title) } : {}), fields, submit: clip(raw.submit || (save ? 'Save' : 'Send'), 40), ...(save ? { save } : {}), quick } };
}

// ── where a form may save ────────────────────────────────────────────────────

/**
 * A settings write a form may make: `route` is `METHOD /api/path` where `:name`
 * is one path segment and a final `*` any rest of the path; `label` says where
 * it saves, drawn under the form from the path's ids — `{project}`,
 * `{organization}`, `{provider}` become their names, `{body.x}` a literal value
 * of the body's `x`, and a `[…]` part is left out when a value in it is missing
 * — never from the agent's words. `secret`: a secret store, whose write-only
 * keys (SECRET_FIELD_KEYS) may take a secret field.
 *
 * A new write-only secret setting needs its own row here, marked a secret store,
 * before an agent's form may save to it: the catch-all `PUT /api/settings/*` is not one.
 * The first row that matches decides.
 */
export interface FormSaveTarget { route: string; label: string; secret?: true }
export const FORM_SAVE_TARGETS: readonly FormSaveTarget[] = [
  { route: 'POST /api/projects/:project/secrets', label: '[{body.name} · ]{project} secrets', secret: true },
  { route: 'PUT /api/projects/:project/environment', label: '{project} environment' },
  { route: 'PATCH /api/projects/:project', label: '{project} settings' },
  { route: 'PUT /api/settings/project/:project/:workflow', label: '{project} task defaults' },
  { route: 'PUT /api/settings/managed-compute/:provider', label: 'Managed compute · {provider}', secret: true },
  { route: 'PUT /api/settings/native-push', label: 'Phone apps · Firebase key', secret: true },
  { route: 'PUT /api/settings/included-model', label: 'Managed compute · Included model', secret: true },
  { route: 'POST /api/settings/model-gateways', label: 'Managed compute · Model gateways', secret: true },
  { route: 'PUT /api/settings/model-gateways/:gateway', label: 'Managed compute · Model gateways', secret: true },
  { route: 'PUT /api/settings/generation-providers/:generator', label: 'Managed compute · Generation', secret: true },
  { route: 'PUT /api/settings/oauth-apps/:app', label: 'Sign-in apps', secret: true },
  { route: 'PUT /api/settings/*', label: 'Installation settings' },
  { route: 'PATCH /api/organizations/:organization', label: '{organization} settings' },
  { route: 'POST /api/organizations/:organization/accounts', label: '{organization} agent accounts', secret: true },
  { route: 'PATCH /api/organizations/:organization/accounts/keys/:kind/:key', label: '{organization} agent accounts', secret: true },
  { route: 'PUT /api/organizations/:organization/world-providers/:provider', label: '{provider} computers · {organization}', secret: true },
  { route: 'POST /api/organizations/:organization/storage', label: '{organization} storage', secret: true },
  { route: 'POST /api/vault/items', label: 'Passwords[ · {body.label}]', secret: true },
  { route: 'POST /api/mcp', label: 'MCP servers[ · {body.label}]', secret: true },
  { route: 'PUT /api/connections/config', label: 'App connections', secret: true },
  { route: 'PATCH /api/user/preferences', label: 'Your preferences' },
];

/** The keys a secret field may be saved under, as a whole value: write-only in every secret store. */
export const SECRET_FIELD_KEYS: readonly string[] = ['value', 'secret', 'secrets', 'key', 'apiKey', 'api_key', 'managementKey',
  'token', 'password', 'clientSecret', 'privateKey', 'totp', 'serviceAccount'];
const SECRET_FIELD_KEY = new RegExp(`^(?:${SECRET_FIELD_KEYS.join('|')})$`, 'i');

/** `METHOD /api/a/:b/*` → its method and the path's pattern (named groups for `:b`). */
export function compileFormRoute(route: string): { method: string; pattern: RegExp } {
  const [method, path] = route.split(' ') as [string, string];
  const source = path.split('/').map((segment) => segment === '*' ? '[\\w/-]+'
    : segment.startsWith(':') ? `(?<${segment.slice(1)}>[^/?]+)` : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/');
  return { method, pattern: new RegExp(`^${source}$`) };
}
const COMPILED = FORM_SAVE_TARGETS.map((target) => ({ target, ...compileFormRoute(target.route) }));

/** The target a form's save writes to, with the ids its path names — or undefined when a form may not write there. */
export function formSaveTarget(save: Pick<FormSave, 'method' | 'path'>): { target: FormSaveTarget; params: Record<string, string> } | undefined {
  for (const { target, method, pattern } of COMPILED) {
    const match = save.method === method ? pattern.exec(save.path) : null;
    if (match) return { target, params: { ...match.groups } };
  }
  return undefined;
}

/** The secret fields a form saves where they could be read back, if any (as the agent should hear it). */
function secretLeak(form: MessageForm, target: FormSaveTarget): string | undefined {
  const secrets = new Set(form.fields.filter((field) => field.type === 'secret').map((field) => field.name));
  if (!secrets.size) return undefined;
  const where = `${form.save!.method} ${form.save!.path}`;
  if (!target.secret) return `it saves a secret field to ${where}, which is not a secret store, so it could be read back`;
  let leak: string | undefined;
  const walk = (value: unknown, key: string) => {
    if (typeof value === 'string') {
      for (const [, name] of value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
        if (!secrets.has(name!) || leak) continue;
        if (!/^\{\{\s*[\w.-]+\s*\}\}$/.test(value)) leak = `secret field "${name}" must be the whole value of its key, not part of a longer string`;
        else if (!SECRET_FIELD_KEY.test(key)) leak = `secret field "${name}" is saved under "${key || '(the body)'}", which can be read back; use a write-only key (${SECRET_FIELD_KEYS.join(', ')})`;
      }
    } else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, item]) => walk(item, k));
  };
  walk(form.save!.body, '');
  return leak;
}

/** A form's verdict: where it saves, or what is wrong with it — `outside` when its save is no settings route. */
export type FormVerdict =
  | { ok: true; form: MessageForm; target?: { target: FormSaveTarget; params: Record<string, string> } }
  | { ok: false; problem: string; outside?: true };

/** Check a form fence's source: readable, a settings target, and secrets only into write-only keys of a secret store. */
export function checkForm(source: string): FormVerdict {
  const parsed = parseForm(source);
  if (parsed.error !== undefined) return { ok: false, problem: parseProblem(parsed.error, source) };
  const form = parsed.form;
  if (!form.save) return { ok: true, form };
  const target = formSaveTarget(form.save);
  if (!target) return { ok: false, outside: true, problem: `save ${form.save.method} ${form.save.path} isn't an allowed settings route` };
  const leak = secretLeak(form, target.target);
  return leak ? { ok: false, problem: leak } : { ok: true, form, target };
}

/** parseForm's words are for the person reading where the form would be; the agent needs the rule. */
function parseProblem(error: string, source: string): string {
  if (/could not be read/.test(error)) {
    try { JSON.parse(source); } catch (e) { return `its JSON could not be read (${(e as Error).message})`; }
    return 'it is not a JSON object or list of fields';
  }
  if (/asks for nothing/.test(error)) return 'it has no fields (give "fields": [...] or "options": [...])';
  if (/saves somewhere/.test(error)) return 'its save must be POST, PUT or PATCH to an /api/… path without ".."';
  if (/secret/.test(error)) return 'it has a secret field but no "save": a secret is only asked for to be saved into settings';
  return error;
}

/** What the agent should do about a refused form, after what was wrong. */
export function formProblemAdvice(verdict: Extract<FormVerdict, { ok: false }>): string {
  return verdict.outside ? `; allowed: ${FORM_SAVE_TARGETS.map((target) => target.route).join(', ')}` : '';
}

// ── forms in a message ───────────────────────────────────────────────────────

/** Every fence in a message the console draws as a form, as web/markdown.js reads fences. */
export function formFences(text: string): Array<{ index: number; length: number; source: string }> {
  const fences: Array<{ index: number; length: number; source: string }> = [];
  for (const match of String(text).matchAll(/```([^\n]*)\n([\s\S]*?)```/g)) {
    const lang = String(match[1]).trim().split(/\s+/)[0]!.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (lang === 'form') fences.push({ index: match.index!, length: match[0].length, source: match[2]!.replace(/\n$/, '') });
  }
  return fences;
}

/** The problems of a message's forms, each as the agent should read it ("form 2: …; allowed: …"). */
export function messageFormProblems(text: string): string[] {
  const fences = formFences(String(text).replace(/\r\n?/g, '\n'));
  return fences.flatMap((fence, at) => {
    const verdict = checkForm(fence.source);
    return verdict.ok ? [] : [`${fences.length > 1 ? `form ${at + 1}` : 'the form'}: ${verdict.problem}${formProblemAdvice(verdict)}`];
  });
}

/** Refuse an agent's message whose forms are bad, saying why (a tool call's error). */
export function assertMessageForms(text: string): void {
  const problems = messageFormProblems(text);
  if (problems.length) throw new MessageFormError(`${problems.join('. ')}. Nothing was sent: fix the form and try again.`);
}
/** A 400 (the gateway answers with an error's `status`): the agent's to fix. */
export class MessageFormError extends Error {
  code = 'invalid_request';
  status = 400;
}

/** The fence a refused form becomes: the console folds its source under the reason; anything else shows it as code. */
export const REFUSED_FORM_LANG = 'form-refused';
export const REFUSED_FORM_PREFIX = 'Form not shown: ';

/**
 * A message as it is kept when it was said without a tool call that could
 * refuse it (an agent's final message): each bad form becomes a
 * ```form-refused fence saying why, its source kept below. `problems` are for
 * the agent, told at its next turn. Idempotent.
 */
export function withRefusedForms(text: string): { text: string; problems: string[] } {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const fences = formFences(normalized);
  if (!fences.length) return { text, problems: [] };
  const problems: string[] = [];
  let out = '';
  let at = 0;
  fences.forEach((fence, n) => {
    const verdict = checkForm(fence.source);
    if (verdict.ok) return;
    problems.push(`${fences.length > 1 ? `form ${n + 1}` : 'the form'}: ${verdict.problem}${formProblemAdvice(verdict)}`);
    out += `${normalized.slice(at, fence.index)}\`\`\`${REFUSED_FORM_LANG}\n${REFUSED_FORM_PREFIX}${verdict.problem}.\n${fence.source}\n\`\`\``;
    at = fence.index + fence.length;
  });
  return problems.length ? { text: out + normalized.slice(at), problems } : { text, problems: [] };
}

/** What the agent is told at its next turn about forms it sent that were not shown. */
export function refusedFormsNotice(problems: string[]): string {
  return `Your last message's form was not shown to anyone (${problems.join('. ')}). Ask again with a corrected form.`;
}

// ── saving ───────────────────────────────────────────────────────────────────

/** `{{name}}` in a save's body → that field's value (a whole "{{name}}" keeps the value's type). */
export function fillFormTemplate(body: unknown, values: Record<string, unknown>): unknown {
  if (typeof body === 'string') {
    const whole = /^\{\{\s*([\w.-]+)\s*\}\}$/.exec(body);
    if (whole) return values[whole[1]!] ?? '';
    return body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name: string) => values[name] == null ? '' : String(values[name]));
  }
  if (Array.isArray(body)) return body.map((item) => fillFormTemplate(item, values));
  if (body && typeof body === 'object') return Object.fromEntries(Object.entries(body).map(([key, item]) => [key, fillFormTemplate(item, values)]));
  return body;
}

/** The values a person may submit for a form: its fields' only, of the shapes they take. */
export function formValues(form: MessageForm, values: unknown): Record<string, unknown> {
  const given = values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : {};
  const out: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = given[field.name];
    if (value === undefined || value === null) continue;
    const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
    if (Array.isArray(value) ? value.every(scalar) : scalar(value)) out[field.name] = value;
  }
  return out;
}

/** The policy the console draws forms by (served in /api/meta). */
export function messageFormPolicy(): { targets: readonly FormSaveTarget[]; secretKeys: readonly string[] } {
  return { targets: FORM_SAVE_TARGETS, secretKeys: SECRET_FIELD_KEYS };
}
