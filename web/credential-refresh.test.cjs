// Reproduces the Agent-login/API-key settings race: the initial page hydration
// can resolve after the post-mutation hydration and replace the newly-added row
// with its older "No credentials yet" snapshot.
// Run: node web/credential-refresh.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  const signatureEnd = src.indexOf(') {', start);
  const open = src.indexOf('{', signatureEnd);
  for (let index = open; index < src.length; index++) {
    if (src[index] === '{') depth++;
    else if (src[index] === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const element = {
  innerHTML: '',
  querySelectorAll: () => [],
  querySelector: () => null,
};
global.S = { organizationId: 'org' };
global.projectById = () => null;
global.esc = (value) => String(value);
global.wireCredDrag = () => {};
const renderEpochs = new WeakMap();
global.beginAsyncElementRender = (target) => {
  const epoch = (renderEpochs.get(target) || 0) + 1;
  renderEpochs.set(target, epoch);
  return () => renderEpochs.get(target) === epoch;
};

eval(extractFn('renderCredentialEditor'));

let passed = 0;
let failed = 0;
function ok(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('FAIL:', message);
  }
}

(async () => {
  const staleCredentials = deferred();
  const staleAccounts = deferred();
  let request = 0;
  const key = 'login:org:claude:work';
  global.api = () => {
    request++;
    if (request === 1) return staleCredentials.promise;
    if (request === 2) return staleAccounts.promise;
    if (request === 3) return Promise.resolve({
      credentials: [{ key, kind: 'login', provider: 'claude', label: 'claude:work' }],
      global: { own: {}, enabled: [key] },
    });
    return Promise.resolve({
      logins: [{ key, provider: 'claude', account: 'work', loggedIn: false }],
    });
  };

  const initialHydration = renderCredentialEditor(element, 'global', { organizationId: 'org' });
  const postConnectHydration = renderCredentialEditor(element, 'global', { organizationId: 'org' });
  await postConnectHydration;
  ok(element.innerHTML.includes('claude:work'), 'the newly connected login appears immediately');

  staleCredentials.resolve({ credentials: [], global: { own: {}, enabled: [] } });
  staleAccounts.resolve({ logins: [] });
  await initialHydration;
  ok(element.innerHTML.includes('claude:work'), 'an older hydration cannot erase the newly connected login');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
