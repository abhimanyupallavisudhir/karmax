// Working on someone else's repository: the fork names where its pull requests
// go, and the fork dialog reads the repository from any GitHub address.
// Run: node web/fork-repository.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const helpers = src.slice(src.indexOf('function githubRepositorySlug('), src.indexOf('// Work on someone else'));
const context = vm.createContext({});
vm.runInContext(helpers, context);

test('a fork in the repository list names the repository its pull requests go to', () => {
  const panel = src.slice(src.indexOf('function gitRepoRow('), src.indexOf('async function hydrateProjectAccess('));
  assert.match(panel, /git-repo-upstream" title="Pull requests go to \$\{esc\(upstream\.owner\)\}\/\$\{esc\(upstream\.name\)\} after Review">→ /);
  // Forking is offered from the repository combobox, beside the organization's own.
  assert.match(panel, /fork: githubApp\.configured && gitConnections\.length \? \(slug, opener\) => openForkRepositoryDialog\(proj\.organizationId, opener, githubApp, slug, /);
  // New project offers it too, attaching the fork to the project it makes.
  const newProject = src.slice(src.indexOf('function newProject('), src.indexOf('const loadGithub = async () =>', src.indexOf('function newProject(')));
  assert.match(newProject, /fork: githubApp\.configured && gitConnections\.length \? \(slug, opener\) => openForkRepositoryDialog\(organizationId, opener, githubApp, slug, attach\)/);
});

test('a GitHub URL, page address, SSH address or owner/name all name the repository', () => {
  for (const input of ['https://github.com/acme/widgets', 'github.com/acme/widgets/', 'git@github.com:acme/widgets.git',
    'https://github.com/acme/widgets.git', ' acme/widgets ', 'https://www.github.com/acme/widgets',
    'https://github.com/acme/widgets/tree/main/src', 'https://github.com/acme/widgets/pull/3?tab=files',
    'ssh://git@ssh.github.com:443/acme/widgets.git', 'git://github.com/acme/widgets.git'])
    assert.equal(context.githubRepositorySlug(input), 'acme/widgets', input);
  for (const input of ['', 'widgets', 'https://gitlab.com/acme/widgets', 'acme/widgets/tree/main', '/srv/acme/widgets', './acme/widgets', 'https://github.com/acme'])
    assert.equal(context.githubRepositorySlug(input), '', input);
});

test('the console reads GitHub addresses exactly as the server does', () => {
  const server = fs.readFileSync(`${__dirname}/../src/world/repository-identity.ts`, 'utf8');
  const patterns = (text) => [...text.matchAll(/\/\^[^\n]*?\$\/i?/g)].map((match) => match[0]);
  const client = src.slice(src.indexOf('function githubRepositorySlug('), src.indexOf('\n}\n', src.indexOf('function githubRepositorySlug(')));
  const serverReader = server.slice(server.indexOf('export function githubRepositoryOf('));
  for (const pattern of ['/^(?:(?:https?|ssh|git):\\/\\/)?(?:[\\w.-]+@)?(?:www\\.|ssh\\.)?github\\.com(?::\\d+)?[/:]([^?#]*)/i'])
    assert.ok(client.includes(pattern) && serverReader.includes(pattern), pattern);
  for (const pattern of patterns(client).filter((pattern) => !pattern.startsWith('/^\\.')))
    assert.ok(serverReader.includes(pattern), pattern);
});

test('the fork dialog attaches only a fork of the named repository', () => {
  const dialog = src.slice(src.indexOf('function openForkRepositoryDialog('), src.indexOf('function openNewGithubRepositoryDialog('));
  assert.match(dialog, /https:\/\/github\.com\/\$\{slug\}\/fork/);
  assert.match(dialog, /repository\.upstream\s*\n?\s*&& `\$\{repository\.upstream\.owner\}\/\$\{repository\.upstream\.name\}`\.toLowerCase\(\) === slug/);
  assert.match(dialog, /await attach\(fork, repositories\)/);
});
