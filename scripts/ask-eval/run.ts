/**
 * Ask evaluation (README.md): which models can be tavya's Ask agent — a task
 * with Computer: None whose agent has only tavya's platform tools.
 *
 *   OPENROUTER_KEY=… npx tsx scripts/ask-eval/run.ts \
 *     --models deepseek/deepseek-v4.1-flash-1017:max,z-ai/glm-5.3:high --runs 2 \
 *     [--scenarios wiki-summary,cancel] [--concurrency 4] [--budget 15] [--out results/<date>.jsonl]
 *
 * Real Temporal, worker, activities, store and gateway (tests/helpers/harness.ts);
 * the Ask is created as the console's Ask box creates it (POST
 * /api/projects/:id/tasks, ownAuthority, Computer None) by the organization's
 * owner; the agent is `opencode` on `openrouter/<model>` at its effort, on the
 * included-model rail of a hosted installation (its per-organization key and
 * INCLUDED_MODEL_OPTIONS routing: zero data retention, no 4-bit builds). Only
 * OpenRouter's management API is answered by the proxy (openrouter-proxy.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.KARMAX_AGENT_PROVIDER = 'mock'; // the seeded tasks' agents; the Ask's is OpenCode
process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
process.env.KARMAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-ask-eval-'));

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const models = (arg('models') ?? '').split(',').filter(Boolean).map((spec) => {
  const [id, effort] = spec.split(':');
  return { id: id!, effort: effort || undefined, spec };
});
const runs = Number(arg('runs', '2'));
const concurrency = Number(arg('concurrency', '4'));
const budget = Number(arg('budget', '15'));
const only = arg('scenarios')?.split(',');
const out = path.resolve(arg('out', path.join(here, 'results', `${new Date().toISOString().slice(0, 10)}.jsonl`))!);
const TURN_TIMEOUT_MS = Number(arg('turn-timeout', '600')) * 1000;
const realKey = process.env.OPENROUTER_KEY ?? process.env.OPENROUTER_API_KEY;
if (!realKey) throw new Error('OPENROUTER_KEY is not set');
if (!models.length) throw new Error('--models is required');

const { OpenRouterProxy } = await import('./openrouter-proxy.js');
const proxy = new OpenRouterProxy(realKey, budget);
process.env.KARMAX_OPENROUTER_API_URL = await proxy.start();

const { bootHarness } = await import('../../tests/helpers/harness.js');
const { INCLUDED_MODEL_MANAGEMENT_HANDLE } = await import('../../src/agent/included-model.js');
const { INSTALLATION_SCOPE } = await import('../../src/autonomy/vault-keys.js');
const { SCENARIOS, seedOrganization } = await import('./scenarios.js');
type Seeded = import('./scenarios.js').Seeded;
type Scenario = import('./scenarios.js').Scenario;

const h = await bootHarness('mock', undefined, { apiAuthorization: true });
const gateway = await h.startGateway();
process.env.KARMAX_GATEWAY_URL = gateway.internalUrl;
// Every organization is seeded first, on a self-hosted store (the sub-task's
// parent needs the worktree world, which hosted refuses); then the
// installation is hosted, with the included model on (wiki features/included-model).
const jobs = models.flatMap((model) => Array.from({ length: runs }, (_, run) => ({ model, run, seed: undefined as Seeded | undefined })));
for (let i = 0; i < jobs.length; i += 4) {
  await Promise.all(jobs.slice(i, i + 4).map(async (job) => {
    try { job.seed = await seedOrganization(h, `${job.model.id} ${job.run}`); }
    catch (error) { console.error(`[ask-eval] seed failed for ${job.model.spec}: ${error}`); }
  }));
}
console.log(`[ask-eval] seeded ${jobs.filter((j) => j.seed).length} organizations`);
(h.store as { hosted: boolean }).hosted = true;
await h.store.kvSet('included-model:config', JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash-1017', effort: 'max', enabled: true }));
await h.broker.registerHandle(INCLUDED_MODEL_MANAGEMENT_HANDLE, 'sk-eval-management', INSTALLATION_SCOPE);

// `--variant identity` (an experiment, not what production runs): the Ask's
// system prompt also says which task, project and organization it is — the
// computerless World section names none of them, unlike a computer's.
const variant = arg('variant');
if (variant === 'identity') {
  const { AcpAdapter } = await import('../../src/agent/acp.js');
  const original = AcpAdapter.prototype.runComputerlessTurn;
  AcpAdapter.prototype.runComputerlessTurn = async function (input, ctx) {
    const task = await h.store.getTask(input.world.handle.id);
    const project = task ? await h.store.getProject(task.projectId) : undefined;
    const identity = task ? `\n\nThis task is ${task.id} (#${task.num} "${task.title}") in project "${project?.name}" (${task.projectId}) of organization ${project?.organizationId}.` : '';
    return original.call(this, { ...input, systemPrompt: `${input.systemPrompt}${identity}` }, ctx);
  };
} else if (variant) throw new Error(`unknown --variant ${variant}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const scenarios = SCENARIOS.filter((s) => !only || only.includes(s.id));
const view = (id: string) => h.client.workflow.getHandle(id).query<any>('view').catch(() => undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = async (method: string, route: string, token: string, body?: unknown) => {
  const response = await fetch(`${gateway.url}${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

/** Wait until the agent's turn is over: it stopped working and the task is in
 * Review or waits on something other than a model slot. */
