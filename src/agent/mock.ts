import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput } from './types.js';
import { parseTransition } from '../resolve/transitions.js';
import { providerErrorFromMessage } from './limits.js';
import { worldRepoTarget, worldRepos, worldWorkingRelativePath } from '../world/types.js';

/**
 * Deterministic mock agent for hermetic tests. It executes simple directives
 * found in the prompt/messages so tests can drive the full pipeline without a
 * real model. NEVER the default in the shipped app (SPEC: whatever can be
 * automated should be — but with a REAL agent).
 *
 * Directives (one per line, anywhere in the task prompt or follow-up messages):
 *   @write <path> :: <content>      write a file (\n decoded to newlines)
 *   @run <command...>               run a shell command in the world
 *   @subtask <title> :: <prompt>    spawn a child task
 *   @branch <name> [:: <base>]      add another branch/PR to this task (multi-PR)
 *   @respond <action> [:: text]     parent answers a raising child (open_pr/confirm/comment/retry/cancel)
 *   @raise <type> [:: detail]       child raises to its parent (needs_info/needs_permission/…)
 *   @wait                           parent parks until its sub-tasks finish/raise
 *   @subagents <n>                  report in-harness sub-agents (Task tool) still running:
 *                                   N this turn, then N-1, … draining by one each turn until
 *                                   0 — models sub-agents that settle over several turns
 *   @shells <n>                     report backgrounded shells (run_in_background Bash) still
 *                                   running: N this turn, then N-1, … draining by one each turn
 *                                   until 0 — models a `npm test &` the turn ended while awaiting
 *   @review <summary>               attach review info
 *   @skill <name> :: <content>      save a skill
 *   @fail <message>                 throw (exercises Resolve)
 *   @failonce <message>             throw only the FIRST time per world (exercises the
 *                                   transient-infra retry path — no Resolve)
 *   @decide <action> :: <reason>    resolve agent verdict (resume/retryStage/gotoStage/parkUntil/escalate)
 *   @confirm <action> [:: text]     confirm agent verdict (confirm/revise/reject)
 *   @openpr                         explicitly request the PR/Review cycle
 *   @incomplete                     do NOT signal completion this turn
 *   @profile                        echo this turn's model/effort (`profile: <model>/<effort>`)
 *   @sleep <ms>                     await, but abort promptly if cancelled (tests mid-turn cancel)
 */
// @failonce ledger: activity retries land in the same world, so keying by world+message
// makes the second attempt succeed. Module-level: survives across turn invocations.
const failedOnce = new Set<string>();
// `@subagents N` ledger: the sub-agent count drains by one each turn (keyed by world),
// so a turn that "finished" is HELD in Do until the count reaches 0 — modelling
// auto-backgrounded Claude Agent SDK sub-agents that settle over several turns.
const stickySubagents = new Map<string, number>();
// `@shells N` ledger: same draining model, for backgrounded shells (run_in_background
// Bash) the turn returned while still running — held in Do, but with a smaller budget.
const stickyShells = new Map<string, number>();

export class MockAdapter implements AgentAdapter {
  readonly provider = 'mock' as const;

  async runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    ctx.emitActivity ??= () => {};
    // Mirror the real adapters: publish the session id the moment it exists and
    // beat once, so an interrupted turn's retry can resume it (heartbeat details
    // carry the session — see runAgentTurn) and pending cancellations deliver.
    const session = input.session ?? `mock-${input.world.handle.id}`;
    ctx.onSession?.(session);
    ctx.heartbeat?.();

    // Hermetic regression hook for the Resolve boundary: the original Do failure
    // is carried into the Resolve system prompt, letting a test prove that a
    // failure OF the resolver escalates instead of terminally failing the workflow.
    if (input.role === 'resolve' && input.systemPrompt.includes('resolve-agent-failure-test')) {
      throw new Error('resolve agent itself failed');
    }

    let complete = true;
    let pendingSubagents = 0;
    const outputs: string[] = [];
    // How many `msgs` this turn has consumed — the schedule snapshot to start, then
    // one more per in-flight follow-up injected below (SPEC §5.6). Reported so the
    // workflow advances its boundary past exactly what we processed.
    let deliveredIndex = input.messages.length;

