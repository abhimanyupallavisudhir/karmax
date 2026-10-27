import type { AgentSpec, Avatar, Project, SubTaskParams } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { applyComputer, machineShape, normalizeComputer, type ComputerSpec, type MachineShape } from '../domain/computer.js';
import { manifest } from '../contrib/manifests.js';
import { isAgentProvider } from '../agent/provider-registry.js';
import { validateMcpSelection } from '../mcp/connections/store.js';
import { forkedAvatar } from './avatars.js';
import { ValidationError } from './errors.js';
import { normalizeAgentAuthority } from './agent-authority.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const set = (value: unknown) => value !== undefined && value !== null && value !== '';

/**
 * Refuse a task-form agent value (SPEC §10.4) that no turn could run when the
 * task is created, not at its first turn: a provider karmax has no agent for,
 * an unknown reasoning effort or tool selection, a model the organization's
 * allowlist excludes. Returns the Avatar it forks and acts for, when it forks
 * one the human behind the calling chain may call (src/platform/avatars.ts).
 * create_task and create_sub_task both validate through here.
 */
export async function assertAgentSpec(store: Store, project: Project, spec: unknown, role: string,
  callerUserId: string | undefined): Promise<Avatar | undefined> {
  if (spec === undefined || spec === null) return undefined;
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new ValidationError(`"agent:${role}" must be an agent spec`);
  const { provider, model, effort, mcpConnections, authority } = spec as Record<string, unknown>;
  // The main agent acts with the task's own authorization, vault grants and
  // payment policy; only the other agents carry an authority of their own.
  if (authority !== undefined && authority !== null) {
    if (role === 'do') throw new ValidationError('the main agent uses the task\'s authorization, vault credentials and payments; set those instead of its authority');
    normalizeAgentAuthority(authority, role);
  }
  if (set(provider) && !isAgentProvider(provider)) throw new ValidationError(`unknown agent provider "${String(provider)}"`);
  if (set(model) && typeof model !== 'string') throw new ValidationError(`the ${role} agent's model must be a model id`);
  if (set(effort) && !EFFORTS.includes(effort as string)) throw new ValidationError(`invalid reasoning effort "${String(effort)}"`);
  if (mcpConnections !== null) {
    try { validateMcpSelection(mcpConnections); } catch (error) { throw new ValidationError((error as Error).message); }
  }
  // The allowlist trusted admission enforces before a provider request, which
  // the mock agent never makes.
  if (typeof model === 'string' && model && provider !== 'mock') {
    const policy = (await store.getOrganizationUsagePolicy(project.organizationId ?? 'org_personal'));
    if (policy.allowedModels.length && !policy.allowedModels.includes(model))
      throw new ValidationError(`model ${model} is not allowed by the organization`);
  }
  return forkedAvatar(store, project.id, spec, callerUserId);
}

/** Why a sub-task can't set a task-form field that its parent fixes. */
const FIXED_BY_PARENT: Record<string, string> = {
  prompt: 'pass it as the prompt argument',
  base: 'a sub-task branches from your branch',
  target: 'a sub-task merges back into your branch',
  confirm: 'you review your sub-tasks',
  responder: 'you answer your sub-tasks',
};
const SUB_TASK_AGENT_KEYS = ['provider', 'model', 'effort', 'mcpConnections'];

/** What judges a Computer against the organization's provider accounts (the
 * gateway's and the worker's WorldProviderConnectionService). */
export interface ComputerChecks {
  available(organizationId: string | undefined, provider: string): Promise<boolean>;
  assertFits(organizationId: string | undefined, provider: string | undefined, spec: MachineShape): Promise<void>;
}

/** A parent's own Computer (its task-level value), which its sub-tasks start
 * from: a child runs on the machine its parent chose, not on the project's
 * defaults, unless it says otherwise. */
export function inheritedComputer(parentParams: Record<string, unknown> | undefined): ComputerSpec | undefined {
  try { return normalizeComputer(parentParams?.computer); } catch { return undefined; }
}

/** The Computer a sub-task runs on: its parent's own, with what the child sets
 * over it. Undefined when neither sets anything. */
export function childComputer(parentParams: Record<string, unknown> | undefined, own: unknown): ComputerSpec | undefined {
  let mine: ComputerSpec | undefined;
  try { mine = normalizeComputer(own); } catch { mine = undefined; }
  const merged = { ...inheritedComputer(parentParams), ...mine };
  return Object.keys(merged).length ? merged : undefined;
}

