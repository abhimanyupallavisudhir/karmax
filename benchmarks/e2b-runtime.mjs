import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Sandbox } from 'e2b';
import { Vault } from '../src/autonomy/vault.ts';
import { CredentialBroker } from '../src/autonomy/broker.ts';
import { E2BWorldProvider } from '../src/world/e2b.ts';
import { WorldRegistry } from '../src/world/registry.ts';
import { WorldCheckpointService } from '../src/world/checkpoint.ts';
import { LocalObjectStore } from '../src/store/objects.ts';
import { Store } from '../src/store/db.ts';
import { ProfileResolver } from '../src/agent/profiles.ts';
import { makeCoreActivities } from '../src/activities/core.ts';
import { CodexAdapter } from '../src/agent/codex.ts';
import { prepareConnections } from '../src/mcp/connections/runtime.ts';
import { TimingTrace, withTiming } from '../src/timing/index.ts';
// Run with: npx tsx benchmarks/e2b-runtime.mjs /absolute/path/result.json
// Required: E2B_API_KEY, KARMAX_E2B_PROBE_TEMPLATE, KARMAX_E2B_PROBE_AUTH_HOME.
// Uses a separate process/store and billable sandbox. Never attach a debugger to
// the production worker. This checks the runtime, not gateway/Temporal dispatch.
const apiKey = process.env.E2B_API_KEY;
const template = process.env.KARMAX_E2B_PROBE_TEMPLATE;
const authHome = process.env.KARMAX_E2B_PROBE_AUTH_HOME;
const output = process.argv[2] && path.resolve(process.argv[2]);
if (!apiKey || !template || !authHome || !output)
    throw new Error('Supply E2B_API_KEY, KARMAX_E2B_PROBE_TEMPLATE, KARMAX_E2B_PROBE_AUTH_HOME and an output path');
const login = { path: authHome };
const projected = JSON.parse(fs.readFileSync(login.path + '/auth.json', 'utf8'));
const expiry = JSON.parse(Buffer.from(projected.tokens.id_token.split('.')[1], 'base64url').toString()).exp;
if (!Number.isFinite(expiry) || !projected.tokens.access_token || expiry * 1000 < Date.now() + 300000)
    throw new Error('Existing access token requires ordinary control-plane refresh before probe');
