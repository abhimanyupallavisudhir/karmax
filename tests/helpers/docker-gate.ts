/** An enabled integration suite must fail if its required Docker daemon is absent. */
export function requireDocker(available: boolean): void {
  if (!available) throw new Error('Docker is required for this integration suite; set KARMAX_SKIP_DOCKER=1 to skip it');
}
