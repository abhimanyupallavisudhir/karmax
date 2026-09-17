import { describe, expect, it } from 'vitest';
import { passSecrets, updatePassSecret, createPassBody } from '../src/autonomy/pass-format.js';

const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const uri = `otpauth://totp/example?secret=${seed}`;
const next = `otpauth://totp/example?secret=JBSWY3DPEHPK3PXP`;

describe('pass and gopass formats', () => {
  it('recognizes standalone tokens without exposing them as passwords', () => {
    expect(passSecrets(uri)).toEqual({ totp: uri, note: '' });
    expect(passSecrets(`${uri}\r\nkeep\r\n`)).toEqual({ totp: uri, note: 'keep\r\n' });
  });
  it('recognizes appended tokens and preserves notes verbatim', () => {
    expect(updatePassSecret(`pw\n${uri}\n`, 'totp', next)).toBe(`pw\n${next}\n`);
    expect(passSecrets(`pw\nusername: alice\n${uri}\n`)).toEqual({ password: 'pw', totp: uri, note: `username: alice\n${uri}\n` });
  });
  it('reads gopass YAML TOTP and preserves unrelated structured fields', () => {
    const body = `pw\n---\n# keep comment\ntotp: ${seed}\nusername: alice\nextra:\n  nested: true\n`;
    expect(passSecrets(body).totp).toBe(seed);
    const updated = updatePassSecret(body, 'totp', next);
    expect(passSecrets(updated).totp).toBe(next);
    expect(updated).toContain('# keep comment');
    expect(updated).toContain('username: alice');
    expect(updated).toContain('  nested: true');
  });
  it('updates a first-line token in place and adds a password without destroying it', () => {
    expect(updatePassSecret(`${uri}\nkeep\n`, 'totp', next)).toBe(`${next}\nkeep\n`);
    expect(updatePassSecret(`${uri}\nkeep\n`, 'password', 'pw')).toBe(`pw\n${uri}\nkeep\n`);
    expect(updatePassSecret(`${uri}\nkeep\n`, 'note', 'new note')).toBe(`${uri}\nnew note`);
  });
  it('converts bare seeds on write to interoperable OTP URIs', () => {
    const body = updatePassSecret('pw\nkeep\n', 'totp', seed);
    expect(passSecrets(body).totp).toBe(`otpauth://totp/karmax?secret=${seed}`);
  });
  it('exports notes and TOTP together, including OTP-only items', () => {
    expect(passSecrets(createPassBody({ password: 'pw', note: 'keep\n', totp: uri }))).toEqual({ password: 'pw', note: `keep\n${uri}\n`, totp: uri });
    expect(passSecrets(createPassBody({ note: 'keep\n', totp: uri }))).toEqual({ note: 'keep\n', totp: uri });
  });
  it('does not mistake HOTP for TOTP or accept it on TOTP writes', () => {
    expect(passSecrets(`pw\notpauth://hotp/x?secret=${seed}&counter=0\n`).totp).toBeUndefined();
    expect(() => updatePassSecret('pw\n', 'totp', `otpauth://hotp/x?secret=${seed}`)).toThrow(/TOTP/);
  });
});

it('supports gopass key-value TOTP and otpauth fields without a YAML separator', () => {
  expect(passSecrets(`pw\ntotp: ${seed}\nusername: alice\n`).totp).toBe(seed);
  expect(passSecrets(`pw\notpauth: ${uri}\n`).totp).toBe(uri);
  const updated = updatePassSecret(`pw\ntotp: ${seed}\nusername: alice\n`, 'totp', next);
  expect(updated).toBe(`pw\ntotp: ${next}\nusername: alice\n`);
});

it('uses the same token precedence as gopass when several representations coexist', () => {
  const body = `pw\ntotp: ${seed}\notpauth: ${next}\n`;
  expect(passSecrets(body).totp).toBe(next);
  const rotated = updatePassSecret(body, 'totp', uri);
  expect(passSecrets(rotated).totp).toBe(uri);
  const appended = `pw\ntotp: ${seed}\n${next}\n`;
  expect(passSecrets(appended).totp).toBe(next);
  expect(passSecrets(updatePassSecret(appended, 'totp', uri)).totp).toBe(uri);
});
