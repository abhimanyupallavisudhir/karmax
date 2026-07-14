import { describe, it, expect } from 'vitest';
import { allRoles, roleDef, manifest, agentMcpToConfig, WorkflowManifest } from '../src/contrib/manifests.js';
import { applyAgentSpec, defaultModel, makeDefaultProfiles } from '../src/agent/profiles.js';
import { assemblePrompt } from '../src/agent/prompt.js';
import { GLOBAL_INSTRUCTIONS } from '../src/agent/instructions.js';
import { autoResolve } from '../src/resolve/cases.js';

const world = { id: 'w', root: '/tmp/w', branch: 'karmax/t', base: 'main', target: 'main' } as any;
const task = { taskId: 't', projectId: 'p', title: 'Add factorial', prompt: 'implement it' } as any;
const profile = (over: any = {}) => ({ id: 'do', name: 'Do', provider: 'claude', role: 'do', capabilities: [], ...over } as any);

describe('workflow-owned agent roles (SPEC §7.1 / PLAN-dynamic-repos §2b)', () => {
  it('aggregates declared roles across the bundled workflows, tracking who uses each', () => {
    const roles = Object.fromEntries(allRoles().map((r) => [r.name, r]));
    expect(Object.keys(roles).sort()).toEqual(['confirm', 'do', 'merge']);
    expect(roles.do!.workflows).toEqual(expect.arrayContaining(['software-dev', 'just-do', 'goal']));
    expect(roles.merge!.workflows).toEqual(expect.arrayContaining(['software-dev', 'merge-only', 'goal']));
    // every workflow with a Review gate declares the confirm role (agent confirm layers)
    expect(roles.confirm!.workflows).toEqual(expect.arrayContaining(['software-dev', 'just-do', 'goal', 'merge-only']));
    expect(roles.confirm!.capabilities).toContain('confirm-decision');
  });

  it('exposes each role its declared prompt template + capability ceiling', () => {
    expect(roleDef('do')!.promptTemplate).toContain('# Task');
    expect(roleDef('merge')!.promptTemplate).toContain('You are merging');
    expect(roleDef('merge')!.capabilities).toContain('merge-into:*');
    expect(roleDef('nonexistent')).toBeUndefined();
  });

  it('registers a NOVEL role a workflow declares (dedupe + source tracking)', () => {
    const custom: WorkflowManifest[] = [
      {
        name: 'research', version: '1.0.0', description: '', requires: [], events: [], capabilities: [], ui: [], commands: [], params: [],
        roles: [{ name: 'reviewer', label: 'Reviewer', promptTemplate: 'Review {{title}}: {{prompt}}', capabilities: ['create-review-info'] }],
      },
    ];
    const r = roleDef('reviewer', custom)!;
    expect(r).toBeTruthy();
    expect(r.label).toBe('Reviewer');
    expect(r.workflows).toEqual(['research']);
    expect(r.promptTemplate).toContain('Review');
  });

  it('seeds one default profile per declared role, carrying the role capabilities', () => {
    const profiles = makeDefaultProfiles('claude');
    expect(profiles.map((p) => p.id).sort()).toEqual(['confirm-default', 'do-default', 'merge-default']);
    const merge = profiles.find((p) => p.id === 'merge-default')!;
    expect(merge.role).toBe('merge');
    expect(merge.capabilities).toContain('merge-into:*');
    expect(merge.model).toBeTruthy(); // provider/model resolved at seed time
  });

  it('resets provider-scoped model and credentials on a per-task provider switch', () => {
    const switched = applyAgentSpec(
      profile({
        provider: 'claude',
        model: 'claude-opus-4-8',
        effort: 'high',
        auth: { kind: 'configHome', configHome: '/claude' },
        allowedAccounts: ['login:claude:work'],
      }),
      { provider: 'codex' },
    );
    expect(switched.provider).toBe('codex');
    expect(switched.model).toBe(defaultModel('codex'));
    expect(switched.effort).toBeUndefined();
    expect(switched.auth).toBeUndefined();
    expect(switched.allowedAccounts).toBeUndefined();

    expect(applyAgentSpec(profile({ model: 'claude-opus-4-8' }), { provider: 'codex', model: 'gpt-5.6-sol' }).model).toBe('gpt-5.6-sol');
  });
});

describe('prompt assembly derives from the declared role (not a hardcoded map)', () => {
  it('uses the role-declared template for the role', () => {
    const out = assemblePrompt({ profile: profile({ role: 'merge' }), role: 'merge', task, world });
    expect(out).toContain('You are merging'); // merge template, not the do template
    expect(out).toContain('Add factorial'); // {{title}} bound
  });

  it('a profile promptTemplate overrides the role template', () => {
    const out = assemblePrompt({ profile: profile({ promptTemplate: 'CUSTOM {{title}}' }), role: 'do', task, world });
    expect(out).toBe('CUSTOM Add factorial');
  });

  it('an undeclared role falls back to the do template rather than breaking', () => {
    const out = assemblePrompt({ profile: profile({ role: 'reviewer' }), role: 'reviewer', task, world });
    expect(out).toContain('# Task'); // do template floor
  });
});