/**
 * create_sub_task's optional `params` (PL-11): the child's own task-form values,
 * meaning what they mean to create_task, merged over what the child inherits.
 * A child builds on its parent's branch, in its parent's project and world
 * environment, under its parent's grant and supervision, so only its agent
 * fields and its Computer are its own. Anything else is refused, never dropped.
 * The Computer is judged as create_task judges one, against the machine the
 * child would really get (its parent's, with these values over it). Returns the
 * normalized values, or undefined for none: exactly a child without params.
 */
export async function subTaskParams(store: Store, args: { projectId: string; parentTaskId: string; params: unknown;
  computers?: ComputerChecks }): Promise<SubTaskParams | undefined> {
  const { params } = args;
  if (params === undefined || params === null) return undefined;
  if (typeof params !== 'object' || Array.isArray(params)) throw new ValidationError('params must map task-form fields to values');
  // Children always run software-dev (see prepareChildTask).
  const fields = manifest('software-dev')!.params;
  const ownFields = fields.filter((field) => field.type === 'agent' || field.type === 'computer').map((field) => field.name);
  const project = (await store.getProject(args.projectId));
  if (!project) throw new ValidationError(`no project ${args.projectId}`);
  const callerUserId = (await store.taskCreatorUserId(args.parentTaskId));
  const out: SubTaskParams = {};
  for (const [name, value] of Object.entries(params)) {
    const field = fields.find((candidate) => candidate.name === name);
    if (!field) throw new ValidationError(`unknown field "${name}": a sub-task's params take ${ownFields.join(', ')}`);
    if (field.type === 'computer') {
      const computer = await subTaskComputer(store, project, args.parentTaskId, value, args.computers);
      if (computer) out.computer = computer;
      continue;
    }
    if (field.type !== 'agent')
      throw new ValidationError(`"${name}" cannot be set on a sub-task: ${FIXED_BY_PARENT[name] ?? 'it shares your project settings'}`);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`"${name}" must be an agent spec`);
    for (const key of Object.keys(value)) if (!SUB_TASK_AGENT_KEYS.includes(key))
      throw new ValidationError(`"${key}" cannot be set on a sub-task's ${name}: it takes ${SUB_TASK_AGENT_KEYS.join(', ')}`);
    (await assertAgentSpec(store, project, value, field.role ?? name.replace(/^agent:/, ''), callerUserId));
    const spec = Object.fromEntries(Object.entries(value).filter(([, v]) => set(v))) as Partial<AgentSpec>;
    if (!spec.provider) throw new ValidationError(`"${name}" needs a provider`);
    out[name as `agent:${string}`] = { ...spec, provider: spec.provider };
  }
  return Object.keys(out).length ? out : undefined;
}

/** A sub-task's own Computer, refused as create_task refuses one: a size out of
 * range, a provider this deployment cannot run or the organization has not
 * connected, or a machine its provider account cannot give. */
async function subTaskComputer(store: Store, project: Project, parentTaskId: string, raw: unknown,
  computers: ComputerChecks | undefined): Promise<ComputerSpec | undefined> {
  let computer: ComputerSpec | undefined;
  try { computer = normalizeComputer(raw); }
  catch (error) { throw new ValidationError(error instanceof Error ? error.message : String(error)); }
  if (!computer) return undefined;
  const organizationId = project.organizationId ?? 'org_personal';
  const provider = computer.provider;
  if (provider) {
    const local = ['worktree', 'container', 'memory'].includes(provider);
    if (local && store.hosted) throw new ValidationError('hosted tasks run on a cloud computer (E2B, Daytona, Fly.io or Hetzner)');
    if (!local && computers && !(await computers.available(organizationId, provider)))
      throw new ValidationError(`${provider} is not connected. Connect it under Settings → Computers first.`);
  }
  if (computers) {
    const parent = (await store.getTask(parentTaskId));
    const effective = applyComputer(await store.effectiveProjectConfig(project), childComputer(parent?.params, computer));
    // Only the sizes it names, or every size when it moves to another provider.
    const shape = provider ? machineShape(effective) : machineShape({ resources: computer });
    try { await computers.assertFits(organizationId, effective.worldProvider, shape); }
    catch (error) { throw new ValidationError(error instanceof Error ? error.message : String(error)); }
  }
  return computer;
}
