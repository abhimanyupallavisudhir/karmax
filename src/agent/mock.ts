import { AdapterTurn, AgentAdapter, PlatformToolContext, TurnInput } from './types.js';
import { parseTransition } from '../resolve/transitions.js';

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
 *   @respond <action> [:: text]     parent answers a raising child (confirm/comment/retry/cancel)
 *   @raise <type> [:: detail]       child raises to its parent (needs_info/needs_permission/…)
 *   @wait                           parent parks until its sub-tasks finish/raise
 *   @review <summary>               attach review info
 *   @skill <name> :: <content>      save a skill
 *   @fail <message>                 throw (exercises Resolve)
 *   @failonce <message>             throw only the FIRST time per world (exercises the
 *                                   transient-infra retry path — no Resolve)
 *   @decide <action> :: <reason>    resolve agent verdict (resume/retryStage/gotoStage/parkUntil/escalate)
 *   @incomplete                     do NOT signal completion this turn
 *   @sleep <ms>                     await, but abort promptly if cancelled (tests mid-turn cancel)
 */
// @failonce ledger: activity retries land in the same world, so keying by world+message
// makes the second attempt succeed. Module-level: survives across turn invocations.
const failedOnce = new Set<string>();

export class MockAdapter implements AgentAdapter {
  readonly provider = 'mock' as const;

  async runTurn(input: TurnInput, ctx: PlatformToolContext): Promise<AdapterTurn> {
    // Mirror the real adapters: publish the session id the moment it exists and
    // beat once, so an interrupted turn's retry can resume it (heartbeat details
    // carry the session — see runAgentTurn) and pending cancellations deliver.
    const session = input.session ?? `mock-${input.world.handle.id}`;
    ctx.onSession?.(session);
    ctx.heartbeat?.();
    // Act on the latest USER message (or the task prompt on turn one), so directives
    // fire once per turn rather than re-firing the whole history. We deliberately
    // ignore `role: 'system'` messages to MIRROR the real provider adapters
    // (claude.ts / codex.ts both strip conversation system messages) — otherwise the
    // mock "sees" things a real agent never would, masking bugs like a child raise
    // injected as a system message that never reaches the parent agent.
    const recent = input.messages.filter((m) => m.role === 'user');
    const text = recent.length ? recent[recent.length - 1]!.text : input.systemPrompt;

    let complete = true;
    const outputs: string[] = [];

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('@')) continue;
      const [, directive, rest = ''] = line.match(/^@(\w+)\s*(.*)$/) ?? [];
      switch (directive) {
        case 'write': {
          const [p, content = ''] = splitOn(rest, '::');
          await input.world.writeFile(p.trim(), content.replace(/\\n/g, '\n'));
          ctx.emit(`wrote ${p.trim()}`);
          outputs.push(`wrote ${p.trim()}`);
          break;
        }
        case 'run': {
          const r = await input.world.exec('bash', ['-lc', rest]);
          ctx.emit(`$ ${rest}\n${r.stdout}${r.stderr}`);
          outputs.push(`ran: ${rest} (exit ${r.code})`);
          break;
        }
        case 'subtask': {
          const [title, prompt = ''] = splitOn(rest, '::');
          ctx.createSubTask({ title: title.trim(), prompt: prompt.trim() });
          outputs.push(`subtask: ${title.trim()}`);
          break;
        }
        case 'respond': {
          // @respond <action> [:: text] — parent answering a raising child. Omits
          // child_task_id, so it targets all children currently waiting.
          const [action, textRest = ''] = splitOn(rest, '::');
          const act = action.trim();
          if (['confirm', 'comment', 'retry', 'cancel'].includes(act)) {
            ctx.respondToSubTask({ action: act as 'confirm' | 'comment' | 'retry' | 'cancel', text: textRest.trim() || undefined });
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
          ctx.createReviewInfo({ summary: rest });
          outputs.push(`review: ${rest}`);
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
          // Simulate a long turn that honors mid-turn cancellation (SPEC §5.6).
          ctx.heartbeat?.();
          const ms = Number(rest.trim()) || 1000;
          await new Promise<void>((resolve, reject) => {
            if (ctx.signal?.aborted) return reject(new Error('aborted'));
            const t = setTimeout(resolve, ms);
            ctx.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
          });
          outputs.push(`slept ${ms}ms`);
          break;
        }
        case 'fail':
          throw new Error(rest || 'mock failure');
        case 'failonce': {
          const key = `${input.world.handle.id}:${rest}`;
          if (!failedOnce.has(key)) {
            failedOnce.add(key);
            throw new Error(rest || 'mock transient failure');
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
        case 'incomplete':
          complete = false;
          break;
        default:
          break;
      }
    }

    if (outputs.length === 0) outputs.push('(mock agent: no directives; nothing to do)');
    if (complete) ctx.signalCompletion(outputs.join('; '));
    return { session, output: outputs.join('\n') };
  }
}

function splitOn(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, ''];
  return [s.slice(0, i), s.slice(i + sep.length)];
}
