#!/usr/bin/env node
// Serve the signed-out public pages (landing, docs, pricing, policies) from web/
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
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
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
  const headers = { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' };
  // The landing's film plays and seeks in byte ranges, as the gateway serves it.
  const { size } = fs.statSync(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`${siteName} public pages: http://localhost:${port}`));
