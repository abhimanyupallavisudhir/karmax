import type { ScopedToken, TokenActor, VerifiedHumanSubject } from './tokens.js';

export type IdentityRequirement = 'capability' | 'human-subject' | 'interactive-human';

export interface CallerIdentity {
  actor: TokenActor;
  humanSubject?: VerifiedHumanSubject;
  externalIdentities?: ScopedToken['externalIdentities'];
}

export class IdentityRequirementError extends Error {
  status = 403;
  constructor(public requirement: Exclude<IdentityRequirement, 'capability'>) {
    super(requirement === 'interactive-human'
      ? 'an interactive human session is required'
      : 'a verified human subject is required');
  }
}

/** Resolve identity only from token-authority claims. `sessionUserId` proves
 * live browser presence, but never supplies or replaces an agent's subject. */
export function resolveCallerIdentity(record: ScopedToken, sessionUserId?: string): CallerIdentity {
  const actor = record.actor ?? legacyActor(record);
  const humanSubject = record.humanSubject ?? legacyHumanSubject(record);
  if (actor.kind === 'interactive-human') {
    if (!sessionUserId || actor.userId !== sessionUserId || humanSubject?.userId !== sessionUserId)
      return { actor: { kind: 'autonomous', principal: record.principal } };
  }
  return { actor, humanSubject, externalIdentities: record.externalIdentities };
}

function legacyActor(record: ScopedToken): TokenActor {
  if (record.kind === 'agent') return { kind: 'task-agent', taskId: record.taskId,
    profileId: record.profileId, role: record.role };
  if (record.kind === 'system') return { kind: 'system', principal: record.principal };
  return { kind: 'autonomous', principal: record.principal };
}

/** Historical browser tokens can retain their ordinary browser flow during
 * their bounded TTL. Historical agent records never infer a subject from the
 * generic `principal` string. */
function legacyHumanSubject(record: ScopedToken): VerifiedHumanSubject | undefined {
  if (record.kind !== 'human' || !record.principal.startsWith('user:') || record.principal.length <= 5) return undefined;
  return { kind: 'user', userId: record.principal.slice(5), presence: 'interactive' };
}

export function requireHumanSubject(identity: CallerIdentity): VerifiedHumanSubject {
  if (!identity.humanSubject) throw new IdentityRequirementError('human-subject');
  return identity.humanSubject;
}

export function requireInteractiveHuman(identity: CallerIdentity): VerifiedHumanSubject {
  const subject = requireHumanSubject(identity);
  if (identity.actor.kind !== 'interactive-human' || subject.presence !== 'interactive')
    throw new IdentityRequirementError('interactive-human');
  return subject;
}

export function actorPrincipal(actor: TokenActor): string {
  if (actor.kind === 'interactive-human') return `user:${actor.userId}`;
  if (actor.kind === 'task-agent') return `task-agent:${actor.taskId}:${actor.role ?? actor.profileId}`;
  return actor.principal;
}

export function identityAuditDetail(identity: CallerIdentity): Record<string, unknown> {
  return {
    actor: identity.actor,
    ...(identity.humanSubject ? { humanSubject: { kind: 'user', userId: identity.humanSubject.userId,
      presence: identity.humanSubject.presence } } : {}),
  };
}
