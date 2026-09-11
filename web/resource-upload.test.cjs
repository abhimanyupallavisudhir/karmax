const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = source.indexOf('async function uploadResourceFiles(');
// Up to the next top-level declaration, whatever it is (the helper that used to
// follow uploadResourceFiles was removed as dead code).
const end = start + 1 + source.slice(start + 1).search(/\n(?:async )?function /);
const requests = [];
const context = { encodeURIComponent, api: async (url, options = {}) => {
  requests.push({ url, ...options });
  return options.method === 'POST' && url.endsWith('/uploads') ? { id: 'upload', partBytes: 2 } : {};
}};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
(async () => {
  const plain = new File(['abc'], 'single.txt');
  const nested = new File(['x'], 'nested.txt');
  Object.defineProperty(nested, 'webkitRelativePath', { value: 'folder/sub/nested.txt' });
  await context.uploadResourceFiles('project', 'resource', [plain, nested, new File([], 'empty.txt')]);
  const parts = requests.filter(r => r.method === 'PUT');
  assert.deepEqual(parts.map(r => [new URL(r.url, 'https://example.test').searchParams.get('path'), r.body.size]),
    [['single.txt', 2], ['single.txt', 1], ['sub/nested.txt', 1], ['empty.txt', 0]]);
  assert.equal(requests.at(-1).method, 'POST');
  console.log('File, folder, multipart, and empty-file uploads passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
