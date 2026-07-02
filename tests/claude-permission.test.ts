import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
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
        saveSkill: () => {},
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
