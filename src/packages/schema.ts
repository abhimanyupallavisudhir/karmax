import { z } from 'zod';
import type { WorkflowManifest } from '../contrib/manifests.js';
import { deploymentConfig } from '../config/deployment.js';
import { BRAND } from '../domain/brand.js';

/**
 * Runtime validation for a workflow manifest (PLAN item 21). A loaded package is
 * untrusted, so its manifest must be verified before the platform wires it in —
 * "refuse code outside the declared shape" (SPEC §10.2). Required fields are
 * strict; optional/deep shapes are lenient with `.passthrough()` so a newer
 * package with extra keys still validates (forward-compat).
 */
/** Every string/array is bounded: a package is untrusted input and its manifest
 *  text ends up in agent prompts and the worker bundle, so a 100 MB
 *  `promptTemplate` must be rejected at the door rather than paid for per turn. */
const SHORT = 200;
const TEXT = 4_000;
/** Prompt-shaped fields: generous, but not "the whole context window" generous. */
const PROMPT = 200_000;

const event = z.object({ type: z.string().max(SHORT), description: z.string().max(TEXT).optional(), fields: z.record(z.string().max(SHORT), z.string().max(TEXT)).optional() }).passthrough();
const command = z.object({ id: z.string().max(SHORT), title: z.string().max(TEXT), keybinding: z.string().max(SHORT).optional() }).passthrough();
const ui = z.object({ slot: z.string().max(SHORT), tier: z.number().int().min(1).max(4), component: z.string().max(SHORT).optional(), title: z.string().max(TEXT).optional() }).passthrough();
const role = z.object({
  name: z.string().min(1).max(SHORT),
  label: z.string().max(TEXT),
  promptTemplate: z.string().max(PROMPT),
  capabilities: z.array(z.string().max(SHORT)).max(500).optional(),
  defaults: z.object({ effort: z.string().max(SHORT).optional(), maxTurns: z.number().optional() }).passthrough().optional(),
}).passthrough();
const agentMcp = z.object({ name: z.string().min(1).max(SHORT), command: z.string().min(1).max(TEXT), args: z.array(z.string().max(TEXT)).max(200).optional(), env: z.record(z.string().max(SHORT), z.string().max(TEXT)).optional() }).passthrough();
const resolveRule = z.object({ name: z.string().max(SHORT), match: z.string().max(TEXT), flags: z.string().max(16).optional(), action: z.literal('retry').optional(), note: z.string().max(TEXT).optional() }).passthrough();
const stage = z.object({ key: z.string().min(1).max(SHORT), label: z.string().max(TEXT), ponr: z.boolean().optional(), aliases: z.array(z.string().max(SHORT)).max(50).optional() }).passthrough();
const field = z.object({ name: z.string().min(1).max(SHORT), type: z.string().max(SHORT), label: z.string().max(TEXT).optional(), scopes: z.array(z.string().max(SHORT)).max(50) }).passthrough();

/**
 * The workflow module's named export to use as the durable function. This value
 * is interpolated *verbatim* into the generated worker bundle entry
 * (`src/packages/bundle.ts`), so it must be a bare JS identifier and nothing
 * else — a manifest that spelled it `x } from "node:fs"; import evil` used to
 * write arbitrary statements into code webpack then compiled into the worker.
 * Declared here (rather than riding `.passthrough()` untyped) so validation,
 * not the bundler, is the gate.
 */
export const ENTRYPOINT_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const manifestSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  description: z.string().max(4_000),
  requires: z.array(z.string().max(200)).max(200),
  events: z.array(event).max(500),
  capabilities: z.array(z.string().max(200)).max(500),
  ui: z.array(ui).max(200),
  commands: z.array(command).max(200),
  entrypoint: z.string().regex(ENTRYPOINT_PATTERN, 'must be a bare JavaScript identifier').optional(),
  roles: z.array(role).max(50).optional(),
  agentMcp: z.array(agentMcp).max(100).optional(),
  resolveRules: z.array(resolveRule).max(500).optional(),
  promptPreamble: z.string().max(200_000).optional(),
  stages: z.array(stage).max(200).optional(),
  params: z.array(field).max(500),
  onActivate: z.object({ spawnTask: z.object({
    workflow: z.string().max(200),
    title: z.string().max(1_000),
    prompt: z.string().max(200_000),
    hostedPrompt: z.string().max(200_000).optional(),
  }).optional() }).passthrough().optional(),
  kind: z.enum(['task', 'coordinator']).optional(),
  selectable: z.boolean().optional(),
}).passthrough();

/** Validate + type a manifest; throws on malformed. */
export function parseManifest(data: unknown): WorkflowManifest {
  const manifest = manifestSchema.parse(data) as unknown as WorkflowManifest;
  assertHostSafe(manifest);
  return manifest;
}

/** An `agentMcp` entry is a command the agent harness spawns on the machine
 *  running it — the control plane for worktree/container worlds. The operator
 *  installing a package on their own machine chose that; on a hosted cell the
 *  installer is a tenant administrator and the host is shared, so the entry is
 *  refused there (bundled manifests are unaffected). */
export function assertHostSafe(manifest: WorkflowManifest): void {
  if (manifest.agentMcp?.length && deploymentConfig().hosted)
    throw new Error(`hosted ${BRAND} does not accept workflow packages that declare agentMcp servers (they would run commands on the shared control plane)`);
}

/** Non-throwing validation with a flat, human-readable error string. */
export function safeParseManifest(data: unknown): { ok: true; manifest: WorkflowManifest } | { ok: false; error: string } {
  const r = manifestSchema.safeParse(data);
  if (r.success) {
    try { assertHostSafe(r.data as unknown as WorkflowManifest); }
    catch (error) { return { ok: false, error: (error as Error).message }; }
    return { ok: true, manifest: r.data as unknown as WorkflowManifest };
  }
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}
