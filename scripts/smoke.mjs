#!/usr/bin/env node
// Smoke suite: is a deployed tavya working? Run against staging after every
// deploy there, against production after a promotion, and on a schedule
// against production (.github/workflows/{deploy,production-check}.yml).
//
//   node scripts/smoke.mjs --url https://staging.tavya.io [--revision <sha>] [--task]
//
// Without credentials it checks what anyone can reach: readiness (and that the
// expected commit serves), the console page with every script and stylesheet
// it loads (the console has no build step, so a syntax error in one would only
// show in a browser: each script is parsed here), the public docs and the API.
// With SMOKE_TOKEN (a personal token of a member of the smoke project) and
// SMOKE_PROJECT_ID it also runs a real task end to end: a world on the
// project's computer, one turn of the project's agent (or the agent and
// computer SMOKE_TASK_PARAMS names, as task params JSON), which must answer a sum
// it was not told. The task is then cancelled and archived.
//
// Dependency-free on purpose: CI runs it from a bare checkout.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class SmokeFailure extends Error {}
const fail = (message) => { throw new SmokeFailure(message); };

function parseArgs(argv) {
  const options = { task: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url') options.url = argv[++i];
    else if (arg === '--revision') options.revision = argv[++i];
    else if (arg === '--task') options.task = true;
    else if (arg === '--timeout') options.taskTimeoutMs = Number(argv[++i]) * 1000;
    else fail(`unknown argument ${arg}`);
  }
  if (!options.url) fail('--url is required');
  return options;
}

/** Every `src` and stylesheet `href` the page loads from its own origin. */
export function pageAssets(html) {
  const assets = new Set();
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)) assets.add(match[1]);
  for (const match of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)) {
    const href = match[0].match(/\bhref="([^"]+)"/)?.[1];
    if (href) assets.add(href);
  }
  return [...assets].filter((asset) => asset.startsWith('/') && !asset.startsWith('//'));
}

