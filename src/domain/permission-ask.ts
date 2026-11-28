import { capabilityPhrase } from '../platform/capabilities.js';

/**
 * What a permission request grants, in words — the one phrasing every place
 * that shows one uses: the console's approval card and For me row (through the
 * `ask` the gateway projects on each request), the inbox, browser and phone
 * notifications (the `ask` of its permission.approval-requested event), and the
 * messages that ask grantor tasks, Avatārs or a sub-task's parent to decide.
 *
 * A request adds capabilities, projects (the task's existing authority, at its
 * level, extended there), or both; the question names each it adds and never
 * counts what it does not. A capability reads as what it lets the agent do,
 * from the capability catalogue (`capabilityPhrase`), and phrases about the
 * same thing merge ("view and edit global settings"). Long lists are cut to a
 * few phrases; `detail` has every project and raw capability id, for a tooltip.
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
  /** Every project and capability id, one kind per line. */
  detail: string;
  /** What it lets the agent do, every phrase in full with its capability ids,
   * for agents' messages, which act on the ids: "work in admin_docs too (as
   * Developer) and view and edit global settings (settings:read, settings:write)". */
  grant: string;
}

/** Phrases shown in a question before the rest become "and N more". */
const SHOWN = 3;

/** "a", "a and b", "a, b and c", "a, b, c and 2 more". */
export function nameList(names: readonly string[], shown = SHOWN): string {
  if (names.length <= shown) return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${names.slice(0, shown).join(', ')} and ${names.length - shown} more`;
}

/** Capabilities as what they let the agent do, phrases about the same thing
 * merged in first-appearance order: settings:read + settings:write → "view and
 * edit global settings", with the ids each phrase covers. */
export function capabilityPhrases(capabilities: readonly string[]): Array<{ phrase: string; ids: string[] }> {
  const groups = new Map<string, { verbs: string[]; ids: string[] }>();
  for (const id of new Set(capabilities)) {
    const phrase = capabilityPhrase(id);
    const space = phrase.indexOf(' ');
    // An id shown as itself (unknown) has no verb to merge on: it stands alone.
    const [verb, object] = space > 0 && phrase !== id ? [phrase.slice(0, space), phrase.slice(space + 1)] : [phrase, `\0${id}`];
    const group = groups.get(object) ?? groups.set(object, { verbs: [], ids: [] }).get(object)!;
    if (!group.verbs.includes(verb)) group.verbs.push(verb);
    group.ids.push(id);
  }
  return [...groups].map(([object, { verbs, ids }]) => ({
    phrase: object.startsWith('\0') ? verbs[0]! : `${nameList(verbs, Infinity)} ${object}`, ids }));
}

export function permissionAsk(input: PermissionAskInput): PermissionAsk {
  const capabilities = [...new Set(input.capabilities)];
  const projects = [...new Set(input.projects ?? [])];
  const phrases = capabilityPhrases(capabilities);
  const level = input.level ? ` (as ${input.level})` : '';
  const work = (list: string) => `work in ${list} too${level}`;
  const does = [
    ...(projects.length ? [work(nameList(projects))] : []),
    ...(phrases.length ? [nameList(phrases.map(({ phrase }) => phrase))] : []),
  ];
  const question = does.length ? `Let ${input.agent} ${does.join(' and ')}?`
    // A request always asks for something (PermissionRequests.request); this is never shown.
    : `Approve ${input.agent}'s request?`;
  const detail = [
    ...(projects.length ? [`Projects: ${projects.join(', ')}${level}`] : []),
    ...(capabilities.length ? [`Permissions: ${capabilities.join(', ')}`] : []),
  ].join('\n');
  const grant = nameList([
    ...(projects.length ? [work(nameList(projects, Infinity))] : []),
    ...phrases.map(({ phrase, ids }) => ids.length === 1 && ids[0] === phrase ? phrase : `${phrase} (${ids.join(', ')})`),
  ], Infinity);
  return { question, detail, grant };
}

/** "#1060's agent", or "this task's agent" for a task without a number. */
export function taskAgent(task: { num?: number } | undefined): string {
  return task?.num != null ? `#${task.num}'s agent` : 'this task\'s agent';
}
