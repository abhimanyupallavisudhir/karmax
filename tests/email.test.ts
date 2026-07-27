import { describe, expect, it } from 'vitest';
import { connectOutboundEmail, describeOutboundProviders, EmailService, fromAddress, guessSmtpHost } from '../src/autonomy/email.js';

describe('outbound email connect', () => {
  it('rejects a missing or invalid From', () => {
    expect(connectOutboundEmail({ provider: 'resend', secret: 're_1' }).status).toBe('unavailable');
    expect(connectOutboundEmail({ provider: 'resend', from: 'notanemail', secret: 're_1' }).status).toBe('unavailable');
  });

  it('connects Resend with an API key and From', () => {
    const r = connectOutboundEmail({ provider: 'resend', from: 'Karmax <no@reply.dev>', secret: 're_1' });
    expect(r.status).toBe('connected');
    expect(r.config).toMatchObject({ provider: 'resend', from: 'Karmax <no@reply.dev>' });
    // The secret is never returned in the config patch.
    expect(JSON.stringify(r.config)).not.toContain('re_1');
  });

  it('requires the Resend API key', () => {
    expect(connectOutboundEmail({ provider: 'resend', from: 'no@reply.dev' }).status).toBe('unavailable');
  });

  it('auto-detects the SMTP host/port for well-known providers', () => {
    const r = connectOutboundEmail({ provider: 'smtp', from: 'me@gmail.com', secret: 'apppw' });
    expect(r.status).toBe('connected');
    expect(r.config).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true, user: 'me@gmail.com' });
  });

  it('needs an explicit SMTP host for an unknown domain', () => {
    expect(connectOutboundEmail({ provider: 'smtp', from: 'me@obscure-domain.dev', secret: 'pw' }).status).toBe('unavailable');
    const r = connectOutboundEmail({ provider: 'smtp', from: 'me@obscure-domain.dev', host: 'mail.obscure-domain.dev', secret: 'pw' });
    expect(r.status).toBe('connected');
    expect(r.config).toMatchObject({ host: 'mail.obscure-domain.dev', port: 587 });
  });

  it('rejects an unknown provider', () => {
    expect(connectOutboundEmail({ provider: 'sendgridx' as any, from: 'a@b.dev', secret: 'x' }).status).toBe('unavailable');
  });
});

describe('fromAddress + host guessing', () => {
  it('extracts the bare address from a display-name From', () => {
    expect(fromAddress('Karmax <a@b.dev>')).toBe('a@b.dev');
    expect(fromAddress('a@b.dev')).toBe('a@b.dev');
    expect(fromAddress('nope')).toBeUndefined();
    expect(fromAddress(undefined)).toBeUndefined();
  });
  it('maps common domains to their SMTP host', () => {
    expect(guessSmtpHost('x@gmail.com')).toMatchObject({ host: 'smtp.gmail.com', secure: true });
    expect(guessSmtpHost('x@unknown.dev')).toBeUndefined();
  });
});

describe('EmailService.configured', () => {
  it('is false until config + resolvable secret exist', () => {
    const cfg = { provider: 'resend' as const, from: 'a@b.dev', secretHandle: 'h' };
    expect(new EmailService(() => cfg, () => 're_key').configured()).toBe(true);
    expect(new EmailService(() => cfg, () => undefined).configured()).toBe(false); // secret gone
    expect(new EmailService(() => ({ provider: 'resend', from: 'a@b.dev' }), () => 're_key').configured()).toBe(false); // no handle
    expect(new EmailService(() => ({}), () => 're_key').configured()).toBe(false);
  });
  it('smtp needs a host too', () => {
    expect(new EmailService(() => ({ provider: 'smtp', from: 'a@b.dev', secretHandle: 'h', host: 'smtp.b.dev' }), () => 'pw').configured()).toBe(true);
    expect(new EmailService(() => ({ provider: 'smtp', from: 'a@b.dev', secretHandle: 'h' }), () => 'pw').configured()).toBe(false); // no host
  });
  it('refuses to send when unconfigured', async () => {
    await expect(new EmailService(() => ({}), () => undefined).send({ to: 'x@y.dev', subject: 's', text: 't' }))
      .rejects.toThrow(/not configured/);
  });
});

describe('provider catalogue', () => {
  it('describes both providers with help + links, marking the active one connected', () => {
    const providers = describeOutboundProviders({ provider: 'resend', from: 'a@b.dev', secretHandle: 'h' });
    const resend = providers.find((p) => p.name === 'resend')!;
    expect(resend.connected).toBe(true);
    expect(resend.links.length).toBeGreaterThan(0);
    expect(providers.find((p) => p.name === 'smtp')!.connected).toBe(false);
  });
});
