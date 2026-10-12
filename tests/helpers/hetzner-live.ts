import type { ResolvedWorldProviderConnection } from '../../src/world/connections.js';
import { serviceHomeLabel } from '../../src/world/services.js';

/** Hetzner project housekeeping for live suites: what existed before a run,
 * and deleting what the run made (wiki features/vm-worlds). */
export async function hetznerApi(connection: ResolvedWorldProviderConnection, method: string, route: string): Promise<any> {
  const response = await fetch(`https://api.hetzner.cloud/v1${route}`, { method, headers: { authorization: `Bearer ${connection.apiKey}` } });
  if (!response.ok && response.status !== 404) throw new Error(`Hetzner ${method} ${route}: ${response.status}`);
  return response.status === 204 ? {} : response.json().catch(() => ({}));
}

export type HetznerInventory = { firewalls: number; keys: number; snapshot?: string };

export async function hetznerInventory(connection: ResolvedWorldProviderConnection): Promise<HetznerInventory> {
  const { vmProvisionVersion } = await import('../../src/world/vm/provision.js');
  const firewalls = (await hetznerApi(connection, 'GET', '/firewalls?label_selector=karmaxFirewall%3Dvm')).firewalls ?? [];
  const keys = (await hetznerApi(connection, 'GET', '/ssh_keys?label_selector=karmaxSshKey%3Dno-root-login')).ssh_keys ?? [];
  const images = (await hetznerApi(connection, 'GET', `/images?type=snapshot&label_selector=karmaxImage%3D${vmProvisionVersion()}`)).images ?? [];
  return { firewalls: firewalls.length, keys: keys.length, snapshot: images[0] ? String(images[0].id) : undefined };
}

/** Delete what this run created at project level; keep what existed before it.
 * `builtSnapshot`: this run built the provisioned snapshot itself, so it may
 * delete it; a run that builds none never deletes one (a production project
 * sharing the token may have just built it). */
export async function cleanHetzner(connection: ResolvedWorldProviderConnection, before?: HetznerInventory,
  options: { builtSnapshot?: boolean } = {}): Promise<void> {
  for (const server of (await hetznerApi(connection, 'GET', `/servers?label_selector=karmaxHome%3D${serviceHomeLabel()}`)).servers ?? [])
    await hetznerApi(connection, 'DELETE', `/servers/${server.id}`);
  const { vmProvisionVersion } = await import('../../src/world/vm/provision.js');
  const version = vmProvisionVersion();
  if (options.builtSnapshot)
    for (const builder of (await hetznerApi(connection, 'GET', `/servers?label_selector=karmaxImageBuilder%3D${version}`)).servers ?? [])
      await hetznerApi(connection, 'DELETE', `/servers/${builder.id}`);
  // Volumes of this run's home label: detached once their server is gone.
  for (const volume of (await hetznerApi(connection, 'GET', `/volumes?label_selector=karmaxHome%3D${serviceHomeLabel()}`)).volumes ?? []) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(`https://api.hetzner.cloud/v1/volumes/${volume.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${connection.apiKey}` } });
      if (response.ok || response.status === 404) break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  if (options.builtSnapshot && !before?.snapshot && process.env.KARMAX_LIVE_KEEP_SNAPSHOT !== '1')
    for (const image of (await hetznerApi(connection, 'GET', `/images?type=snapshot&label_selector=karmaxImage%3D${version}`)).images ?? [])
      await hetznerApi(connection, 'DELETE', `/images/${image.id}`);
  if (!before?.firewalls) {
    for (const firewall of (await hetznerApi(connection, 'GET', '/firewalls?label_selector=karmaxFirewall%3Dvm')).firewalls ?? []) {
      // A firewall still applied to a server being deleted refuses deletion for a moment.
      for (let attempt = 0; attempt < 20; attempt++) {
        const response = await fetch(`https://api.hetzner.cloud/v1/firewalls/${firewall.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${connection.apiKey}` } });
        if (response.ok || response.status === 404) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
  if (!before?.keys)
    for (const key of (await hetznerApi(connection, 'GET', '/ssh_keys?label_selector=karmaxSshKey%3Dno-root-login')).ssh_keys ?? [])
      await hetznerApi(connection, 'DELETE', `/ssh_keys/${key.id}`);
}