/** Parse JavaScript without running it: `node --check` on a module file. */
export function checkSyntax(source, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tavya-smoke-'));
  try {
    const file = path.join(dir, `${path.basename(name).replace(/[^\w.-]/g, '_') || 'script'}.mjs`);
    fs.writeFileSync(file, source);
    const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (checked.status !== 0) fail(`${name} does not parse: ${checked.stderr.trim().split('\n').slice(0, 6).join(' ')}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export async function runSmoke(options, env = process.env, log = console.log) {
  const base = options.url.replace(/\/+$/, '');
  const fetchImpl = options.fetch ?? fetch;
  const token = env.SMOKE_TOKEN?.trim();
  const projectId = env.SMOKE_PROJECT_ID?.trim();
  // The task's parameters, e.g. a cheap model without browser tools; else the project's defaults.
  let taskParams;
  if (env.SMOKE_TASK_PARAMS?.trim()) {
    try { taskParams = JSON.parse(env.SMOKE_TASK_PARAMS); } catch { fail('SMOKE_TASK_PARAMS is not JSON'); }
  }
  const results = [];
  const step = async (name, run) => {
    const started = Date.now();
    try {
      const detail = await run();
      results.push({ name, ok: true });
      log(`ok    ${name} (${Date.now() - started} ms)${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
      log(`FAIL  ${name} (${Date.now() - started} ms) — ${error.message}`);
    }
  };
  const request = async (method, route, body, auth = false) => {
    const headers = { accept: 'application/json, text/html;q=0.9, */*;q=0.8', 'user-agent': 'tavya-smoke' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(`${base}${route}`, { method, headers, redirect: 'manual',
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    return { status: response.status, type: response.headers.get('content-type') ?? '', text,
      json: () => { try { return JSON.parse(text); } catch { fail(`${method} ${route} did not answer JSON: ${text.slice(0, 120)}`); } } };
  };
  const expectStatus = (reply, status, what) => {
    if (reply.status !== status) fail(`${what} answered ${reply.status}, not ${status}: ${reply.text.slice(0, 160)}`);
  };

  await step('ready', async () => {
    const reply = await request('GET', '/api/health/ready');
    expectStatus(reply, 200, 'readiness');
    const body = reply.json();
    if (body.ok !== true) fail(`readiness says ${reply.text}`);
    if (options.revision && body.revision !== options.revision.toLowerCase())
      fail(`serving ${body.revision ?? 'an unreported commit'}, not ${options.revision}`);
    return body.revision ? `at ${body.revision.slice(0, 12)}` : undefined;
  });
  await step('console', async () => {
    const page = await request('GET', '/');
    expectStatus(page, 200, 'the console page');
    if (!/text\/html/.test(page.type) || !/<script\b/.test(page.text)) fail('the console page is not the app');
    const assets = pageAssets(page.text);
    if (!assets.length) fail('the console page loads no scripts');
    for (const asset of assets) {
      const reply = await request('GET', asset);
      expectStatus(reply, 200, asset);
      if (/\.m?js(\?|$)/.test(asset)) checkSyntax(reply.text, asset);
    }
    return `${assets.length} assets`;
  });
  await step('public pages', async () => {
    for (const route of ['/docs', '/pricing']) {
      const reply = await request('GET', route);
      expectStatus(reply, 200, route);
      if (!/text\/html/.test(reply.type)) fail(`${route} is not a page`);
    }
  });
  await step('api', async () => {
    const meta = await request('GET', '/api/meta');
    expectStatus(meta, 200, '/api/meta');
    if (typeof meta.json().version !== 'string') fail('/api/meta has no version');
    const session = await request('GET', '/api/session');
    expectStatus(session, 200, '/api/session');
  });

  const wantTask = options.task;
  if (wantTask && (!token || !projectId)) {
    await step('task', async () => fail('a task check needs SMOKE_TOKEN and SMOKE_PROJECT_ID'));
  } else if (wantTask) {
    await step('signed in', async () => {
      const reply = await request('GET', `/api/projects/${encodeURIComponent(projectId)}`, undefined, true);
      expectStatus(reply, 200, 'the smoke project');
    });
    await step('task', async () => {
      const a = 1000 + Math.floor(Math.random() * 8000);
      const b = 1000 + Math.floor(Math.random() * 8000);
      const answer = String(a + b);
      const created = await request('POST', `/api/projects/${encodeURIComponent(projectId)}/tasks`, {
        title: `Smoke check ${new Date().toISOString().slice(0, 16)}Z${options.revision ? ` ${options.revision.slice(0, 8)}` : ''}`,
        prompt: `This is an automated check of tavya. Reply with only the value of ${a} + ${b}, then end your turn. Do not use any tools.`,
        ...(taskParams ? { params: taskParams } : {}),
      }, true);
      expectStatus(created, 200, 'creating the task');
      const taskId = created.json().id;
      if (typeof taskId !== 'string') fail(`creating the task returned ${created.text.slice(0, 160)}`);
      const deadline = Date.now() + (options.taskTimeoutMs ?? 15 * 60_000);
      let last = '';
      try {
        for (;;) {
          const conversation = await request('GET', `/api/tasks/${taskId}/conversation?role=do`, undefined, true);
          if (conversation.status === 200) {
            const messages = conversation.json().messages ?? [];
            if (messages.some((message) => message?.role === 'agent' && String(message?.text ?? '').includes(answer)))
              return `task ${taskId} answered`;
          }
          const view = await request('GET', `/api/tasks/${taskId}`, undefined, true);
          if (view.status === 200) {
            const task = view.json();
            last = `stage ${task.stage}, status ${task.status}${task.waitingFor?.summary ? `, ${task.waitingFor.summary}` : ''}`;
            if (['failed', 'cancelled'].includes(task.status)) fail(`task ${taskId} ${task.status}: ${task.error ?? last}`);
          }
          if (Date.now() > deadline) fail(`task ${taskId} did not answer ${a} + ${b} in time (${last})`);
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      } finally {
        await request('POST', `/api/tasks/${taskId}/signal`, { signal: 'cancel' }, true).catch(() => undefined);
        await request('POST', `/api/tasks/${taskId}/archive`, { archived: true }, true).catch(() => undefined);
      }
    });
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const options = parseArgs(process.argv.slice(2));
    console.log(`Smoke check of ${options.url}${options.revision ? ` at ${options.revision}` : ''}`);
    const results = await runSmoke(options);
    const failed = results.filter((result) => !result.ok);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Smoke check of ${options.url}\n\n`
        + results.map((result) => `- ${result.ok ? '✅' : '❌'} ${result.name}${result.error ? `: ${result.error}` : ''}`).join('\n') + '\n');
    }
    process.exit(failed.length ? 1 : 0);
  } catch (error) {
    console.error(error instanceof SmokeFailure ? error.message : error);
    process.exit(2);
  }
}
