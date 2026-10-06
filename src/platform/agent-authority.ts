import type { AgentAuthority, AgentRole, AgentSpec, AuthorizationSelection, ConfirmConfig, ResponderConfig } from '../domain/types.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { MAIN_AGENT, isParticipantKey, reviewerKey } from '../domain/participants.js';
import { ValidationError } from './errors.js';

/**
 * Per-agent authority (wiki features/collaboration-model, SPEC §8.2).
 *
 * The main agent's authority is the task's own (`params._authorization`, the
 * task's vault grants and `paymentPolicy`). Every other agent — the Responder,
 * each agent layer of the Review route, an agent called in with `@` — may carry
 * `authority` in its spec. The platform attenuates it against whoever set it,
 * exactly like the task's, and stores the result as
 * `params._agentAuthorization[<participant key>]` with the same shape as
 * `params._authorization` (plus the agent's own payment policy). Turn tokens,
 * vault policies and payments for that participant read it from there; an agent
 * without an entry acts with the task's authority.
 *
 * Pure: no store or Node imports.
 */

/** Params field of an agent called into the task with `@` (`agent:agent-3`). */
export const CALLED_AGENT_FIELD = /^agent:(agent-[1-9][0-9]{0,2})$/;

export interface StoredAgentAuthorization {
  profileId?: string;
  level?: string;
  scope?: AuthorizationSelection['scope'];
  projectIds?: string[];
  organizationId?: string;
  capabilities: string[];
  attenuated?: boolean;
  /** The requested level/scope exceeded the grantor. */
  profileAttenuated?: boolean;
  /** The grantor chose to run with the limited package. */
  attenuationAccepted?: boolean;
  principal?: string;
  delegationId?: string;
  credentialPolicies?: Record<string, { use?: 'auto' | 'ask'; reveal?: 'auto' | 'ask' | 'never' }>;
  /** The agent's own cards and budget, always within the task's policy. */
  paymentPolicy?: AgentAuthority['paymentPolicy'];
  /** The authority this entry was computed from, to recognise an unchanged request. */
  requested: AgentAuthority;
}

/** Who a turn runs as when the workflow does not say: the role's own agent. */
export function defaultParticipant(role: AgentRole): string {
  if (role === 'responder') return 'responder';
  if (role === 'confirm') return 'confirm';
  return MAIN_AGENT;
}

/** The stored authorization a participant's turns use, or undefined for the task's. */
export function participantAuthorization(params: Record<string, unknown> | undefined, participant: string | undefined):
  StoredAgentAuthorization | undefined {
  if (!participant || participant === MAIN_AGENT) return undefined;
  const all = params?._agentAuthorization;
  if (!all || typeof all !== 'object' || Array.isArray(all)) return undefined;
  const entry = (all as Record<string, unknown>)[participant];
  return entry && typeof entry === 'object' && Array.isArray((entry as StoredAgentAuthorization).capabilities)
    ? entry as StoredAgentAuthorization : undefined;
}

/**
 * Every agent other than the main one that the given values configure, keyed by
 * participant: the Responder (when an agent answers), each agent layer of the
 * Review route in order (`confirm`, `confirm-2`…), and each `agent:agent-N`.
 */
export function agentSpecsByParticipant(values: Record<string, unknown>,
  fields: { responder?: string; confirm?: string } = { responder: 'responder', confirm: 'confirm' }): Map<string, Partial<AgentSpec>> {
  const out = new Map<string, Partial<AgentSpec>>();
  const responder = fields.responder ? values[fields.responder] as ResponderConfig | undefined : undefined;
  if (responder && typeof responder === 'object' && responder.kind === 'agent') out.set('responder', responder);
  const confirm = fields.confirm ? values[fields.confirm] as ConfirmConfig | undefined : undefined;
  if (confirm && typeof confirm === 'object') {
    let index = 0;
    for (const layer of confirmLayersOf(confirm)) if (layer.kind === 'agent') out.set(reviewerKey(index++), layer);
  }
  for (const [name, value] of Object.entries(values)) {
    const key = CALLED_AGENT_FIELD.exec(name)?.[1];
    if (key && isParticipantKey(key) && value && typeof value === 'object' && !Array.isArray(value))
      out.set(key, value as Partial<AgentSpec>);
  }
  return out;
}