    // Pull + process any follow-ups queued in the workflow at/after `deliveredIndex`,
    // mirroring the Claude Agent SDK's live injection: a follow-up sent WHILE this turn
    // runs is handled in the SAME turn, not deferred to the next one. System messages
    // are skipped (as the real adapters strip them) but still advance the index.
    const drainFollowUps = async (): Promise<number> => {
      if (!ctx.pullFollowUps) return 0;
      let injected = 0;
      for (;;) {
        const news = await ctx.pullFollowUps(deliveredIndex);
        if (!news.length) break;
        for (const m of news) {
          if (m.role !== 'system' && m.role !== 'agent') {
            await processText(m.text);
            injected++;
          }
          deliveredIndex++;
        }
      }
      return injected;
    };

    // Process every directive line in one message's text (shared by the initial
    // delivered batch and each injected follow-up).
    const processText = async (text: string): Promise<void> => {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('@')) continue;
      const [, directive, rest = ''] = line.match(/^@(\w+)\s*(.*)$/) ?? [];
      switch (directive) {
        case 'write': {
          const [p, content = ''] = splitOn(rest, '::');
          ctx.emitActivity({ id: `write-${p.trim()}`, kind: 'file', phase: 'started', title: `Write ${p.trim()}` });
          await input.world.writeFile(worldWorkingRelativePath(input.world.handle, p.trim()), content.replace(/\\n/g, '\n'));
          ctx.emitActivity({ id: `write-${p.trim()}`, kind: 'file', phase: 'completed', title: `Wrote ${p.trim()}` });
          ctx.emit(`wrote ${p.trim()}`);
          outputs.push(`wrote ${p.trim()}`);
          break;
        }
        case 'run': {
          ctx.emitActivity({ id: `run-${rest}`, kind: 'command', phase: 'started', title: rest });
          const r = await input.world.exec('bash', ['-lc', rest]);
          ctx.emitActivity({
            id: `run-${rest}`,
            kind: 'command',
            phase: r.code === 0 ? 'completed' : 'failed',
            title: rest,
            detail: `${r.stdout}${r.stderr}`.trim().slice(0, 1600),
          });
          ctx.emit(`$ ${rest}\n${r.stdout}${r.stderr}`);
          outputs.push(`ran: ${rest} (exit ${r.code})`);
          break;
        }
        case 'subtask': {
          const [title, prompt = ''] = splitOn(rest, '::');
          await ctx.createSubTask({ title: title.trim(), prompt: prompt.trim() });
          outputs.push(`subtask: ${title.trim()}`);
          break;
        }
        case 'branch': {
          // @branch <name> [:: base]  — partition the change across another
          // branch (multi-PR, SPEC §11.1). Like the real tool it takes effect
          // immediately, so later directives in this same turn can write into it.
          const [name, base = ''] = splitOn(rest, '::');
          try {
            const added = await ctx.addCheckout({ name: name.trim(), ...(base.trim() ? { base: base.trim() } : {}) });
            outputs.push(`branch: ${added.branch} at ${added.root}`);
          } catch (e: any) {
            outputs.push(`branch failed: ${e?.message ?? e}`);
          }
          break;
        }
        case 'respond': {
          // @respond <action> [child_task_id] [:: text] — parent answering a child.
          // Without child_task_id it targets all children currently waiting.
          const [action, textRest = ''] = splitOn(rest, '::');
          const [act = '', childTaskId] = action.trim().split(/\s+/);
          if (['open_pr', 'confirm', 'comment', 'retry', 'cancel'].includes(act)) {
            await ctx.respondToSubTask({ action: act as 'open_pr' | 'confirm' | 'comment' | 'retry' | 'cancel', text: textRest.trim() || undefined,
              ...(childTaskId ? { childTaskId } : {}) });
            outputs.push(`respond: ${act}`);
          }
          break;
        }
        case 'raise': {
          // @raise <type> [:: detail] — child asking its parent. Pauses the turn.
          const [type, detail = ''] = splitOn(rest, '::');
          const t = type.trim();
          if (['needs_info', 'needs_permission', 'needs_confirmation', 'blocked'].includes(t)) {
            ctx.raiseToParent({ type: t as 'needs_info' | 'needs_permission' | 'needs_confirmation' | 'blocked', detail: detail.trim() || undefined });
            complete = false; // raising pauses for a reply; don't signal completion
            outputs.push(`raise: ${t}`);
          }
          break;
        }
        case 'wait': {
          // @wait — parent parks until its sub-tasks settle/raise. Not a completion.
          ctx.waitForSubtasks();
          complete = false;
          outputs.push('wait');
          break;
        }
        case 'review': {
          // @review <caption>  — a terse orientation line.
          await ctx.createReviewInfo({ caption: rest });
          outputs.push(`review: ${rest}`);
          break;
        }
        case 'runaction': {
          // @runaction <label> :: <command>  — a click-to-run review action.
          const [label, command = ''] = splitOn(rest, '::');
          await ctx.createReviewInfo({ actions: [{ kind: 'run', label: label.trim(), command: command.trim() }] });
          outputs.push(`runaction: ${label.trim()}`);
          break;
        }
        case 'openaction': {
          // @openaction <label> :: <target>  — a click-to-open file/URL review action.
          const [label, target = ''] = splitOn(rest, '::');
          await ctx.createReviewInfo({ actions: [{ kind: 'open', label: label.trim(), target: target.trim() }] });
          outputs.push(`openaction: ${label.trim()}`);
          break;
        }
        case 'skill': {
          const [name, content = ''] = splitOn(rest, '::');
          ctx.saveSkill({ name: name.trim(), content: content.trim() });
          outputs.push(`skill: ${name.trim()}`);
          break;
        }
        case 'spend': {
          // @spend <amount-cents> :: <why>
          const [amt, why = ''] = splitOn(rest, '::');
          const r = await ctx.requestSpend({ amount: Number(amt.trim()), why: why.trim() });
          ctx.emit(`spend(${amt.trim()}) → ${r.status}`);
          outputs.push(`spend ${amt.trim()}: ${r.status}`);
          break;
        }
        case 'sleep': {
          // Simulate a long turn that honors mid-turn cancellation (SPEC §5.6) AND
          // in-flight follow-up injection: sleep in small steps, polling for follow-ups
          // between them so a message sent during the turn is processed in-flight.
          const ms = Number(rest.trim()) || 1000;
          const step = 100;
          for (let waited = 0; waited < ms; waited += step) {
            if (ctx.signal?.aborted) throw new Error('aborted');
            ctx.heartbeat?.();
            await drainFollowUps();
            await new Promise<void>((resolve, reject) => {
              if (ctx.signal?.aborted) return reject(new Error('aborted'));
              const t = setTimeout(resolve, Math.min(step, ms - waited));
              ctx.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
            });
          }
          outputs.push(`slept ${ms}ms`);
          break;
        }
        // The mock stands in for a provider, so its failures are typed the way a
        // real adapter types a provider's error: only provider-tagged failures
        // may park a login (AD-2/AD-7); anything else stays a plain Error.
        case 'fail':
          throw providerErrorFromMessage('mock', rest || 'mock failure');
        case 'failonce': {
          const key = `${input.world.handle.id}:${rest}`;
          if (!failedOnce.has(key)) {
            failedOnce.add(key);
            throw providerErrorFromMessage('mock', rest || 'mock transient failure');
          }
          // Reached only when the retry REPLAYED the original prompt (no session
          // resume); a resumed retry sees just the continuation nudge instead.
          outputs.push(`recovered from: ${rest}`);
          break;
        }
        case 'decide': {
          // @decide <action> [:: reason] — a Resolve agent's structured verdict.
          const [action, reason = ''] = splitOn(rest, '::');
          const stageMatch = action.trim().match(/^(\w+)(?:\s+(\S+))?$/); // "gotoStage do"
          const t = parseTransition({ action: stageMatch?.[1], stage: stageMatch?.[2], reason: reason.trim() });
          if (t) {
            ctx.resolveDecision(t);
            complete = false; // the decision is the completion for a resolve turn
            outputs.push(`decide: ${t.do}`);
          }
          break;
        }
        case 'confirm': {
          // @confirm <action> [:: text] — a Confirm agent's Review-gate verdict.
          const [action, textRest = ''] = splitOn(rest, '::');
          const act = action.trim();
          if (['confirm', 'revise', 'reject'].includes(act)) {
            ctx.confirmDecision({ action: act as 'confirm' | 'revise' | 'reject', text: textRest.trim() || undefined });
            complete = false; // the verdict is the completion for a confirm turn
            outputs.push(`confirm: ${act}`);
          }
          break;
        }
        case 'openpr':
          ctx.openPr();
          outputs.push('open PR');
          break;
        case 'incomplete':
          complete = false;
          break;
        case 'subagents': {
          // Simulate a Claude-Agent-SDK turn that returned while N in-harness
          // sub-agents (Task tool) are still running — the completion must be HELD.
          stickySubagents.set(input.world.handle.id, Number(rest.trim()) || 0);
          outputs.push(`subagents: ${rest.trim()}`);
          break;
        }
        case 'shells': {
          // Simulate a turn that returned while N backgrounded shells are still running.
          stickyShells.set(input.world.handle.id, Number(rest.trim()) || 0);
          outputs.push(`shells: ${rest.trim()}`);
          break;
        }
        case 'profile':
          // Echo the model/effort this turn actually ran with, so tests can assert
          // an in-flight retune (SPEC §5.5) reaches the agent on its next turn.
          outputs.push(`profile: ${input.profile.model ?? '(none)'}/${input.profile.effort ?? '(none)'}`);
          break;
        default:
          break;
      }
    }
    };

    // Act on the latest USER message (or the task prompt on turn one), so directives
    // fire once per turn rather than re-firing the whole history. We deliberately
    // ignore `role: 'system'` messages to MIRROR the real provider adapters
    // (claude.ts / codex.ts both strip conversation system messages) — otherwise the
    // mock "sees" things a real agent never would, masking bugs like a child raise
    // injected as a system message that never reaches the parent agent.
    const recent = input.messages.filter((m) => m.role === 'user');
    const initialText = recent.length ? recent[recent.length - 1]!.text : input.systemPrompt;
    await processText(initialText);
    // A competent agent answers a dirty-proposal/landing rejection by committing
    // (machinery never sweeps uncommitted work). In current software-dev this is
    // the same Do agent; historical pins may still run the old Merge role.
    if (/uncommitted changes/.test(initialText) && /commit/i.test(initialText)) {
      for (const r of worldRepos(input.world.handle)) {
        await input.world.exec('bash', ['-lc', 'git add -A && git commit -q -m "mock: commit pending work" || true'], { cwd: r.root });
      }
      outputs.push('committed pending work');
    }
    // Current software-dev returns target races to the same Do agent. Exercise a
    // real repair (merge target into the proposal, resolve in favor of the task's
    // intended version, commit) before reopening it; historical Merge-agent tests
    // use different wording and retain their deliberately bounded failure path.
    if (/Landing the reviewed PR was refused/.test(initialText) && /conflict/i.test(initialText)) {
      for (const r of worldRepos(input.world.handle)) {
        const target = worldRepoTarget(r, input.world.handle.target ?? input.world.handle.base);
        const merged = await input.world.exec('git', ['merge', '--no-edit', target], { cwd: r.root });
        if (merged.code !== 0) {
          await input.world.exec('git', ['checkout', '--ours', '--', '.'], { cwd: r.root });
          await input.world.exec('git', ['add', '-A'], { cwd: r.root });
          await input.world.exec('git', ['commit', '-q', '-m', 'mock: resolve proposal race'], { cwd: r.root });
        }
      }
      outputs.push('repaired target race');
    }
    // Catch any follow-up that landed near the end of the turn (or during a non-sleep
    // turn) — process it in-flight rather than deferring it to the next turn.
    await drainFollowUps();

    // Drain any sticky sub-agent count by one: report the current count as still
    // in flight this turn, so the workflow holds until it reaches 0.
    const sticky = stickySubagents.get(input.world.handle.id) ?? 0;
    if (sticky > 0) {
      pendingSubagents = sticky;
      stickySubagents.set(input.world.handle.id, sticky - 1);
    }
    // Same draining for backgrounded shells.
    let pendingBackgroundShells = 0;
    const stickySh = stickyShells.get(input.world.handle.id) ?? 0;
    if (stickySh > 0) {
      pendingBackgroundShells = stickySh;
      stickyShells.set(input.world.handle.id, stickySh - 1);
    }

    if (outputs.length === 0) outputs.push('(mock agent: no directives; nothing to do)');
    if (complete) {
      ctx.signalCompletion(outputs.join('; '));
      // A competent current Do agent follows the prompt and explicitly opens the
      // PR when its work is complete. Auxiliary roles never own this transition.
      // Some adapter-only unit fixtures intentionally provide a partial context;
      // production runtimes always install the control bridge.
      if (input.role === 'do') ctx.openPr?.();
    }
    ctx.emitActivity({ id: `message-${deliveredIndex}`, kind: 'message', phase: 'completed', title: outputs.join('\n') });
    return {
      termination: { kind: 'success', status: 'mock.completed' },
      session,
      output: outputs.join('\n'),
      delivered: deliveredIndex,
      ...(pendingSubagents ? { pendingSubagents } : {}),
      ...(pendingBackgroundShells ? { pendingBackgroundShells } : {}),
    };
  }
}

function splitOn(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, ''];
  return [s.slice(0, i), s.slice(i + sep.length)];
}
