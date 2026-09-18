// Exercise the modal -> ticket -> clipboard flow without a live cloud account.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

function fixture({ checkoutError = false, ticketError = false } = {}) {
  const calls = [], copied = [], notices = [];
  const button = { addEventListener: (_, listener) => { button.click = listener; } };
  const loading = {};
  const host = {
    isConnected: true,
    querySelector(selector) { return selector === '.local-remote-terminal' ? button : selector === '.modal-loading' ? loading : null; },
    querySelectorAll() { return []; },
  };
  const ticket = { attachArgv: ['karmax'], gatewayUrl: 'https://example.test', ticket: "ticket'$(false)`false`" };
  const context = {
    document: { createElement: () => host },
    $: (selector) => selector === '#modal-root' ? { appendChild() {} } : null,
    hostLocal: () => false,
    esc: (text) => text,
    siteNameMarkup: () => 'Karmax',
    localConversationHandoff: () => '',
    api: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/terminal-ticket')) {
        if (ticketError) throw new Error('forbidden');
        return ticket;
      }
      if (checkoutError) throw new Error('branch not published');
      return { repositories: [], workspace: 'task', cloneScript: '', updateScript: '', pushScript: '' };
    },
    copyToClipboard: async (command) => copied.push(command),
    toast: (...args) => notices.push(args),
  };
  vm.createContext(context);
  vm.runInContext(slice('function remoteTerminalHandoff(v)', 'async function openProjectCheckout(project)')
    + slice('async function copyNativeAttachCommand(v)', '// Parameters: everything'), context);
  return { context, calls, copied, notices, host, button, loading, ticket };
}

for (const checkoutError of [false, true]) {
  test(`remote shell is available with ${checkoutError ? 'unpublished' : 'published'} checkout`, async () => {
    const f = fixture({ checkoutError });
    const taskId = "task'$(false)`false`";
    await f.context.openLocalCheckout({ taskId, worldAvailable: true });
    assert.match(f.host.innerHTML, /Copy terminal command/);
    assert.equal(f.calls.length, 1, 'render must not mint tickets');
    if (checkoutError) assert.equal(f.loading.textContent, 'branch not published');
    await f.button.click();
    assert.equal(f.calls[1].url, `/api/tasks/${encodeURIComponent(taskId)}/terminal-ticket`);
    assert.equal(f.calls[1].options.method, 'POST');
    assert.equal(f.copied.length, 1);
    // Execute the generated command against a shell function to verify every
    // argument is literal, including apostrophes and command substitutions.
    const result = spawnSync('bash', ['-c', 'karmax() { printf "%s\\0" "$@"; }; ' + f.copied[0]]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout.toString().split('\0').slice(0, -1),
      ['attach', taskId, '--url', f.ticket.gatewayUrl, '--ticket', f.ticket.ticket]);
  });
}

test('ticket failure is reported without copying a command', async () => {
  const f = fixture({ ticketError: true });
  await f.context.openLocalCheckout({ taskId: 'task', worldAvailable: true });
  await f.button.click();
  assert.equal(f.copied.length, 0);
  assert.deepEqual(f.notices, [['forbidden', true]]);
});
