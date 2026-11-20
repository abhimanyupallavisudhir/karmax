import { BRAND } from '../domain/brand.js';
import { isHostedRepository } from '../domain/hosted-repository.js';
import { credentialResource } from '../domain/resource-drivers.js';
import type { Store } from '../store/db.js';

/**
 * What a world of this project can only get by reaching tavya itself, said as
 * "a computer there can't load …", or undefined when it needs nothing of it.
 *
 * Project data (every resource but a secret) is restored, read and saved by
 * restic in the world against tavya's resource repositories, with the restic
 * binary fetched from tavya too; a repository tavya hosts is cloned from it.
 * A provider account with basic internet (Daytona Tiers 1–2: package
 * registries, Git hosts, AI and cloud APIs) reaches neither, so such a world
 * failed setup with whatever its network said (tavya-error b2ed953c4946ea34,
 * `curl: (35) Recv failure: Connection reset by peer`), retried nine times.
 * The router and world setup refuse it up front instead (compute-router.ts
 * `reachesTavya`, computer-limits.ts `unreachableTavya`).
 */
export async function reachesTavya(store: Pick<Store, 'listResourceAttachments' | 'listProjectRepositories'>,
  projectId: string): Promise<string | undefined> {
  if ((await store.listResourceAttachments(projectId)).some((attachment) => !credentialResource(attachment))) return "this project's data";
  if ((await store.listProjectRepositories(projectId)).some((link) => isHostedRepository(link.repository)))
    return `this project's repositories ${BRAND} hosts`;
  return undefined;
}
