#!/usr/bin/env node
// Serve the signed-out public pages (landing, pricing, policies) from web/
// without booting Temporal, the worker or the gateway. The console has no build
// step, so this is the exact markup and CSS production serves; only the three
// bootstrap API calls are stubbed as a signed-out visitor would see them.
//
//   npm run preview:landing                     # http://localhost:4173
//   PORT=5000 SITE_NAME=tavya BRAND_ICON=royal-gold-arrow node scripts/preview-landing.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const port = Number(process.env.PORT || 4173);
const siteName = process.env.SITE_NAME || 'tavya';
// The gateway resolves /brand/<file> against the installation's icon setting.
const brandIcon = process.env.BRAND_ICON || 'royal-gold-arrow';

const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const api = {
  '/api/meta': { siteName, hosted: true, version: 'preview' },
  '/api/launch': {},
  '/api/session': { authRequired: true, authenticated: false },
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://preview');
  if (url.pathname.startsWith('/api/')) {
    const body = api[url.pathname];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(body ?? { error: 'not available in the landing preview' }));
  }
  let file = path.join(web, path.normalize(url.pathname));
  if (/^\/brand\/[^/]+\.(png|svg)$/.test(url.pathname)) file = path.join(web, 'brand', brandIcon, path.basename(url.pathname));
  if (!file.startsWith(web) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(web, 'index.html');
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`${siteName} public pages: http://localhost:${port}`));
