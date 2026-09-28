import type { AgentSpec, Avatar, Project } from '../domain/types.js';
import type { Store } from '../store/db.js';
import { manifest } from '../contrib/manifests.js';
import { isAgentProvider } from '../agent/provider-registry.js';
import { validateMcpSelection } from '../mcp/connections/store.js';
import { avatarCallableBy, avatarEnabled } from './avatars.js';
import { CapabilityError, ValidationError } from './errors.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const set = (value: unknown) => value !== undefined && value !== null && value !== '';

/** The Avatar an agent value selects, refused when this project, or the human
 * behind the calling chain, may not use it. Invocation is checked against that
 * human, not against an arbitrary task-agent id. */
export async function selectableAvatar(store: Store, project: Project, spec: unknown, role: string,
  callerUserId: string | undefined): Promise<Avatar | undefined> {
  const record = spec && typeof spec === 'object' && !Array.isArray(spec)
    ? spec as Record<string, unknown> : undefined;
  const avatarId = record?.avatarId;
  if (typeof avatarId !== 'string' || !avatarId) return undefined;
  const avatar = (await store.getAvatar(avatarId));
  if (!avatar || avatar.projectId !== project.id) throw new ValidationError('the selected Avatar is not available in this project');
  if (!(await avatarEnabled(store, avatar))) throw new ValidationError(`Avatar "${avatar.name}" is disabled`);
  const purpose = typeof record?.avatarPurpose === 'string' ? record.avatarPurpose : role;
  if (avatar.roles.length && !avatar.roles.includes(purpose))
    throw new ValidationError(`Avatar "${avatar.name}" cannot be used for the ${purpose} role`);
  if (!callerUserId || !(await avatarCallableBy(store, avatar, callerUserId)))
    throw new CapabilityError(`you are not allowed to call Avatar "${avatar.name}"`);
  return avatar;
}

/**
 * Refuse a task-form agent value (SPEC §10.4) that no turn could run when the
 * task is created, not at its first turn: a provider karmax has no agent for,
 * an unknown reasoning effort or tool selection, a model the organization's
 * allowlist excludes, or an Avatar the project or caller can't use.
 * create_task and create_sub_task both validate through here.
 */
export async function assertAgentSpec(store: Store, project: Project, spec: unknown, role: string,
  callerUserId: string | undefined): Promise<Avatar | undefined> {
  if (spec === undefined || spec === null) return undefined;
  if (typeof spec !== 'object' || Array.isArray(spec)) throw new ValidationError(`"agent:${role}" must be an agent spec`);
  const { provider, model, effort, mcpConnections } = spec as Record<string, unknown>;
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
  return selectableAvatar(store, project, spec, role, callerUserId);
}

/** Why a sub-task can't set a task-form field that its parent fixes. */
const FIXED_BY_PARENT: Record<string, string> = {
  prompt: 'pass it as the prompt argument',
  base: 'a sub-task branches from your branch',
  target: 'a sub-task merges back into your branch',
  confirm: 'you review your sub-tasks',
  responder: 'you answer your sub-tasks',
};
const SUB_TASK_AGENT_KEYS = ['provider', 'model', 'effort', 'mcpConnections', 'avatarId'];

/**
 * create_sub_task's optional `params` (PL-11): the child's own task-form values,
 * meaning what they mean to create_task, merged over what the child inherits.
 * A child builds on its parent's branch, in its parent's project and world
 * environment, under its parent's grant and supervision, so only its agent
 * fields are its own. Anything else is refused, never dropped. Returns the
 * normalized agent values, or undefined for none: exactly a child without params.
 */
export async function subTaskParams(store: Store, args: { projectId: string; parentTaskId: string; params: unknown }):
  Promise<Record<string, AgentSpec> | undefined> {
  const { params } = args;
  if (params === undefined || params === null) return undefined;
  if (typeof params !== 'object' || Array.isArray(params)) throw new ValidationError('params must map task-form fields to values');
  // Children always run software-dev (see prepareChildTask).
  const fields = manifest('software-dev')!.params;
  const agentFields = fields.filter((field) => field.type === 'agent').map((field) => field.name);
  const project = (await store.getProject(args.projectId));
  if (!project) throw new ValidationError(`no project ${args.projectId}`);
  const callerUserId = (await store.taskCreatorUserId(args.parentTaskId));
  const out: Record<string, AgentSpec> = {};
  for (const [name, value] of Object.entries(params)) {
    const field = fields.find((candidate) => candidate.name === name);
    if (!field) throw new ValidationError(`unknown field "${name}": a sub-task's params take ${agentFields.join(', ')}`);
    if (field.type !== 'agent')
      throw new ValidationError(`"${name}" cannot be set on a sub-task: ${FIXED_BY_PARENT[name] ?? 'it shares your project settings'}`);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`"${name}" must be an agent spec`);
    for (const key of Object.keys(value)) if (!SUB_TASK_AGENT_KEYS.includes(key))
      throw new ValidationError(`"${key}" cannot be set on a sub-task's ${name}: it takes ${SUB_TASK_AGENT_KEYS.join(', ')}`);
    const avatar = (await assertAgentSpec(store, project, value, field.role ?? name.replace(/^agent:/, ''), callerUserId));
    const spec = Object.fromEntries(Object.entries(value).filter(([, v]) => set(v))) as Partial<AgentSpec>;
    const provider = avatar?.runtime.provider ?? spec.provider;
    if (!provider) throw new ValidationError(`"${name}" needs a provider or an Avatar`);
    out[name] = { ...spec, provider };
  }
  return Object.keys(out).length ? out : undefined;
}
