import { isMap, parseDocument } from 'yaml';
import { ITEM_FIELDS, type VaultItemType, type VaultFieldName } from './vault-items.js';

type Secrets = Partial<Record<VaultFieldName, string>>;
const isTotp = (value: string) => /^otpauth:\/\/totp\//.test(value.trim());
const isOtp = (value: string) => /^otpauth:\/\//.test(value.trim());

function split(body: string) {
  const newline = body.indexOf('\n');
  return { first: (newline < 0 ? body : body.slice(0, newline)).replace(/\r$/, ''),
    note: newline < 0 ? '' : body.slice(newline + 1) };
}

function yamlNote(note: string) {
  if (!/^---\r?\n/.test(note)) return undefined;
  const doc = parseDocument(note);
  // Treat arbitrary notes as opaque. Do not expand aliases or deserialize tags.
  return !doc.errors.length && isMap(doc.contents) ? doc : undefined;
}

/** Resolve the representation gopass actually uses: otpauth field, bare URI,
 * then totp field. Read and rotation must use the same selection. */
function otpLocation(body: string): { value: unknown; key?: string; index?: number; doc?: ReturnType<typeof yamlNote> } | undefined {
  const { note } = split(body);
  const doc = yamlNote(note);
  const lines = body.split(/\r?\n/);
  const field = (key: string) => {
    if (doc?.has(key)) return { value: doc.get(key), doc, key };
    if (doc) return undefined;
    const index = lines.findIndex((line, i) => i > 0 && new RegExp(`^${key}:(?:\\s|$)`).test(line));
    return index < 0 ? undefined : { value: lines[index]!.slice(key.length + 1).trim(), key, index };
  };
  const explicit = field('otpauth');
  if (explicit) return explicit;
  const index = lines.findIndex(isOtp);
  if (index >= 0) return { value: lines[index]!.trim(), index };
  return field('totp');
}

/** Line one is a password unless it is an OTP URI. Preserve all remaining bytes. */
export function passSecrets(body: string): Secrets {
  const { first, note } = split(body);
  const value = otpLocation(body)?.value;
  const candidate = typeof value === 'string' ? (value.startsWith('//') ? `otpauth:${value}` : value) : undefined;
  const totp = candidate && (!isOtp(candidate) || isTotp(candidate)) ? candidate : undefined;
  return { ...(!isOtp(first) ? { password: first } : {}), note, ...(totp ? { totp } : {}) };
}

function totpUri(value: string): string {
  const trimmed = value.trim();
  if (isTotp(trimmed)) {
    try {
      if (new URL(trimmed).searchParams.get('secret')) return trimmed;
    } catch { /* report without echoing the secret */ }
  } else if (/^[A-Z2-7]+=*$/i.test(trimmed)) {
    return `otpauth://totp/karmax?secret=${encodeURIComponent(trimmed)}`;
  }
  throw new Error('TOTP must be a base32 seed or an otpauth://totp URI with a secret');
}

/** Update a field without losing OTP-only entries or gopass YAML metadata. */
export function updatePassSecret(body: string, field: VaultFieldName, value: string): string {
  const typed = typedPassItem(body);
  if (typed) {
    if (!ITEM_FIELDS[typed.type].includes(field)) throw new Error('Field does not belong to this password-store item');
    return createPassItem({ ...typed, secrets: { ...typed.secrets, [field]: value } });
  }
  const { first, note } = split(body);
  if (field === 'password') {
    if (/[\r\n]/.test(value)) throw new Error('Native pass passwords must occupy one line');
    return isOtp(first) ? `${value}\n${body}` : `${value}\n${note}`;
  }
  if (field === 'note') {
    const updated = `${first}\n${value}`;
    // Notes and appended/YAML tokens share the same physical text. A notes
    // replacement must not delete or implicitly rotate the separate TOTP field.
    const token = passSecrets(body).totp;
    return token && passSecrets(updated).totp !== token ? updatePassSecret(updated, 'totp', token) : updated;
  }
  if (field !== 'totp') throw new Error(`pass write-back does not support the "${field}" field`);
  const uri = totpUri(value);
  const location = otpLocation(body);
  if (location?.doc) {
    location.doc.set(location.key!, uri);
    return `${first}\n${location.doc.toString()}`;
  }
  if (location?.index !== undefined) {
    // Keep line endings and all unrelated notes byte-for-byte.
    const parts = body.split(/(\r?\n)/);
    parts[location.index * 2] = location.key ? `${location.key}: ${uri}` : uri;
    return parts.join('');
  }
  const doc = yamlNote(note);
  if (doc) {
    doc.set('totp', uri);
    return `${first}\n${doc.toString()}`;
  }
  return `${body}${body.endsWith('\n') ? '' : '\n'}${uri}\n`;
}

