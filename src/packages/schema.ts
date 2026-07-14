import { z } from 'zod';
import type { WorkflowManifest } from '../contrib/manifests.js';

/**
 * Runtime validation for a workflow manifest (PLAN item 21). A loaded package is
 * untrusted, so its manifest must be verified before the platform wires it in —
 * "refuse code outside the declared shape" (SPEC §10.2). Required fields are
 * strict; optional/deep shapes are lenient with `.passthrough()` so a newer
 * package with extra keys still validates (forward-compat).
 */
const event = z.object({ type: z.string(), description: z.string().optional(), fields: z.record(z.string(), z.string()).optional() }).passthrough();
const command = z.object({ id: z.string(), title: z.string(), keybinding: z.string().optional() }).passthrough();
const ui = z.object({ slot: z.string(), tier: z.number().int().min(1).max(4), component: z.string().optional(), title: z.string().optional() }).passthrough();
const role = z.object({
  name: z.string().min(1),
  label: z.string(),
  promptTemplate: z.string(),
  capabilities: z.array(z.string()).optional(),
  defaults: z.object({ effort: z.string().optional(), maxTurns: z.number().optional() }).passthrough().optional(),
}).passthrough();
const agentMcp = z.object({ name: z.string().min(1), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }).passthrough();
const resolveRule = z.object({ name: z.string(), match: z.string(), flags: z.string().optional(), action: z.literal('retry').optional(), note: z.string().optional() }).passthrough();
const stage = z.object({ key: z.string().min(1), label: z.string(), ponr: z.boolean().optional(), aliases: z.array(z.string()).optional() }).passthrough();
const field = z.object({ name: z.string().min(1), type: z.string(), label: z.string().optional(), scopes: z.array(z.string()) }).passthrough();

export const manifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  requires: z.array(z.string()),
  events: z.array(event),
  capabilities: z.array(z.string()),
  ui: z.array(ui),
  commands: z.array(command),
  roles: z.array(role).optional(),
  agentMcp: z.array(agentMcp).optional(),
  resolveRules: z.array(resolveRule).optional(),
  promptPreamble: z.string().optional(),
  stages: z.array(stage).optional(),
  params: z.array(field),
  onActivate: z.object({ spawnTask: z.object({ workflow: z.string(), title: z.string(), prompt: z.string() }).optional() }).passthrough().optional(),
  kind: z.enum(['task', 'coordinator']).optional(),
}).passthrough();

/** Validate + type a manifest; throws on malformed. */
export function parseManifest(data: unknown): WorkflowManifest {
  return manifestSchema.parse(data) as unknown as WorkflowManifest;
}

/** Non-throwing validation with a flat, human-readable error string. */
export function safeParseManifest(data: unknown): { ok: true; manifest: WorkflowManifest } | { ok: false; error: string } {
  const r = manifestSchema.safeParse(data);
  if (r.success) return { ok: true, manifest: r.data as unknown as WorkflowManifest };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}
