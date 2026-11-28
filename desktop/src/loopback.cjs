// Sign-in through the system browser with a loopback redirect (RFC 8252 §7.3;
// wiki planned/native-apps-round-2, contract 2). The console builds the
// authorize URL for client tavya-desktop with redirect_uri
// http://127.0.0.1/signed-in; this listens once on 127.0.0.1:<random port>,
// puts that port into the redirect_uri, opens the browser and resolves with
// the URL the browser was sent back to. PKCE, state and iss are checked by the
// console, which also redeems the code.
'use strict';
const http = require('node:http');

const CALLBACK_PATH = '/signed-in';
const TIMEOUT_MS = 10 * 60_000;

function cancelled(message = 'Sign-in was cancelled.') {
  return { code: 'cancelled', message };
}

function page(title, text) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;
font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;text-align:center}h1{font-size:20px;margin:0 0 6px}p{margin:0;opacity:.7}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

/**
 * One sign-in attempt. `openExternal(url)` opens the system browser.
 * Returns {promise, cancel}; the promise resolves {url} or rejects {code, message}.
 */
function loopbackSignIn(authorizeUrl, { origin, openExternal, timeoutMs = TIMEOUT_MS, onReturn = () => {} }) {
  let settle;
  const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  let authorize;
  try {
    authorize = new URL(authorizeUrl);
  } catch {
    settle.reject({ code: 'invalid', message: 'Not a sign-in URL.' });
    return { promise, cancel() {} };
  }
  // Only ever the console's own authorization endpoint: the page cannot use
  // this to open arbitrary URLs with a live listener behind them.
  if (authorize.origin !== origin || authorize.pathname !== '/oauth/authorize') {
    settle.reject({ code: 'invalid', message: 'Sign-in must go to this tavya.' });
    return { promise, cancel() {} };
  }
  let done = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || done) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const denied = url.searchParams.has('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(denied ? page('Sign-in cancelled', 'You can close this tab.') : page('Signed in', 'You can close this tab and go back to tavya.'));
    finish(null, { url: `http://127.0.0.1:${server.address().port}${req.url}` });
  });
  const timer = setTimeout(() => finish(cancelled('Sign-in timed out. Try again.')), timeoutMs);
  timer.unref?.();
  function finish(error, value) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    if (error) return settle.reject(error);
    onReturn();
    settle.resolve(value);
  }
  server.on('error', (error) => finish({ code: 'failed', message: `Could not start sign-in: ${error.message}` }));
  server.listen(0, '127.0.0.1', async () => {
    authorize.searchParams.set('redirect_uri', `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`);
    try { await openExternal(authorize.href); }
    catch (error) { finish({ code: 'failed', message: `Could not open your browser: ${error?.message || error}` }); }
  });
  return { promise, cancel: () => finish(cancelled()) };
}

module.exports = { loopbackSignIn, CALLBACK_PATH };