const LEVEL = /^[a-z][a-z0-9_-]{0,63}$/i;
const SCOPES = ['projects', 'organization', 'global'];
const GRANT = /^use-credential:(item|tag|domain):[^\s]{1,200}$/;

/** Validate an `authority` value from an agent spec. Undefined/null ⇒ none. */
export function normalizeAgentAuthority(raw: unknown, label = 'agent'): AgentAuthority | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError(`the ${label}'s authority must be an object`);
  const value = raw as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !['authorization', 'credentialGrants', 'credentialPolicies', 'paymentPolicy'].includes(key));
  if (unknown.length) throw new ValidationError(`unknown ${label} authority field "${unknown[0]}"`);
  const out: AgentAuthority = {};
  if (value.authorization !== undefined) {
    const a = value.authorization as Record<string, unknown>;
    if (!a || typeof a !== 'object' || typeof a.level !== 'string' || !LEVEL.test(a.level)
      || !SCOPES.includes(a.scope as string)
      || (a.projectIds !== undefined && (!Array.isArray(a.projectIds) || a.projectIds.length > 200
        || a.projectIds.some((id) => typeof id !== 'string' || !id))))
      throw new ValidationError(`the ${label}'s authorization must be {level, scope, projectIds?}`);
    out.authorization = { level: a.level, scope: a.scope as AuthorizationSelection['scope'],
      ...(a.scope === 'projects' && Array.isArray(a.projectIds) ? { projectIds: [...new Set(a.projectIds as string[])] } : {}) };
  }
  if (value.credentialGrants !== undefined) {
    const grants = value.credentialGrants;
    if (!Array.isArray(grants) || grants.length > 500 || grants.some((grant) => typeof grant !== 'string' || !GRANT.test(grant)))
      throw new ValidationError(`the ${label}'s credentialGrants must be use-credential:… capabilities`);
    out.credentialGrants = [...new Set(grants as string[])];
  }
  if (value.credentialPolicies !== undefined) {
    const policies = value.credentialPolicies;
    if (!policies || typeof policies !== 'object' || Array.isArray(policies)
      || Object.values(policies).some((policy) => !policy || typeof policy !== 'object' || Array.isArray(policy)
        || Object.entries(policy).some(([key, v]) => key === 'use' ? !['auto', 'ask'].includes(v as string)
          : key === 'reveal' ? !['auto', 'ask', 'never'].includes(v as string) : true)))
      throw new ValidationError(`the ${label}'s credentialPolicies are invalid`);
    out.credentialPolicies = policies as AgentAuthority['credentialPolicies'];
  }
  if (value.paymentPolicy !== undefined) {
    const p = value.paymentPolicy as Record<string, unknown>;
    if (!p || typeof p !== 'object' || Array.isArray(p)
      || (p.cardIds !== undefined && (!Array.isArray(p.cardIds) || p.cardIds.some((id) => typeof id !== 'string')))
      || (p.budget !== undefined && p.budget !== null && (!Number.isSafeInteger(p.budget) || (p.budget as number) < 0))
      || (p.currency !== undefined && (typeof p.currency !== 'string' || !/^[a-z]{3}$/i.test(p.currency))))
      throw new ValidationError(`the ${label}'s paymentPolicy must be {cardIds?, budget?, currency?} with a non-negative whole budget`);
    out.paymentPolicy = {
      ...(Array.isArray(p.cardIds) ? { cardIds: [...new Set(p.cardIds as string[])] } : {}),
      ...(p.budget !== undefined ? { budget: p.budget as number | null } : {}),
      ...(typeof p.currency === 'string' ? { currency: p.currency.toLowerCase() } : {}),
    };
  }
  return out;
}

/** Canonical JSON of an authority request, for "did it change?" checks. */
export function authorityKey(authority: AgentAuthority | undefined): string {
  const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]))
      : value;
  return JSON.stringify(sort(authority ?? null));
}
