/** Provider-neutral external events and safe task-input binding. This module is
 * pure so it can be used by the gateway, dispatcher, and cheap unit tests. */

export interface ExternalEventEnvelope {
  schema: 'karmax.external-event/1';
  id: string;
  organizationId: string;
  sourceId: string;
  connectionId?: string;
  provider: string;
  type: string;
  deliveryKey: string;
  occurredAt: number;
  receivedAt: number;
  actor?: { externalId?: string; display?: string };
  subject?: { externalId?: string; url?: string };
  data: Record<string, unknown>;
}

export interface ExternalSource {
  id: string;
  organizationId: string;
  provider: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  secretHandle?: string;
  createdAt: number;
  updatedAt: number;
}

export type ExternalEventState = 'pending' | 'processing' | 'delivered' | 'failed' | 'dead-letter';

export interface StoredExternalEvent extends ExternalEventEnvelope {
  state: ExternalEventState;
  attempts: number;
  nextAttemptAt: number;
  claimedAt?: number;
  lastError?: string;
  taskIds: string[];
}

export interface ExternalTrigger {
  kind: 'external';
  sourceId?: string;
  provider?: string;
  type: string;
  /** Dot-path equality. Arrays match when any member equals the expected value. */
  where?: Record<string, unknown>;
  /** Task-form field -> bounded `{{ dot.path }}` template. */
  map?: Record<string, string>;
  recurring?: true;
}

const FORBIDDEN_MAPPED_FIELDS = new Set([
  '_authorization', '_githubAccountId', 'authorization', 'authorizationProfile',
  'projectId', 'workflow', 'workflowVersion', 'assignee', 'delegate',
  'confirmationPolicy', 'credentialGrants', 'credentialPolicies', 'triggers',
  'repeatable', 'runOf', 'priority', 'profiles', 'draft', 'archived',
]);

export function externalMappedFieldAllowed(field: string): boolean {
  return Boolean(field.trim()) && !FORBIDDEN_MAPPED_FIELDS.has(field) && !field.startsWith('_');
}

export function externalTriggerValidationErrors(trigger: ExternalTrigger): string[] {
  const errors: string[] = [];
  if (!trigger.type?.trim()) errors.push('external trigger needs an event `type`');
  if (!trigger.sourceId?.trim() && !trigger.provider?.trim())
    errors.push('external trigger needs a `sourceId` or provider');
  for (const [field, template] of Object.entries(trigger.map ?? {})) {
    if (!externalMappedFieldAllowed(field))
      errors.push(`external trigger may not map authority-owned field "${field}"`);
    if (typeof template !== 'string' || template.length > 100_000)
      errors.push(`external trigger mapping for "${field}" is invalid or too long`);
  }
  return errors;
}

export function valueAtPath(value: unknown, path: string): unknown {
  const parts = path.split('.');
  if (!path || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)
    || ['__proto__', 'prototype', 'constructor'].includes(part))) return undefined;
  let cursor: unknown = value;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function equal(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) return actual.some((candidate) => equal(candidate, expected));
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object')
    return JSON.stringify(actual) === JSON.stringify(expected);
  return actual === expected;
}

export function externalTriggerMatches(trigger: ExternalTrigger, event: ExternalEventEnvelope): boolean {
  if (trigger.type !== event.type) return false;
  if (trigger.sourceId && trigger.sourceId !== event.sourceId) return false;
  if (trigger.provider && trigger.provider !== event.provider) return false;
  for (const [path, expected] of Object.entries(trigger.where ?? {})) {
    if (!equal(valueAtPath(event, path), expected) && !equal(valueAtPath(event.data, path), expected)) return false;
  }
  return true;
}

/** Render only simple field insertions. There are deliberately no expressions,
 * helpers, property traversal through prototypes, loops, or executable code. */
export function renderExternalTemplate(template: string, event: ExternalEventEnvelope): string {
  if (template.length > 100_000) throw new Error('external mapping template is too long');
  const rendered = template.replace(/{{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*}}/g, (_all, path: string) => {
    const value = valueAtPath(event, path) ?? valueAtPath(event.data, path);
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  });
  if (rendered.length > 500_000) throw new Error('external mapping result is too long');
  return rendered;
}

export function mappedExternalParams(trigger: ExternalTrigger, event: ExternalEventEnvelope): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, template] of Object.entries(trigger.map ?? {})) {
    if (!externalMappedFieldAllowed(field))
      throw new Error(`external trigger may not map authority-owned field "${field}"`);
    out[field] = renderExternalTemplate(template, event);
  }
  return out;
}
