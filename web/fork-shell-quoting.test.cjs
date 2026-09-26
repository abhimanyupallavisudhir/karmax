const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const src = fs.readFileSync(`${__dirname}/app.js`, 'utf8');
const start = src.indexOf('function forkCommandFor(');
test('UI-27: copied fork commands quote literal paths and session IDs', () => {
  const ctx = vm.createContext({}); vm.runInContext(src.slice(start, src.indexOf('\n}', start)+2), ctx);
  for (const provider of ['claude','codex']) {
    const command = ctx.forkCommandFor({ provider, home: '/tmp/$(echo injected)\'"', id: 'session; echo injected' }, '/tmp/$(echo injected)');
    // Replace only cd and the program with print helpers; the shell still parses all argument quoting.
    const shim = 'cd() { printf "<%s>\\n" "$1"; }; codex() { printf "<%s>\\n" "$CODEX_HOME" "$@"; }; claude() { printf "<%s>\\n" "$CLAUDE_CONFIG_DIR" "$@"; }; ';
    const output = execFileSync('sh',['-c',shim+command],{encoding:'utf8'});
    assert.ok(output.includes('</tmp/$(echo injected)>')); assert.ok(output.includes('<session; echo injected>'));
  }
});