projected.tokens.refresh_token = 'karmax-host-managed-refresh';
delete projected.refresh_token;
delete projected.refreshToken;
const key = projected.tokens.access_token;
process.env.KARMAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-runtime-probe-'));
const home = process.env.KARMAX_HOME;
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const store = await Store.create(':memory:');
const project = await store.createProject('Isolated E2B candidate check', { worldProvider: 'e2b' });
const task = await store.createTask({ projectId: project.id, title: 'Candidate check', workflow: 'just-do', workflowVersion: '1.7.0', params: { prompt: 'test' } });
const rows = [];
const report = { taskId: task.id, template, scope: 'isolated process; real E2B/native Codex/browser; not gateway dispatch', rows, startedAt: Date.now(), checks: {} };
const save = () => fs.writeFileSync(output, JSON.stringify(report), { mode: 0o600 });
const trace = new TimingTrace({ taskId: task.id }, row => { rows.push(row); save(); });
const provider = new E2BWorldProvider(undefined, 300000, report.template, () => ({ apiKey, config: {}, organizationId: 'org_personal' }));
const worlds = new WorldRegistry();
worlds.register(provider);
let world;
const localHome = home + '/native-home';
fs.mkdirSync(localHome, { recursive: true, mode: 0o700 });
fs.writeFileSync(localHome + '/auth.json', JSON.stringify(projected), { mode: 0o600 });
fs.mkdirSync(localHome + '/skills');
for (let i = 0; i < 64; i++)
    fs.writeFileSync(localHome + '/skills/diagnostic-' + i + '.md', 'Diagnostic fixture only.');
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 180000);
try {
    await withTiming(trace, async () => {
        world = await trace.measure('world.prepare', () => worlds.create('e2b', { taskId: task.id, organizationId: 'org_personal', repos: [], base: 'main', signal: controller.signal }));
        world.handle.meta = { ...world.handle.meta, projectId: project.id };
        world.handle = await store.registerWorld(world.handle, project.id);
        const agentMcp = await trace.measure('tool.connection.prepare', () => prepareConnections(undefined, world, ['browser:chrome-devtools'], project.id, task.id, () => { }));
        let toolEvents = 0;
        const forbidden = () => { throw new Error('Platform side effects are disabled in this fixture'); };
        const ctx = { signal: controller.signal, emit: () => trace.markOnce('first.text'), emitActivity: a => { if (a.kind === 'tool')
                toolEvents++; }, openPr: forbidden, signalCompletion: () => { }, createReviewInfo: forbidden, createSubTask: forbidden, respondToSubTask: forbidden, raiseToParent: forbidden, waitForSubtasks: forbidden, requestSpend: forbidden, saveSkill: forbidden, addCheckout: forbidden, confirmDecision: forbidden, resolveDecision: forbidden };
        const result = await trace.measure('agent.attempt', () => new CodexAdapter().runTurn({ world, role: 'do', resolvedAuth: { configHome: localHome }, agentMcp, profile: { id: 'probe', name: 'probe', provider: 'codex', role: 'do', model: process.env.KARMAX_E2B_PROBE_MODEL || 'gpt-5.5', effort: 'low', mcpConnections: ['browser:chrome-devtools'], maxTurns: 6 }, systemPrompt: 'You are verifying a browser. Use only the provided Chrome DevTools tools. Do not use shell, files, network sites, or platform tools.', messages: [{ id: 'm0', role: 'user', ts: Date.now(), text: 'Open data:text/html,<title>tavya-latency-probe</title><main>READY</main> using the Chrome DevTools browser tools. Verify the page title and contents. After verifying them, reply exactly BROWSER_READY.' }] }, ctx));
        report.checks.browserReply = result.output.trim() === 'BROWSER_READY';
        report.toolEvents = toolEvents;
        if (!report.checks.browserReply)
            throw new Error('Browser completion marker mismatch');
        const title = await world.exec('node', ['-e', "fetch('http://127.0.0.1:9222/json/list').then(r=>r.json()).then(p=>{if(!p.some(x=>x.title==='tavya-latency-probe'))process.exit(1)})"]);
        report.checks.browserTitle = title.code === 0;
        if (title.code !== 0)
            throw new Error('Browser title was not independently verified');
        await world.writeFile('checkpoint-proof.txt', 'durable test bytes');
        const checkpoints = new WorldCheckpointService(store, worlds, new LocalObjectStore(home + '/objects'), new CredentialBroker(new Vault(home + '/vault')));
        const original = checkpoints.checkpoint.bind(checkpoints);
        let saved;
        let inject = true;
        checkpoints.checkpoint = async (h) => { saved = await original(h); if (inject) {
            inject = false;
            await store.appendEvent({ taskId: task.id, type: 'conversation.message', ts: Date.now(), payload: { role: 'do', message: { id: 'followup', role: 'user', text: 'Continue' } } });
        } return saved; };
        const core = makeCoreActivities({ store, worlds, checkpoints, adapters: new Map(), profiles: new ProfileResolver(store, 'mock') });
        const view = { taskId: task.id, title: task.title, workflow: 'just-do', stage: 'review', status: 'waiting', waitingFor: { kind: 'human', audience: ['@creator'] }, messages: [], actions: [], updatedAt: 1, state: {}, world: world.handle };
        await trace.measure('test.review-with-followup', () => core.publishView(task.id, view));
        report.checks.checkpointSaved = !!saved?.id;
        report.checks.followupRetainsReadyWorld = (await worlds.status(world.handle)) === 'ready';
        report.checks.parkingDeferred = (await store.eventsOfType(task.id, 'world.park-deferred')).length === 1;
        if (!report.checks.checkpointSaved || !report.checks.followupRetainsReadyWorld || !report.checks.parkingDeferred)
            throw new Error('Follow-up parking invariant failed');
        await trace.measure('test.review-without-followup', () => core.publishView(task.id, view));
        report.checks.laterWaitParks = (await worlds.status(world.handle)) === 'parked';
        world = await worlds.open(world.handle);
        report.checks.dataSurvives = (await world.readFile('checkpoint-proof.txt')) === 'durable test bytes';
        if (!report.checks.laterWaitParks || !report.checks.dataSurvives)
            throw new Error('Park/resume invariant failed');
    });
    report.status = 'passed';
}
catch (e) {
    report.status = 'failed';
    report.error = String(e?.message || e).split(key).join('[redacted]').split(apiKey).join('[redacted]').slice(0, 1500);
}
finally {
    clearTimeout(deadline);
    try {
        if (world)
            await world.destroy().catch(() => { report.cleanupFailed = true; });
        const remaining = await Sandbox.list({ apiKey, query: { metadata: { karmaxTaskId: task.id } } }).nextItems();
        report.remainingSandboxes = remaining.length;
        if (remaining.length)
            report.cleanupFailed = true;
    }
    catch {
        report.cleanupFailed = true;
    }
    finally {
        report.endedAt = Date.now();
        await store.close();
        fs.rmSync(home, { recursive: true, force: true });
        save();
    }
    console.log(JSON.stringify({ status: report.status, checks: report.checks,
        cleanupFailed: report.cleanupFailed, remainingSandboxes: report.remainingSandboxes, output }));
    if (report.status !== 'passed' || report.cleanupFailed)
        process.exitCode = 1;
}
