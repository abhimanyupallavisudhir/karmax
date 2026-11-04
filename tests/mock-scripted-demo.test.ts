import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockAdapter } from '../src/agent/mock.js';
import type { AgentActivity, Message } from '../src/domain/types.js';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';

/**
 * Scripted demos (design/launch-video): with KARMAX_MOCK_SCRIPT, a recorded demo
 * types natural prompts and the mock agent acts out a script for each, replying
 * in prose (`@say`), showing work (`@step`) and calling real platform tools (`@tool`).
 */
describe('mock agent: scripted demos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-script-'));
  const script = path.join(dir, 'script.json');
  afterEach(() => { delete process.env.KARMAX_MOCK_SCRIPT; });

  const run = async (text: string, opts: { role?: TurnInput['role']; systemPrompt?: string; requests?: Array<[string, string, unknown]> } = {}) => {
    const activities: AgentActivity[] = [];
    let completion: string | undefined, confirmed: unknown, opened = false;
    const ctx: Partial<PlatformToolContext> = {
      emit() {},
      emitActivity(a) { activities.push(a); },
      signalCompletion(summary) { completion = summary; },
      openPr() { opened = true; },
      confirmDecision(d) { confirmed = d; },
      async platformRequest(method, p, body) { opts.requests?.push([method, p, body]); return { ok: true, id: 'task_new' }; },
    };
    const world = { handle: { id: 'task_self' }, async writeFile() {}, async exec() { return { code: 0, stdout: '', stderr: '' }; } } as any;
    const messages: Message[] = [{ id: 'm0', role: 'user', text, ts: 0 }];
    const turn = await new MockAdapter().runTurn(
      { profile: {} as any, world, messages, systemPrompt: opts.systemPrompt ?? '', role: opts.role ?? 'do' } as TurnInput,
      ctx as PlatformToolContext);
    return { turn, activities, completion, confirmed, opened };
  };

  it('acts out the entry whose pattern matches the natural prompt, replying in prose', async () => {
    fs.writeFileSync(script, JSON.stringify([
      { match: '^Buy the domain', directives: '@step search Checking registrars :: one.com $14.70\n@step edit Write deploy.yml\n@summary Bought it.\n@say **Live.**\\n\\n- Bought it' },
      { match: '^Something else', directives: '@say wrong entry' },
    ]));
    process.env.KARMAX_MOCK_SCRIPT = script;
    const { turn, activities, completion, opened } = await run('Buy the domain tavya.io');
    expect(turn.output).toBe('**Live.**\n\n- Bought it');
    expect(activities.filter((a) => a.kind !== 'message').map((a) => [a.kind, a.title, a.detail])).toEqual([
      ['search', 'Checking registrars', 'one.com $14.70'], ['file', 'Write deploy.yml', undefined]]);
    expect(completion).toBe('Bought it.');
    expect(opened).toBe(true);
  });

  it('calls platform tools, naming the task itself where asked', async () => {
    const requests: Array<[string, string, unknown]> = [];
    fs.writeFileSync(script, JSON.stringify([{ match: '^Follow up', directives:
      '@tool create_task {"project_id": "p1", "title": "After me", "params": {"triggers": [{"kind": "dependency", "tasks": ["__SELF_TASK__"]}]}}\n@say Done.' }]));
    process.env.KARMAX_MOCK_SCRIPT = script;
    const { activities } = await run('Follow up later', { requests });
    expect(requests).toHaveLength(1);
    expect(requests[0]![0]).toBe('POST');
    expect(requests[0]![1]).toBe('/api/projects/p1/tasks');
    expect((requests[0]![2] as any).params.triggers[0].tasks).toEqual(['task_self']);
    expect(activities.find((a) => a.title === 'tavya · create_task' && a.phase === 'completed')).toBeTruthy();
  });

  it('runs a role entry only for that role, matched against its instructions', async () => {
    fs.writeFileSync(script, JSON.stringify([
      { match: 'sitemap', role: 'confirm', directives: '@confirm confirm :: Checked the sitemap.' },
      { match: 'sitemap', directives: '@say the Do agent should not see this' },
    ]));
    process.env.KARMAX_MOCK_SCRIPT = script;
    const review = await run('Please review', { role: 'confirm', systemPrompt: 'Instructions for you:\nCheck the sitemap is valid.' });
    expect(review.confirmed).toEqual({ action: 'confirm', text: 'Checked the sitemap.' });
    expect(review.turn.output).not.toContain('Do agent');
  });

  it('without a script, keeps the plain directive behaviour', async () => {
    const { turn } = await run('no directives here');
    expect(turn.output).toBe('(mock agent: no directives; nothing to do)');
  });
});
