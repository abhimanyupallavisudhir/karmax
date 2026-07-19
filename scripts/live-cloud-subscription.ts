import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldProviderConnectionService } from '../src/world/connections.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import type { PlatformToolContext } from '../src/agent/types.js';
import type { AgentActivity } from '../src/domain/types.js';

/** Explicit, billable smoke test against an already-configured Karmax instance.
 * Unlike tests/cloud-live.test.ts, this resolves the E2B key from Karmax's vault
 * and proves that a subscription Codex process and browser MCP run in the remote
 * sandbox while Karmax dynamic tools traverse the existing app-server channel. */
async function main() {
  const home = path.resolve(process.env.KARMAX_LIVE_HOME ?? process.env.KARMAX_HOME ?? path.join(os.homedir(), '.karmax'));
  const taskId = process.env.KARMAX_LIVE_TASK_ID;
  if (!taskId) throw new Error('set KARMAX_LIVE_TASK_ID to an existing task whose scoped platform tools should be tested');

  const store = new Store(path.join(home, 'state', 'karmax.db'));
  const task = store.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  const project = store.getProject(task.projectId);
  if (!project?.organizationId) throw new Error('task project has no organization');
  const localHome = resolveCodexHome(home);
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-codex-home-'));
  fs.cpSync(localHome, isolatedHome, { recursive: true });

  const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
  const connections = new WorldProviderConnectionService(store, broker);
  const connection = connections.get(project.organizationId, 'e2b');
  if (!connection?.enabled || !connection.credentialConfigured) throw new Error('E2B is not enabled and credentialed for this organization');
  const provider = new E2BWorldProvider(undefined, undefined, undefined,
    (organizationId, kind) => connections.resolve(organizationId, kind));
  const tokens = new TokenAuthority(store);
  const minted = tokens.mint({ taskId, profileId: 'live-cloud-smoke', principal: 'system:live-cloud-smoke',
    projectId: task.projectId, organizationId: project.organizationId,
    ceiling: ['task:event:read'], grantorCaps: ['task:event:read'], ttlMs: 15 * 60_000 });
  let world: Awaited<ReturnType<E2BWorldProvider['create']>> | undefined;
  try {
    console.error('[live-cloud] creating E2B sandbox');
    world = await provider.create({ taskId: `live-e2b-subscription-${Date.now()}`,
      organizationId: project.organizationId, base: 'main',
      network: { allowDomains: ['example.com'] } });
    const basic = await world.exec('bash', ['-lc', 'node --version && git --version']);
    if (basic.code !== 0) throw new Error(`sandbox toolchain failed: ${basic.stderr || basic.stdout}`);
    await world.writeFile('live-roundtrip.txt', 'round-trip');
    if (await world.readFile('live-roundtrip.txt') !== 'round-trip') throw new Error('sandbox file round-trip failed');

    console.error('[live-cloud] seeding subscription/browser runtime and starting remote Codex');
    // Stock templates may need several minutes to install Node, Chromium, and
    // browser OS packages before the model process even starts. Keep the live
    // diagnostic deadline comfortably beyond that one-time bootstrap.
    const turnTimeout = AbortSignal.timeout(12 * 60_000);
    const activities: AgentActivity[] = [];
    const result = await new CodexAdapter().runTurn({
      profile: { id: 'live-cloud-smoke', name: 'live cloud smoke', provider: 'codex', role: 'do',
        effort: 'low', capabilities: ['task:event:read'] },
      world,
      messages: [{ id: 'live', role: 'user', ts: Date.now(), text:
        `First call the Karmax list_events tool for taskId ${JSON.stringify(taskId)} with since 0. ` +
        'Then use the chrome-devtools MCP to open https://example.com and take a screenshot. ' +
        'After both tools succeed, reply with exactly READY and do not modify files.' }],
      systemPrompt: 'You are a live integration test. Follow the user request exactly and keep the final response terse.',
      role: 'do', resolvedAuth: { configHome: isolatedHome }, extraEnv: { KARMAX_TOKEN: minted.token },
    }, context(turnTimeout, activities, async (method, requestPath) => {
      const checked = tokens.check(minted.token, 'task:event:read', { projectId: task.projectId, taskId });
      if (!checked.ok) throw new Error(checked.reason);
      if (method !== 'GET' || !requestPath.startsWith(`/api/tasks/${encodeURIComponent(taskId)}/events`))
        throw new Error(`unexpected live platform request: ${method} ${requestPath}`);
      return store.eventsSince(taskId, 0);
    }));
    if (!result.session || !/READY/i.test(result.output)) {
      const observed = activities.map(({ kind, phase, title, detail }) => ({ kind, phase, title, detail }));
      throw new Error(`remote subscription turn returned an unexpected result: ${result.output.slice(0, 300)}; activities=${JSON.stringify(observed)}`);
    }
    const completedTools = activities.filter((activity) => activity.kind === 'tool' && activity.phase === 'completed');
    const usedPlatform = completedTools.some((activity) => /list_events/i.test(activity.title));
    const usedBrowser = completedTools.some((activity) => /chrome-devtools.*(?:screenshot|take_screenshot)/i.test(activity.title));
    if (!usedPlatform || !usedBrowser) {
      const observed = activities.map(({ kind, phase, title }) => ({ kind, phase, title }));
      throw new Error(`remote turn did not prove both MCPs completed: ${JSON.stringify(observed)}`);
    }
    const resumedActivities: AgentActivity[] = [];
    const resumed = await new CodexAdapter().runTurn({
      profile: { id: 'live-cloud-smoke', name: 'live cloud smoke', provider: 'codex', role: 'do',
        effort: 'low', capabilities: ['task:event:read'] },
      world, session: result.session,
      messages: [{ id: 'resume', role: 'user', ts: Date.now(), text:
        `Call the Karmax list_events tool again for taskId ${JSON.stringify(taskId)} with since 0, then reply with exactly RESUMED.` }],
      systemPrompt: 'You are a live integration test. Follow the user request exactly and keep the final response terse.',
      role: 'do', resolvedAuth: { configHome: isolatedHome },
    }, context(turnTimeout, resumedActivities, async (method, requestPath) => {
      const checked = tokens.check(minted.token, 'task:event:read', { projectId: task.projectId, taskId });
      if (!checked.ok) throw new Error(checked.reason);
      if (method !== 'GET' || !requestPath.startsWith(`/api/tasks/${encodeURIComponent(taskId)}/events`))
        throw new Error(`unexpected resumed platform request: ${method} ${requestPath}`);
      return store.eventsSince(taskId, 0);
    }));
    if (!/RESUMED/i.test(resumed.output) || !resumedActivities.some((activity) =>
      activity.kind === 'tool' && activity.phase === 'completed' && /list_events/i.test(activity.title))) {
      throw new Error(`resumed remote session lost its Karmax dynamic tools: ${JSON.stringify(resumedActivities)}`);
    }
    console.log(JSON.stringify({ ok: true, provider: 'e2b', template: connection.config.template,
      sandboxToolchain: true, fileRoundTrip: true, subscriptionAgent: true,
      platformDynamicTools: true, resumedPlatformDynamicTools: true, browserMcp: 'chrome-devtools', session: true }));
  } catch (error) {
    if (world) {
      const diagnostics = await world.exec('bash', ['-lc',
        'for f in .karmax-injection/agent/*/*/agent-stderr.log; do [ -f "$f" ] && { echo "== $f =="; tail -80 "$f"; }; done'],
      ).catch(() => undefined);
      if (diagnostics && (diagnostics.stdout || diagnostics.stderr))
        console.error(`[live-cloud] remote diagnostics\n${diagnostics.stdout}${diagnostics.stderr}`);
    }
    throw error;
  } finally {
    tokens.revoke(minted.token);
    if (process.env.KARMAX_LIVE_KEEP_SANDBOX === '1' && world)
      console.error(`[live-cloud] preserving diagnostic sandbox for ${world.handle.id}`);
    else if (world) {
      let cleanupError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await world.destroy(); cleanupError = undefined; break; }
        catch (error) { cleanupError = error; }
      }
      if (cleanupError) console.error(`[live-cloud] sandbox cleanup failed after three attempts: ${String(cleanupError)}`);
    }
    fs.rmSync(isolatedHome, { recursive: true, force: true });
    store.db.close();
  }
}

function resolveCodexHome(home: string): string {
  const explicit = process.env.KARMAX_LIVE_CODEX_HOME;
  if (explicit && fs.existsSync(path.join(explicit, 'auth.json'))) return path.resolve(explicit);
  const root = path.join(home, 'config-homes');
  const selected = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('codex-'))
    .map((entry) => path.join(root, entry.name))
    .find((candidate) => fs.existsSync(path.join(candidate, 'auth.json')));
  if (!selected) throw new Error('no logged-in Codex config home found; set KARMAX_LIVE_CODEX_HOME');
  return selected;
}

function context(signal: AbortSignal, activities: AgentActivity[],
  platformRequest: NonNullable<PlatformToolContext['platformRequest']>): PlatformToolContext {
  return {
    signalCompletion() {}, createReviewInfo() {}, createSubTask() {}, respondToSubTask() {}, raiseToParent() {},
    waitForSubtasks() {}, saveSkill() {}, resolveDecision() {}, confirmDecision() {},
    async requestSpend() { return { status: 'denied' }; }, emit() {}, emitActivity(activity) { activities.push(activity); },
    platformRequest, signal,
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
