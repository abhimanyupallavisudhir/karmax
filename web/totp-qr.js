(function installTotpQr(root) {
  const TOTP_QR_ERROR = 'Could not read a TOTP QR code. Paste a clear image of the setup QR code.';

  /** Accept only authenticator setup links; an arbitrary QR code must never become a secret. */
  function parseTotpQrPayload(payload) {
    const value = String(payload ?? '').trim();
    try {
      const uri = new URL(value);
      if (uri.protocol !== 'otpauth:' || uri.hostname.toLowerCase() !== 'totp' || !uri.searchParams.get('secret')) {
        throw new Error();
      }
    } catch {
      throw new Error('QR code does not contain a TOTP setup link with a seed.');
    }
    return value;
  }

  /** Decode locally in the browser. The pasted image is never uploaded or persisted. */
  async function decodeTotpQrImage(image, scanImage = root.QrScanner?.scanImage) {
    let result;
    try {
      if (!scanImage) throw new Error('QR scanner unavailable');
      result = await scanImage(image, { returnDetailedScanResult: true });
    } catch {
      throw new Error(TOTP_QR_ERROR);
    }
    return parseTotpQrPayload(typeof result === 'string' ? result : result?.data);
  }

  root.TotpQr = { decodeTotpQrImage, parseTotpQrPayload };
})(globalThis);
