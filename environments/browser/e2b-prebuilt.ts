import fs from 'node:fs';
import { Template, defaultBuildLogger } from 'e2b';
import { CODEX_VERSION } from '../../src/agent/codex-history.js';
import { installedClaudeCodeVersion } from '../../src/agent/remote-process.js';
import { PINNED_REMOTE_NODE_VERSION, PINNED_REMOTE_NPM_VERSION } from '../../src/agent/remote-node.js';
import { PLAYWRIGHT_VERSION, PLAYWRIGHT_MCP_VERSION, CHROME_DEVTOOLS_MCP_VERSION } from '../../src/autonomy/config-homes.js';

// Build directly from E2B's stock template; no image registry login or task data
// is needed. The API key is supplied to the SDK, never to a template command.
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const nodeVersion = process.env.KARMAX_REMOTE_NODE_VERSION ?? PINNED_REMOTE_NODE_VERSION;
const npmVersion = process.env.KARMAX_REMOTE_NPM_VERSION ?? PINNED_REMOTE_NPM_VERSION;
const root = `/opt/karmax/node-${nodeVersion}`;
const smoke = fs.readFileSync(new URL('./smoke.mjs', import.meta.url), 'utf8');
const command = [
  `mkdir -p ${quote(`${root}/bin`)} /opt/karmax/browser /opt/karmax/bin /opt/karmax/agents /opt/karmax/browsers`,
  `npm install --prefix ${quote(root)} --no-audit --no-fund --omit=dev ${quote(`node@${nodeVersion}`)} ${quote(`npm@${npmVersion}`)}`,
  ...[['node', '../node_modules/node/bin/node'], ['npm', '../node_modules/npm/bin/npm-cli.js'], ['npx', '../node_modules/npm/bin/npx-cli.js']]
    .map(([name, target]) => `ln -sfn ${quote(target!)} ${quote(`${root}/bin/${name}`)}`),
  `export PATH=${quote(`${root}/bin`)}:$PATH`,
  `npm install --prefix /opt/karmax/browser --no-audit --no-fund --omit=dev ${[
    `playwright@${PLAYWRIGHT_VERSION}`, `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`,
  ].map(quote).join(' ')}`,
  'PLAYWRIGHT_BROWSERS_PATH=/opt/karmax/browsers /opt/karmax/browser/node_modules/.bin/playwright install --with-deps chromium',
  ...['playwright-mcp', 'chrome-devtools-mcp'].map(name => `ln -sfn /opt/karmax/browser/node_modules/.bin/${name} /opt/karmax/bin/${name}`),
  `npm install --prefix /opt/karmax/agents --no-audit --no-fund --omit=dev ${[
    process.env.KARMAX_REMOTE_CLAUDE_PACKAGE ?? `@anthropic-ai/claude-code@${installedClaudeCodeVersion()}`,
    process.env.KARMAX_REMOTE_CODEX_PACKAGE ?? `@openai/codex@${CODEX_VERSION}`,
  ].map(quote).join(' ')}`,
  ...['claude', 'codex'].map(name => `ln -sfn /opt/karmax/agents/node_modules/.bin/${name} /opt/karmax/bin/${name}`),
  `printf %s ${quote(smoke)} > /opt/karmax/smoke.mjs`,
  'chmod -R a+rX /opt/karmax',
  'PLAYWRIGHT_BROWSERS_PATH=/opt/karmax/browsers node /opt/karmax/smoke.mjs',
].join(' && ');
const template = Template().fromTemplate(process.env.KARMAX_E2B_BASE_TEMPLATE ?? 'codex').runCmd(command, { user: 'root' });
// E2B fixes memory per template. 2 GiB leaves ~1.1 GiB beside the agent and
// browser, too little to type-check a mid-sized TypeScript repo (tasks 348/349);
// build a larger variant for such projects with KARMAX_E2B_MEMORY_MB=4096.
const result = await Template.build(template, process.env.KARMAX_E2B_TEMPLATE_TAG ?? 'karmax-browser-v2', {
  cpuCount: 2, memoryMB: Number(process.env.KARMAX_E2B_MEMORY_MB ?? 2048), onBuildLogs: defaultBuildLogger(),
});
console.log(JSON.stringify(result));