async function turnOver(taskId: string, since: number, rounds: () => number): Promise<{ view: any; at: number; timedOut: boolean }> {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let calm = 0;
  for (;;) {
    const v = await view(taskId);
    const idle = v && !v.agentTurn && rounds() > since
      && (v.stage === 'review' || ['done', 'failed', 'cancelled'].includes(v.status)
        || (v.waitingFor && !['agentSlot', 'account', 'retry'].includes(v.waitingFor.kind)));
    calm = idle ? calm + 1 : 0;
    if (calm >= 2) return { view: v, at: Date.now() - 500, timedOut: false };
    if (Date.now() > deadline || proxy.overBudget()) return { view: v, at: Date.now(), timedOut: true };
    await sleep(500);
  }
}

/** A tool call's arguments with long strings (prompts) cut, so every field shows. */
function brief(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), (_key, value) => typeof value === 'string' && value.length > 120 ? `${value.slice(0, 120)}…` : value).slice(0, 900);
  } catch { return json.slice(0, 300); }
}

async function trial(model: typeof models[number], run: number, seed: Seeded, scenario: Scenario) {
  const turns = scenario.turns(seed);
  const t = proxy.open(seed.organizationId, turns[0]!);
  const startedAt = Date.now();
  const created = await call('POST', `/api/projects/${seed.projects.assistant}/tasks`, seed.ownerToken, {
    workflow: 'software-dev', ownAuthority: true,
    params: { prompt: turns[0], computer: { provider: 'none' }, 'agent:do': { provider: 'opencode', model: `openrouter/${model.id}`, ...(model.effort ? { effort: model.effort } : {}) } },
  });
  const askId = created.id as string;
  const replies: string[] = [];
  const turnTimes: Array<{ firstTokenMs?: number; firstTextMs?: number; endMs: number; timedOut: boolean }> = [];
  let last: any;
  for (let i = 0; i < turns.length; i++) {
    const turnStart = i === 0 ? startedAt : Date.now();
    const before = t.rounds.length;
    if (i > 0) await call('POST', `/api/tasks/${askId}/signal`, seed.ownerToken, { signal: 'followUp', role: 'do', text: turns[i] });
    const done = await turnOver(askId, before, () => t.rounds.length);
    last = done.view;
    const mine = t.rounds.slice(before);
    const first = mine[0];
    const firstText = mine.find((r) => r.firstTextMs !== undefined);
    turnTimes.push({ firstTokenMs: first?.firstTokenMs !== undefined ? first.at + first.firstTokenMs - turnStart : undefined,
      firstTextMs: firstText ? firstText.at + firstText.firstTextMs! - turnStart : undefined, endMs: done.at - turnStart, timedOut: done.timedOut });
    replies.push((done.view?.messages ?? []).filter((m: any) => m.role === 'agent' && (m.ts ?? 0) >= turnStart).map((m: any) => String(m.text)).join('\n'));
    if (done.timedOut) break;
  }
  await sleep(1500); // let the last tool's effects land (a signal, a trigger)
  let grade;
  const asks = t.rounds.flatMap((r) => r.toolCalls).filter((c) => ['escalate_to_human', 'pause', 'notify', 'escalate'].includes(c.name))
    .map((c) => { try { return String(JSON.parse(c.arguments).message ?? ''); } catch { return ''; } });
  try { grade = await scenario.grade({ h, seed, askId, startedAt, replies, asks }); }
  catch (error) { grade = { pass: false, note: `grader error: ${error instanceof Error ? error.message : String(error)}` }; }
  // What the Ask created, and whether it waits for someone to grant what the Ask holds back.
  const createdTasks = (await Promise.all(Object.values(seed.projects).map((id) => h.store.listTasks(id)))).flat()
    .filter((task) => task.createdAt >= startedAt && task.id !== askId && !Object.values(seed.tasks).some((s) => s.id === task.id))
    .map((task) => ({ title: task.title, draft: !!(task.params as any).draft, computer: (task.params as any).computer,
      authorization: (task.params as any)._authorization?.profileId ?? (task.params as any)._authorization?.level,
      attenuated: !!((task.params as any)._authorization?.attenuated || (task.params as any)._authorization?.profileAttenuated) }));
  proxy.close(seed.organizationId);
  // Stop the Ask so a follow-up trigger or a pause cannot wake it during the next question.
  await h.client.workflow.getHandle(askId).cancel().catch(() => undefined);
  const rounds = t.rounds;
  const toolCalls = rounds.flatMap((r) => r.toolCalls);
  const results = rounds.flatMap((r) => r.toolResults);
  const record = {
    model: variant ? `${model.spec}+${variant}` : model.spec, run, scenario: scenario.id, pass: grade.pass, note: grade.note, askId,
    endedWithoutDoing: !grade.pass && !toolCalls.some((c) => !['describe_platform', 'my_authorization', 'list_tasks', 'search_tasks', 'find_task', 'get_task', 'read_wiki', 'search_wiki', 'list_events', 'get_conversation', 'list_agents', 'signal_completion'].includes(c.name)),
    timedOut: turnTimes.some((x) => x.timedOut), stage: last?.stage, status: last?.status, waitingFor: last?.waitingFor?.kind, error: last?.error,
    turns: turnTimes, rounds: rounds.length, refusedChildRequests: t.refused,
    createdTasks,
    tools: toolCalls.map((c) => c.name),
    calls: toolCalls.map((c) => `${c.name} ${brief(c.arguments)}`),
    toolErrors: results.filter((r) => r.error).map((r) => ({ name: r.name, text: r.text.slice(0, 200) })),
    unknownTools: results.filter((r) => /unknown tool/.test(r.text)).length,
    badJson: results.filter((r) => /invalid JSON arguments/.test(r.text)).length,
    providerErrors: rounds.filter((r) => r.status !== 200 || r.error).map((r) => `${r.status} ${r.error ?? ''}`.slice(0, 200)),
    costUsd: rounds.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    costMissing: rounds.filter((r) => r.status === 200 && r.costUsd === undefined).length,
    promptTokens: rounds.reduce((sum, r) => sum + (r.promptTokens ?? 0), 0),
    cachedTokens: rounds.reduce((sum, r) => sum + (r.cachedTokens ?? 0), 0),
    completionTokens: rounds.reduce((sum, r) => sum + (r.completionTokens ?? 0), 0),
    reasoningTokens: rounds.reduce((sum, r) => sum + (r.reasoningTokens ?? 0), 0),
    providers: [...new Set(rounds.map((r) => r.provider).filter(Boolean))],
    firstPromptChars: t.requestBodies[0], systemPromptChars: t.systemPrompt?.length,
    replies: replies.map((r) => r.slice(0, 1500)),
    at: new Date(startedAt).toISOString(),
  };
  fs.appendFileSync(out, `${JSON.stringify(record)}\n`);
  const promptFile = path.join(path.dirname(out), 'system-prompt.txt');
  if (t.systemPrompt && !fs.existsSync(promptFile)) fs.writeFileSync(promptFile, t.systemPrompt);
  console.log(`[ask-eval] ${model.spec} r${run} ${scenario.id}: ${grade.pass ? 'PASS' : 'FAIL'} ${grade.pass ? '' : grade.note} `
    + `$${record.costUsd.toFixed(4)} ${(turnTimes.at(-1)?.endMs ?? 0) / 1000}s · spent $${proxy.spentUsd.toFixed(3)}`);
}

let next = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
  while (next < jobs.length && !proxy.overBudget()) {
    const job = jobs[next++]!;
    const seed = job.seed;
    if (!seed) continue;
    for (const scenario of scenarios) {
      if (proxy.overBudget()) break;
      try { await trial(job.model, job.run, seed, scenario); }
      catch (error) { console.error(`[ask-eval] ${job.model.spec} ${scenario.id}: ${error instanceof Error ? error.stack : error}`); }
    }
  }
}));
console.log(`[ask-eval] done: spent $${proxy.spentUsd.toFixed(3)}${proxy.overBudget() ? ' (budget reached: stopped)' : ''}; refused ${proxy.refusedOutside} model requests of tasks other than the Ask`);
await gateway.close();
await h.stop();
await proxy.stop();
process.exit(0);
