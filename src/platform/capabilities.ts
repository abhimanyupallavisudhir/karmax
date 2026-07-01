/**
 * The capability model + attenuation (SPEC §8.1, §8.2). A flat set of named
 * capabilities granted to principals. An agent's effective capabilities are the
 * intersection of its profile-declared ceiling and the granting principal's
 * capabilities — least privilege, capability attenuation.
 *
 * Capabilities support `:`-segmented scoping and `*` wildcards, e.g.
 *   merge-into:/repo:main   merge-into:*   use-credential:openai   *
 */
export type Capability = string;

/** Does `pattern` (possibly with trailing `*` segment or bare `*`) cover `cap`? */
export function capMatches(pattern: Capability, cap: Capability): boolean {
  if (pattern === '*') return true;
  if (pattern === cap) return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1); // keep trailing ':'
    return cap.startsWith(prefix);
  }
  // segment-wise wildcard, e.g. merge-into:*:main
  const pSeg = pattern.split(':');
  const cSeg = cap.split(':');
  if (pSeg.length !== cSeg.length) return false;
  return pSeg.every((s, i) => s === '*' || s === cSeg[i]);
}

/** Does the capability set allow `requested`? */
export function allows(set: Capability[], requested: Capability): boolean {
  return set.some((p) => capMatches(p, requested));
}

/**
 * Effective capabilities = intersection(ceiling, grantor). A concrete cap on
 * either side is kept only if the other side also allows it (so wildcards
 * narrow to the concrete grants they cover).
 */
export function attenuate(ceiling: Capability[], grantor: Capability[]): Capability[] {
  const out = new Set<Capability>();
  for (const c of grantor) if (allows(ceiling, c)) out.add(c);
  for (const c of ceiling) if (allows(grantor, c)) out.add(c);
  return [...out];
}

/** Check a requested capability against both ceiling and grantor. */
export function effectiveAllows(ceiling: Capability[], grantor: Capability[], requested: Capability): boolean {
  return allows(ceiling, requested) && allows(grantor, requested);
}

/** The capabilities a tool requires to be invoked (used by the platform MCP). */
export const TOOL_CAPABILITY: Record<string, Capability> = {
  create_task: 'create-task',
  edit_task: 'edit-task',
  create_sub_task: 'create-sub-task',
  create_review_info: 'create-review-info',
  signal_completion: 'signal-completion',
  save_skill: 'save-skill',
  signal_task: 'signal-task',
  reorder_queue: 'reorder-queue',
  get_task: 'read-task',
  list_tasks: 'read-task',
  list_workflows: 'read-task',
  edit_workflow: 'edit-workflow',
  install_workflow: 'edit-workflow',
};
