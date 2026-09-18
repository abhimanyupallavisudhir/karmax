/** Attempts use distinct provider names: an abandoned operation must never
 * overwrite (or be cleaned up as) its replacement's image or snapshot. */
export function environmentArtifactName(projectId: string, digest: string, buildId?: string): string {
  const project = projectId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  // Keep provider names below 63 characters without truncating attempt entropy.
  return (buildId ? `karmax-env-${project.slice(0, 8)}-${buildId.replace(/-/g, '')}`
    : `karmax-env-${project}-${digest}`).toLowerCase();
}
