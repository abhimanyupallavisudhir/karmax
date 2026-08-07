import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const webDir = path.resolve('web');
const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
const qrSource = fs.readFileSync(path.join(webDir, 'totp-qr.js'), 'utf8');
interface TotpQrApi {
  parseTotpQrPayload(payload: string): string;
  decodeTotpQrImage(image: Blob, scanImage: (image: Blob, options: object) => Promise<unknown>): Promise<string>;
}
const qrContext = { URL, globalThis: {} as { TotpQr?: TotpQrApi } };
new vm.Script(qrSource).runInNewContext(qrContext);
const { decodeTotpQrImage, parseTotpQrPayload } = qrContext.globalThis.TotpQr!;

describe('manual TOTP entry', () => {
  it('starts expanded and explains every accepted TOTP source', () => {
    expect(app).toContain('<details class="vault-custom" open>');
    expect(app).toContain('TOTP seed (base32, otpauth:// URI, or paste image of QR code)');
  });

  it('turns a pasted image into an in-field QR attachment', () => {
    expect(app).toContain("addEventListener('paste'");
    expect(app).toContain("item.type.startsWith('image/')");
    expect(app).toContain('decodeTotpQrImage(image)');
    expect(app).toContain('class="totp-qr-preview"');
    expect(app).toContain('alt="Pasted TOTP QR code"');
    expect(app).toContain('10 * 1024 * 1024');
    expect(css).toContain('.totp-qr-preview');
    expect(css).toContain('.totp-secret-control.has-qr');
    expect(html.indexOf('/vendor/qr-scanner.legacy.min.js')).toBeLessThan(html.indexOf('/totp-qr.js'));
    expect(html.indexOf('/totp-qr.js')).toBeLessThan(html.indexOf('/app.js'));
  });
});

describe('TOTP QR decoding', () => {
  const uri = 'otpauth://totp/GitHub%3Aalice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';

  it('accepts only TOTP setup URIs with a seed', () => {
    expect(parseTotpQrPayload(`  ${uri}\n`)).toBe(uri);
    expect(() => parseTotpQrPayload('https://example.com')).toThrow(/TOTP setup link/);
    expect(() => parseTotpQrPayload('otpauth://hotp/x?secret=ABC')).toThrow(/TOTP setup link/);
    expect(() => parseTotpQrPayload('otpauth://totp/x')).toThrow(/TOTP setup link/);
  });

  it('reads the decoded payload returned by the image scanner', async () => {
    const scan = vi.fn().mockResolvedValue({ data: uri });
    const image = new Blob(['qr'], { type: 'image/png' });
    await expect(decodeTotpQrImage(image, scan)).resolves.toBe(uri);
    expect(scan).toHaveBeenCalledWith(image, { returnDetailedScanResult: true });
  });

  it('gives a useful error when the image has no readable setup QR', async () => {
    const scan = vi.fn().mockRejectedValue(new Error('No QR code found'));
    await expect(decodeTotpQrImage(new Blob([]), scan)).rejects.toThrow(/read a TOTP QR code/);
  });
});