export function createPassBody(secrets: Secrets, username?: string): string {
  const note = secrets.note ?? (username ? `username: ${username}\n` : '');
  if (secrets.password === undefined && secrets.totp) return `${totpUri(secrets.totp)}\n${note}`;
  const body = `${secrets.password ?? ''}\n${note}`;
  return secrets.totp ? updatePassSecret(body, 'totp', secrets.totp) : body;
}


export interface PassItem {
  type: VaultItemType;
  label?: string;
  username?: string;
  domains?: string[];
  secrets: Secrets;
}

const typedMarker = 'karmax-vault-item:';

/** Non-login entries need an explicit type; pass itself only defines line one.
 * The payload is inside the encrypted file, never a plaintext sidecar. API
 * keys retain a useful first line for `pass -c`; multiline values stay exact. */
export function createPassItem(item: PassItem): string {
  if (!Object.hasOwn(ITEM_FIELDS, item.type)) throw new Error('Unsupported password-store item type');
  for (const [field, value] of Object.entries(item.secrets)) {
    if (!ITEM_FIELDS[item.type].includes(field as VaultFieldName) || typeof value !== 'string')
      throw new Error('Invalid password-store secret field');
  }
  if (item.type === 'login') {
    if (item.secrets.password && /[\r\n]/.test(item.secrets.password))
      throw new Error('Native pass passwords must occupy one line');
    return createPassBody(item.secrets, item.username);
  }
  if (item.secrets[ITEM_FIELDS[item.type][0]!] === undefined) throw new Error('Password-store item has no secret');
  const firstField =
    item.type === 'api-key' && item.secrets.secret !== undefined && !/[\r\n]/.test(item.secrets.secret)
      ? 'secret'
      : undefined;
  const secrets = { ...item.secrets };
  if (firstField) delete secrets.secret;
  return `${firstField ? item.secrets.secret : ''}\n${typedMarker}1\n${JSON.stringify({
    type: item.type,
    ...(item.label !== undefined ? { label: item.label } : {}),
    ...(item.username !== undefined ? { username: item.username } : {}),
    ...(item.domains !== undefined ? { domains: item.domains } : {}),
    secrets,
    ...(firstField ? { firstField } : {}),
  })}\n`;
}

function typedPassItem(body: string): PassItem | undefined {
  const { first, note } = split(body);
  if (!note.startsWith(typedMarker)) return undefined;
  const newline = note.indexOf('\n');
  if (newline < 0 || note.slice(0, newline).replace(/\r$/, '') !== `${typedMarker}1`)
    throw new Error('Unsupported password-store item format');
  let data: any;
  try {
    data = JSON.parse(note.slice(newline + 1));
  } catch {
    throw new Error('Invalid password-store item payload');
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !Object.hasOwn(ITEM_FIELDS, data.type) ||
    data.type === 'login' ||
    !data.secrets ||
    typeof data.secrets !== 'object' ||
    Array.isArray(data.secrets) ||
    (data.label !== undefined && typeof data.label !== 'string') ||
    (data.username !== undefined && typeof data.username !== 'string') ||
    (data.domains !== undefined &&
      (!Array.isArray(data.domains) || data.domains.some((v: unknown) => typeof v !== 'string'))) ||
    (data.firstField !== undefined && (data.type !== 'api-key' || data.firstField !== 'secret'))
  )
    throw new Error('Invalid password-store item payload');
  for (const [field, value] of Object.entries(data.secrets)) {
    if (!ITEM_FIELDS[data.type as VaultItemType].includes(field as VaultFieldName) || typeof value !== 'string')
      throw new Error('Invalid password-store secret field');
  }
  const primary = ITEM_FIELDS[data.type as VaultItemType][0]!;
  if (
    (data.firstField && data.secrets.secret !== undefined) ||
    (!data.firstField && (first !== '' || data.secrets[primary] === undefined))
  )
    throw new Error('Invalid password-store primary field');
  // Never spread untrusted payload keys into a connector item: routing and
  // revision metadata belong to the encrypted file that was actually read.
  return {
    type: data.type,
    ...(data.label !== undefined ? { label: data.label } : {}),
    ...(data.username !== undefined ? { username: data.username } : {}),
    ...(data.domains !== undefined ? { domains: data.domains } : {}),
    secrets: { ...data.secrets, ...(data.firstField ? { secret: first } : {}) },
  };
}

export function parsePassItem(body: string): PassItem {
  return typedPassItem(body) ?? { type: 'login', secrets: passSecrets(body) };
}
