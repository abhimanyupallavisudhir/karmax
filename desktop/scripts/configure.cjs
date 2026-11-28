// Bakes the console URL into the package (app-config.json, read by
// src/config.cjs), so a build for another server needs no code change:
//   TAVYA_URL=https://tavya.example.com npm run dist:linux
// Runs before every dist:* script. Refuses what the app would refuse.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_URL, resolveServer } = require('../src/config.cjs');

const server = resolveServer(process.env.TAVYA_URL || DEFAULT_URL);
fs.writeFileSync(path.join(__dirname, '..', 'app-config.json'), `${JSON.stringify({ url: server.url }, null, 2)}\n`);
console.log(`app-config.json: ${server.url}`);
