// An upload of any size, in rounds the server can take (wiki features/project-files § Uploads).
// Run: node web/files-upload-rounds.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const body = src.indexOf(') {', start) + 2;
  let depth = 0;
  for (let index = body; index < src.length; index++) {
    if (src[index] === '{') depth++;
    else if (src[index] === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

let passed = 0, failed = 0;
const ok = (condition, message) => { if (condition) passed++; else { failed++; console.error('FAIL:', message); } };

global.FV = { parts: (p) => String(p).split('/').filter(Boolean), join: (...p) => p.filter(Boolean).join('/'), formatBytes: (n) => `${Math.round(n / 1e6)} MB` };
eval(src.match(/const UPLOAD_ROUND = \{[^}]*\};/)[0].replace('const ', 'global.'));
eval(src.match(/const LARGE_FOLDER = \{[^}]*\};/)[0].replace('const ', 'global.'));
for (const name of ['uploadRounds', 'uploadChange', 'recommendLargeFolders']) eval(`global.${name} = ${extractFn(name)}`);

const file = (rel, size) => ({ rel, file: { size } });

// Rounds hold at most UPLOAD_ROUND files and bytes, keep order, and lose nothing.
const many = Array.from({ length: 23_500 }, (_, i) => file(`bot_data/f${i}`, 10));
const rounds = uploadRounds(many);
ok(rounds.length === 3, `23,500 small files are three rounds (got ${rounds.length})`);
ok(rounds.every((round) => round.length <= UPLOAD_ROUND.files), 'no round over the file bound');
ok(rounds.flat().length === many.length && rounds.flat().every((item, i) => item === many[i]), 'every file once, in order');
const heavy = Array.from({ length: 5 }, (_, i) => file(`big/f${i}`, 400 * 1024 * 1024));
const byBytes = uploadRounds(heavy);
ok(byBytes.every((round) => round.reduce((sum, item) => sum + item.file.size, 0) <= UPLOAD_ROUND.bytes), 'no round over the byte bound');
ok(byBytes.length === 3, `five 400 MB files are three rounds (got ${byBytes.length})`);
ok(uploadRounds([file('huge', UPLOAD_ROUND.bytes + 1)]).length === 1, 'a file over the bound still gets a round of its own');
ok(uploadRounds(Array.from({ length: 8598 }, (_, i) => file(`bot_data/f${i}`, 70_000))).length === 1, 'bot_data (8,598 files, 603 MB) is one round: one commit');

// A new data folder is made by its first round; later rounds add to it as plain writes.
const made = new Set();
const item = { rel: 'bot_data/a.txt', keep: 'data', dataFolder: 'site/bot_data' };
const first = uploadChange(item, 'site', 'u1', made);
ok(first.keep === 'data' && first.dataFolder === 'site/bot_data' && first.path === 'site/bot_data/a.txt' && first.upload === 'u1', 'the first round makes the data folder');
made.add('site/bot_data');
const later = uploadChange({ ...item, rel: 'bot_data/b.txt' }, 'site', 'u2', made);
ok(later.keep === undefined && later.dataFolder === undefined && later.path === 'site/bot_data/b.txt', 'a later round writes into it');
const secret = uploadChange({ rel: '.env', keep: 'secret' }, 'site', 'u3', made);
ok(secret.keep === 'secret', 'a secret stays a secret');
ok(uploadChange({ rel: 'x.txt', keep: 'git' }, 'site', 'u4', made).keep === undefined, 'Git is a plain write');

// A big folder is recommended as data (a secret in it stays a secret; what is fixed stays fixed).
const planned = (rel, size, plan = { keep: 'git' }) => ({ rel, file: { size }, plan });
const big = [...Array.from({ length: LARGE_FOLDER.files }, (_, i) => planned(`bot_data/f${i}`, 1)), planned('bot_data/.env', 10, { keep: 'secret', why: 'Holds environment variables' }),
  planned('notes.md', 5), ...Array.from({ length: 3 }, (_, i) => planned(`small/f${i}`, 1))];
const advised = recommendLargeFolders(big);
ok(advised.filter((x) => x.rel.startsWith('bot_data/f')).every((x) => x.plan.keep === 'data' && /large folder/i.test(x.plan.why)), 'a folder of many files is recommended as data');
ok(advised.find((x) => x.rel === 'bot_data/.env').plan.keep === 'secret', 'a secret inside stays a secret');
ok(advised.find((x) => x.rel === 'notes.md').plan.keep === 'git' && advised.filter((x) => x.rel.startsWith('small/')).every((x) => x.plan.keep === 'git'), 'small folders and loose files stay as planned');
const weighty = recommendLargeFolders([planned('media/a', LARGE_FOLDER.bytes / 2), planned('media/b', LARGE_FOLDER.bytes / 2)]);
ok(weighty.every((x) => x.plan.keep === 'data'), 'a folder over the byte bound is recommended as data');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
