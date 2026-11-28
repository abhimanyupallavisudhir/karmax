/**
 * Who made a decision — on a permission, authorization, credential or
 * connection request, or a Review — as it is recorded and as it is shown.
 *
 * A decision records the one who took it, never the authority it was taken
 * with: an agent acts with its human's (or Avatār's) delegation, but what it
 * decides is its own. Recording the delegating person made every view, and
 * every agent reading the record, say that person decided (2026-11-27:
 * preq_mwzzs9mwfe0322d123, denied by task #1064's agent, read as the owner's
 * denial). Records made before this fix cannot be told apart and still name
 * the person.
 */
import { BRAND } from '../domain/brand.js';
import { isParticipantKey, MAIN_AGENT, participantLabel } from '../domain/participants.js';
import type { Store } from '../store/db.js';
import { actorPrincipal, legacyActor } from './identity.js';
import type { ScopedToken } from './tokens.js';

/**
 * The principal a decision made with `caller` is recorded under: a person as
 * `user:<id>`, a task's agent as `task-agent:<taskId>:<role>`, an Avatār as
 * `avatar:<id>` (an Avatār's agent decides as the Avatār: that is whom it was
 * routed to, and it is never a person), the platform as `system:…`.
 */
export function decidingPrincipal(caller: ScopedToken): string {
  if (caller.principal.startsWith('avatar:') && caller.kind !== 'human') return caller.principal;
  return actorPrincipal(caller.actor ?? legacyActor(caller));
}

/** The task a `task-agent:` or `task:` principal names, if any. */
export function principalTaskId(principal: string | undefined): string | undefined {
  const match = /^(?:task-agent|task):([^:]+)/.exec(principal ?? '');
  return match?.[1];
}

export interface DecisionMaker {
  /** The recorded principal. */
  by: string;
  /** In words: "Ada Lovelace", "Task #1064's agent", "Avatār Bob", "tavya". */
  label: string;
  /** The task whose agent decided, for a link. */
  taskId?: string;
  num?: number;
}

/** What people (and agents) are told decided it. */
export async function decisionMaker(store: Pick<Store, 'getTask' | 'userDisplayName' | 'getAvatar'>,
  by: string | undefined): Promise<DecisionMaker | undefined> {
  if (!by) return undefined;
  if (by.startsWith('user:')) return { by, label: (await store.userDisplayName(by.slice(5))) ?? 'a person' };
  if (by.startsWith('avatar:')) {
    const name = (await store.getAvatar(by.slice(7)))?.name;
    return { by, label: name ? `Avatār ${name}` : 'an Avatār' };
  }
  if (by.startsWith('system:')) return { by, label: BRAND };
  const taskId = principalTaskId(by);
  if (!taskId) return { by, label: by };
  const task = await store.getTask(taskId);
  const name = `Task ${task?.num != null ? `#${task.num}` : taskId}`;
  if (by.startsWith('task:')) return { by, label: name, taskId, ...(task?.num != null ? { num: task.num } : {}) };
  // task-agent:<taskId>:<role or profile id>; a profile id may hold colons.
  const role = by.slice(`task-agent:${taskId}:`.length).split(':').pop()!.replace(/-default$/, '');
  const agent = !role || role === MAIN_AGENT || role === 'agent' ? 'agent'
    : isParticipantKey(role) ? participantLabel(role) : `${role} agent`;
  return { by, label: `${name}'s ${agent}`, taskId, ...(task?.num != null ? { num: task.num } : {}) };
}

/** A request as a GET route answers it: with who decided it (or took it
 * back) in words, beside the recorded principal. */
export async function withDecisionMaker<T extends { resolution?: { by: string }; withdrawn?: { by?: string } }>(
  store: Pick<Store, 'getTask' | 'userDisplayName' | 'getAvatar'>, request: T): Promise<T & { decidedBy?: DecisionMaker }> {
  const decidedBy = await decisionMaker(store, request.resolution?.by ?? request.withdrawn?.by);
  return decidedBy ? { ...request, decidedBy } : request;
}

/** "denied by Task #1064's agent", for an answer or a notice. */
export async function decidedText(store: Pick<Store, 'getTask' | 'userDisplayName' | 'getAvatar'>,
  request: { status: string; resolution?: { by: string }; withdrawn?: { by?: string } }): Promise<string> {
  const maker = await decisionMaker(store, request.resolution?.by ?? request.withdrawn?.by);
  return `${request.status}${maker ? ` by ${maker.label}` : ''}`;
}