describe('workflow-owned lifecycle stages (SPEC §5 — the pipeline the UI renders)', () => {
  const keys = (wf: string) => (manifest(wf)!.stages ?? []).map((s) => s.key);
  it('software-dev declares the full merge lifecycle with a point of no return', () => {
    expect(keys('software-dev')).toEqual(['setup', 'do', 'review', 'pr', 'merge', 'done']);
    expect(manifest('software-dev')!.stages!.find((s) => s.key === 'merge')!.ponr).toBe(true);
    expect(manifest('software-dev')!.stages!.some((s) => s.key === 'resolve' || s.aliases?.includes('resolve'))).toBe(false);
    expect(manifest('software-dev')!.params.some((f) => f.role === 'resolve')).toBe(false);
  });
  it('just-do has no merge machinery; script-exec runs (no Do agent label); merge-only has no Do', () => {
    expect(keys('just-do')).toEqual(['setup', 'do', 'review', 'done']); // no pr/merge
    expect(manifest('script-exec')!.stages!.find((s) => s.key === 'do')!.label).toBe('Run');
    expect(keys('merge-only')).toEqual(['setup', 'review', 'merge', 'done']); // no do
  });
});

describe('workflow-owned agent MCP servers (SPEC §7.5)', () => {
  it('maps declared servers to the Agent SDK mcpServers shape', () => {
    const cfg = agentMcpToConfig([
      { name: 'chrome', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], env: { K: 'v' } },
      { name: 'bare', command: 'node' },
    ]);
    expect(cfg.chrome).toEqual({ command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], env: { K: 'v' } });
    expect(cfg.bare).toEqual({ command: 'node', args: [] });
    expect(agentMcpToConfig(undefined)).toEqual({});
  });
  it('a workflow can declare agent MCP servers in its manifest', () => {
    const custom: WorkflowManifest = {
      name: 'browsing', version: '1.0.0', description: '', requires: [], events: [], capabilities: [], ui: [], commands: [], params: [],
      agentMcp: [{ name: 'chrome-devtools', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] }],
    };
    expect(agentMcpToConfig(custom.agentMcp)['chrome-devtools']!.command).toBe('npx');
    // bundled workflows declare none → agents get only the platform baseline
    expect(manifest('software-dev')!.agentMcp).toBeUndefined();
  });
});

describe('workflow-declared resolve rules (SPEC §5.2)', () => {
  it('a declared rule matches the error and wins over the platform defaults', () => {
    const r = autoResolve('do', 'FooWidget exploded during build', [{ name: 'widget', match: 'FooWidget exploded', action: 'retry', note: 'retrying widget' }]);
    expect(r).toEqual({ resolved: true, action: 'retry', note: 'retrying widget' });
  });
  it('falls through to the platform defaults, then to unresolved', () => {
    expect(autoResolve('do', 'HTTP 429 rate limit').resolved).toBe(true); // platform rate-limit case
    expect(autoResolve('do', 'Codex usage limit reached · resets in 1800s').resolved).toBe(true);
    expect(autoResolve('do', "You've hit your session limit · resets 3:45pm").resolved).toBe(true);
    expect(autoResolve('do', "You've hit your weekly limit · resets Mon 12:00am").resolved).toBe(true);
    expect(autoResolve('do', 'OpenAI insufficient_quota: check billing').resolved).toBe(true);
    expect(
      autoResolve(
        'do',
        "Activity task failed → Claude Code returned an error result: You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
      ).resolved,
    ).toBe(true); // task #151: hard credit exhaustion must not spawn Resolve
    expect(autoResolve('do', 'a totally novel error').resolved).toBe(false);
  });
  it('a bad regex in a declared rule never wedges resolve', () => {
    expect(() => autoResolve('do', 'x', [{ name: 'bad', match: '(' }])).not.toThrow();
    expect(autoResolve('do', 'x', [{ name: 'bad', match: '(' }]).resolved).toBe(false);
  });
});

describe('prompt preamble (SPEC §5.4)', () => {
  it('uses the platform preamble when the workflow declares no override', () => {
    const out = assemblePrompt({ profile: profile(), role: 'do', task: { ...task, workflow: 'software-dev' } as any, world });
    expect(out).toContain('running inside karmax'); // platform TOOLS_PREAMBLE
    expect(out).toMatch(/create_review_info.*optional/i);
    expect(out).toContain('limited to 280 characters');
    expect(out).toContain('Source code is not a human-readable output');
    expect(manifest('software-dev')!.promptPreamble).toBeUndefined();
  });

  it('repeats the optional, verification-only review guidance in global instructions', () => {
    expect(GLOBAL_INSTRUCTIONS).toMatch(/Review info is optional/i);
    expect(GLOBAL_INSTRUCTIONS).toContain('at most 280 characters');
    expect(GLOBAL_INSTRUCTIONS).toContain('Source code is not a human-readable output');
    expect(GLOBAL_INSTRUCTIONS).toMatch(/summaries of changes\/answers in your final response/i);
  });
});
