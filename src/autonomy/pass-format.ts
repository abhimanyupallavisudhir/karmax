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

function keyValue(note: string, key: string) {
  return note.split(/\r?\n/).find(line => new RegExp(`^${key}:(?:\\s|$)`).test(line))?.slice(key.length + 1).trim();
}

function yamlNote(note: string) {
  if (!/^---\r?\n/.test(note)) return undefined;
  const doc = parseDocument(note);
  // Treat arbitrary notes as opaque. Do not expand aliases or deserialize tags.
  return !doc.errors.length && isMap(doc.contents) ? doc : undefined;
}

/** Line one is a password unless it is an OTP URI. Preserve all remaining bytes. */
export function passSecrets(body: string): Secrets {
  const { first, note } = split(body);
  const doc = yamlNote(note);
  const structured = doc?.get('otpauth') ?? (doc ? undefined : keyValue(note, 'otpauth'))
    ?? doc?.get('totp') ?? (doc ? undefined : keyValue(note, 'totp'));
  const candidate = typeof structured === 'string'
    ? (structured.startsWith('//') ? `otpauth:${structured}` : structured)
    : undefined;
  const uri = [first, ...note.split(/\r?\n/)].find((line) => isTotp(line))?.trim();
  const totp = candidate && (!isOtp(candidate) || isTotp(candidate)) ? candidate : uri;
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
  if (isTotp(first)) return `${uri}\n${note}`;
  const doc = yamlNote(note);
  if (doc) {
    const key = doc.has('otpauth') ? 'otpauth' : 'totp';
    doc.set(key, uri);
    return `${first}\n${doc.toString()}`;
  }
  const lines = body.split(/\r?\n/);
  const kvIndex = lines.findIndex((line, index) => index > 0 && /^(otpauth|totp):(?:\s|$)/.test(line));
  if (kvIndex >= 0) {
    const key = lines[kvIndex]!.split(':', 1)[0];
    lines[kvIndex] = `${key}: ${uri}`;
    return lines.join('\n');
  }
  const index = lines.findIndex(isTotp);
  if (index >= 0) {
    lines[index] = uri;
    return lines.join('\n');
  }
  return `${body}${body.endsWith('\n') ? '' : '\n'}${uri}\n`;
}

export function createPassBody(secrets: Secrets, username?: string): string {
  const note = secrets.note ?? (username ? `username: ${username}\n` : '');
  if (secrets.password === undefined && secrets.totp) return `${totpUri(secrets.totp)}\n${note}`;
  const body = `${secrets.password ?? ''}\n${note}`;
  return secrets.totp ? updatePassSecret(body, 'totp', secrets.totp) : body;
}
