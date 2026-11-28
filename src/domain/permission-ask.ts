/**
 * What a permission request grants, in words — the one phrasing every place
 * that shows one uses: the console's approval card and For me row (through the
 * `ask` the gateway projects on each request), the inbox, browser and phone
 * notifications (the `ask` of its permission.approval-requested event), and the
 * messages that ask grantor tasks, Avatārs or a sub-task's parent to decide.
 *
 * A request adds capabilities, projects (the task's existing authority, at its
 * level, extended there), or both; the question names each it adds and never
 * counts what it does not. Long lists are cut to a few names; `detail` has
 * them all, for a tooltip.
 */

export interface PermissionAskInput {
  /** Who would hold it: "#1060's agent", "its agent". */
  agent: string;
  capabilities: readonly string[];
  /** The projects it adds the task to, by name. */
  projects?: readonly string[];
  /** The authority the task has in them, by name ("Developer"); none when it is delegated. */
  level?: string;
}

export interface PermissionAsk {
  /** "Let #1060's agent work in admin_docs too (as Developer)?" */
  question: string;
  /** Every project and capability, one kind per line. */
  detail: string;
  /** What it grants as a noun phrase, every name in full, for agents' messages:
   * "access to admin_docs (as Developer), and vault:read". */
  grant: string;
}

/** Names shown in a question before the rest become "and N more". */
const SHOWN = 3;

/** "a", "a and b", "a, b and c", "a, b, c and 2 more". */
export function nameList(names: readonly string[], shown = SHOWN): string {
  if (names.length <= shown) return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

export function permissionAsk(input: PermissionAskInput): PermissionAsk {
  const capabilities = [...new Set(input.capabilities)];
  const projects = [...new Set(input.projects ?? [])];
  const level = input.level ? ` (as ${input.level})` : '';
  const work = projects.length ? `work in ${nameList(projects)} too${level}` : '';
  const caps = nameList(capabilities);
  const question = work && caps ? `Let ${input.agent} ${work} and give it ${caps}?`
    : work ? `Let ${input.agent} ${work}?`
      : caps ? `Give ${input.agent} ${caps}?`
        // A request always asks for something (PermissionRequests.request); this is never shown.
        : `Approve ${input.agent}'s request?`;
  const detail = [
    ...(projects.length ? [`Projects: ${projects.join(', ')}${level}`] : []),
    ...(capabilities.length ? [`Permissions: ${capabilities.join(', ')}`] : []),
  ].join('\n');
  const grant = [
    ...(projects.length ? [`access to ${nameList(projects, Infinity)}${level}`] : []),
    ...(capabilities.length ? [nameList(capabilities, Infinity)] : []),
  ].join(', and ');
  return { question, detail, grant };
}

/** "#1060's agent", or "this task's agent" for a task without a number. */
export function taskAgent(task: { num?: number } | undefined): string {
  return task?.num != null ? `#${task.num}'s agent` : 'this task\'s agent';
}
