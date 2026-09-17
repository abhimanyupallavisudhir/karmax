import { isMap, parseDocument } from 'yaml';
import type { VaultFieldName } from './vault-items.js';

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
  const { first, note } = split(body);
  if (field === 'password') return isOtp(first) ? `${value}\n${body}` : `${value}\n${note}`;
  if (field === 'note') return `${first}\n${value}`;
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
