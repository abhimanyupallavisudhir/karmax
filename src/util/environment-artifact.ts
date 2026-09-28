import { BRAND } from '../domain/brand.js';
/** Attempts use distinct provider names: an abandoned operation must never
 * overwrite (or be cleaned up as) its replacement's image or snapshot. */
export function environmentArtifactName(projectId: string, digest: string, buildId?: string): string {
  const project = projectId.replace(/[^a-zA-Z0-9_.-]/g, '-');
  // Keep provider names below 63 characters without truncating attempt entropy.
  return (buildId ? `${BRAND}-env-${project.slice(0, 8)}-${buildId.replace(/-/g, '')}`
    : `${BRAND}-env-${project}-${digest}`).toLowerCase();
}
