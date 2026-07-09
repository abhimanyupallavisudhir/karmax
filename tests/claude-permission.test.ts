import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { capturedToken } from '../src/autonomy/config-homes.js';
import { paths } from '../src/config/paths.js';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';
import type { AgentProfile, Message } from '../src/domain/types.js';

/**
 * Real-Claude smoke test for the permission seam that broke in production.
 *
 * `claude.ts` runAgentSdk drives the actual Claude Code harness. A headless
 * agent has no human to approve command execution, and its world is already an
 * isolated git worktree (the sandbox boundary) — so the adapter must run with
 * `permissionMode: 'bypassPermissions'`. It once shipped as `acceptEdits`, which
 * auto-approves file edits but GATES Bash, so the agent couldn't run any tooling
 * (uv/python/tests) and got stuck asking for approval that never comes.
 *
 * The whole hermetic suite runs against the mock adapter, which executes shell
 * directly and never touches this permission layer — so this seam had zero
 * coverage. This test closes that gap. It proves execution works by having the
 * agent make a **git commit**: a commit is impossible without running a command
 * (the Write/Edit tools can't produce one), so if the adapter regresses to
 * `acceptEdits` the harness gates Bash, no commit lands, and this fails.
 *
 * Gated on an ambient Claude Code login (the SDK path) + KARMAX_SKIP_LIVE!=1.
 * Costs real tokens, so it is skipped in the hermetic suite. Run with:
 *   npx vitest run tests/claude-permission.test.ts
 */
const LIVE = ClaudeAdapter.hasAmbientLogin() && process.env.KARMAX_SKIP_LIVE !== '1';

describe.skipIf(!LIVE)('claude agent executes commands headless (permission seam)', () => {
  it('runs a shell command — proven by a git commit only Bash can make', async () => {
    // Force the Agent SDK path (the one carrying permissionMode): with no API key
    // and an ambient login, runTurn dispatches to runAgentSdk rather than the
    // Messages API (which has no permission gating and wouldn't cover the bug).
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-perm-worlds-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-perm-repo-'));
    let world: Awaited<ReturnType<WorktreeProvider['create']>> | undefined;
    try {
      // A minimal source repo for the worktree to branch off.
      await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
      await ensureIdentity(repo);
      fs.writeFileSync(path.join(repo, 'README.md'), '# perm\n');
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'init']);

      const taskId = newId('task');
      world = await new WorktreeProvider(home).create({ taskId, repo, base: 'main' });

      const marker = `karmax-perm-${taskId.slice(-8)}`;
      const profile: AgentProfile = {
        id: 'do-perm',
        name: 'do',
        provider: 'claude',
        role: 'do',
        capabilities: [],
      };
      const messages: Message[] = [
        {
          id: 'm1',
          role: 'user',
          ts: 0,
          text:
            `Using the Bash tool, run exactly this shell command in the working directory and nothing else:\n` +
            `  git commit --allow-empty -m "${marker}"\n` +
            `Then call signal_completion. Do not create or edit any files.`,
        },
      ];

      const ctx: PlatformToolContext = {
        signalCompletion: () => {},
        createReviewInfo: () => {},
        createSubTask: () => {},
        respondToSubTask: () => {},
        raiseToParent: () => {},
        waitForSubtasks: () => {},
        saveSkill: () => {},
        resolveDecision: () => {},
        confirmDecision: () => {},
        requestSpend: async () => ({ status: 'denied' }),
        emit: () => {},
      };

      const input: TurnInput = {
        profile,
        world,
        messages,
        role: 'do',
        systemPrompt: 'You are a headless coding agent. Follow the instruction exactly.',
      };

      await new ClaudeAdapter().runTurn(input, ctx);

      const log = await gitOrThrow(world.handle.root, ['log', '--format=%s']);
      expect(log.split('\n')).toContain(marker);
    } finally {
      if (world) await world.destroy().catch(() => {});
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  }, 180_000);
});

