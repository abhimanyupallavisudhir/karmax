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

  let scannerLoad;
  function loadScanner() {
    if (root.QrScanner) return Promise.resolve(root.QrScanner.scanImage);
    if (scannerLoad) return scannerLoad;
    scannerLoad = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/vendor/qr-scanner.legacy.min.js';
      script.onload = () => resolve(root.QrScanner.scanImage);
      script.onerror = () => { script.remove(); scannerLoad = null; reject(new Error(TOTP_QR_ERROR)); };
      document.head.appendChild(script);
    });
    return scannerLoad;
  }

  /** Decode locally in the browser. The pasted image is never uploaded or persisted. */
  async function decodeTotpQrImage(image, scanImage = root.QrScanner?.scanImage) {
    let result;
    try {
      scanImage ||= await loadScanner();
      result = await scanImage(image, { returnDetailedScanResult: true });
    } catch {
      throw new Error(TOTP_QR_ERROR);
    }
    return parseTotpQrPayload(typeof result === 'string' ? result : result?.data);
  }

  root.TotpQr = { decodeTotpQrImage, parseTotpQrPayload };
})(globalThis);
