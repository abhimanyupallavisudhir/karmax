// Working on someone else's repository: the fork names where its pull requests
// go, and the fork dialog reads the repository from any GitHub address.
// Run: node web/fork-repository.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const helpers = src.slice(src.indexOf('function repositoryLabel('), src.indexOf('// Work on someone else'));
const context = vm.createContext({});
vm.runInContext(helpers, context);

test('a fork is labelled with the repository its pull requests go to', () => {
  assert.equal(context.repositoryLabel({ owner: 'jane', name: 'widgets', upstream: { owner: 'acme', name: 'widgets' } }), 'jane/widgets → acme/widgets');
  assert.equal(context.repositoryLabel({ owner: 'jane', name: 'own' }), 'jane/own');
});

test('the fork dialog accepts a GitHub URL, SSH address or owner/name', () => {
  for (const input of ['https://github.com/acme/widgets', 'github.com/acme/widgets/', 'git@github.com:acme/widgets.git',
    'https://github.com/acme/widgets.git', ' acme/widgets '])
    assert.equal(context.githubRepositorySlug(input), 'acme/widgets', input);
  for (const input of ['', 'widgets', 'https://gitlab.com/acme/widgets', 'acme/widgets/tree/main'])
    assert.equal(context.githubRepositorySlug(input), '', input);
});

test('the fork dialog attaches only a fork of the named repository', () => {
  const dialog = src.slice(src.indexOf('function openForkRepositoryDialog('), src.indexOf('function openNewGithubRepositoryDialog('));
  assert.match(dialog, /https:\/\/github\.com\/\$\{slug\}\/fork/);
  assert.match(dialog, /repository\.upstream\s*\n?\s*&& `\$\{repository\.upstream\.owner\}\/\$\{repository\.upstream\.name\}`\.toLowerCase\(\) === slug/);
  assert.match(dialog, /\/api\/projects\/\$\{proj\.id\}\/repositories`, \{ method: 'POST'/);
});