/**
 * The variant the test above CANNOT catch — the managed-policy permission
 * downgrade that actually shipped (task_mr455474422ee62b8d).
 *
 * Root cause: an account/org can push a managed policy into the config home,
 * `remote-settings.json`:
 *   { "permissions": { "disableBypassPermissionsMode": "disable" } }
 * which REFUSES `bypassPermissions` and silently downgrades the session to
 * `default`. Managed settings override CLI flags, so neither `bypassPermissions`
 * nor `allowDangerouslySkipPermissions` can force it. With no other approver, every
 * Write comes back "Claude requested permissions to write … but you haven't granted
 * it yet" and the agent reports it has no permission to make edits. (This policy is
 * live on real logins here — including the ambient `~/.claude` — so it is NOT an
 * edge case.) The fix is a `canUseTool` callback: the SDK's programmatic approver,
 * which handles the `default`-mode prompts and is not gated by the policy.
 *
 * The ambient-login test above can't catch this: `git commit` runs via Bash whose
 * approval path differs, and that test never seeds the policy. This test reproduces
 * the exact production condition — a fresh config home carrying the disable policy,
 * authenticated by a captured setup-token — and asserts a Write actually lands.
 * Without the canUseTool approver the write is denied and the file never appears.
 *
 * Gated on a captured setup-token being available (env or any karmax claude
 * config home) + KARMAX_SKIP_LIVE!=1. Run with:
 *   npx vitest run tests/claude-permission.test.ts -t "FRESH config home"
 */
function freshLoginToken(): string | undefined {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const root = paths().configHomes;
  if (!fs.existsSync(root)) return undefined;
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('claude-')) continue;
    const tok = capturedToken(path.join(root, name));
    if (tok) return tok;
  }
  return undefined;
}
const FRESH_TOKEN = freshLoginToken();
const FRESH_LIVE = !!FRESH_TOKEN && process.env.KARMAX_SKIP_LIVE !== '1';

describe.skipIf(!FRESH_LIVE)('claude agent writes files in a FRESH config home (bypass-downgrade seam)', () => {
  it('writes a file that lands in the world — fails if the policy downgrade has no canUseTool approver', async () => {
    // No API key + ambient login present ⇒ runTurn dispatches to runAgentSdk;
    // resolvedAuth then redirects it to a fresh config home + the captured token.
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    // A FRESH config home carrying the exact managed policy that broke production:
    // `disableBypassPermissionsMode` forces the session to `default`, so the fix
    // must survive WITHOUT relying on bypass. This is the condition the ambient
    // test can't create on demand.
    const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-perm-cfg-'));
    fs.writeFileSync(
      path.join(configHome, 'remote-settings.json'),
      JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }),
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-perm-worlds-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-perm-repo-'));
    let world: Awaited<ReturnType<WorktreeProvider['create']>> | undefined;
    try {
      await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
      await ensureIdentity(repo);
      fs.writeFileSync(path.join(repo, 'README.md'), '# perm\n');
      await git(repo, ['add', '-A']);
      await git(repo, ['commit', '-q', '-m', 'init']);

      const taskId = newId('task');
      world = await new WorktreeProvider(home).create({ taskId, repo, base: 'main' });

      const marker = `karmax-fresh-${taskId.slice(-8)}`;
      // Give the agent the ABSOLUTE target path. Real tasks learn their working
      // directory from the system prompt (prompt.ts injects "Working directory:
      // <world.root>"); this test uses a minimal prompt, and without an explicit
      // path the agent guesses (/repo, /workspace, …) — which flakes on cwd, not
      // permissions. An absolute path isolates the one thing under test: whether a
      // Write is permitted (bypass honored) or denied (bypass downgraded).
      const probePath = path.join(world.handle.root, 'PERM_PROBE.txt');
      const profile: AgentProfile = {
        id: 'do-fresh',
        name: 'do',
        provider: 'claude',
        role: 'do',
        capabilities: [],
      };
      const messages: Message[] = [
        {
          id: 'm1',
          role: 'user',
          ts: 0,
          text:
            `Using the Write tool, create a file at the absolute path ${probePath} ` +
            `whose entire contents are exactly:\n${marker}\n` +
            `Then call signal_completion. Do not run any shell commands.`,
        },
      ];

      const ctx: PlatformToolContext = {
        signalCompletion: () => {},
        createReviewInfo: () => {},
        createSubTask: () => {},
        respondToSubTask: () => {},
        raiseToParent: () => {},
        waitForSubtasks: () => {},
        saveSkill: () => {},
        resolveDecision: () => {},
        confirmDecision: () => {},
        requestSpend: async () => ({ status: 'denied' }),
        emit: () => {},
      };

      const input: TurnInput = {
        profile,
        world,
        messages,
        role: 'do',
        systemPrompt: 'You are a headless coding agent. Follow the instruction exactly.',
        resolvedAuth: { configHome, oauthToken: FRESH_TOKEN },
      };

      await new ClaudeAdapter().runTurn(input, ctx);

      // The policy forces `default` mode; without the canUseTool approver the Write
      // is denied and the file never lands — this is the assertion that catches it.
      expect(fs.existsSync(probePath)).toBe(true);
      expect(fs.readFileSync(probePath, 'utf8').trim()).toBe(marker);
    } finally {
      if (world) await world.destroy().catch(() => {});
      fs.rmSync(configHome, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  }, 180_000);
});
