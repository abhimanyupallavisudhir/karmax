import type { ResolvedWorldProviderConnection } from '../connections.js';
import type { WorldReferenceKeys } from '../reference-keys.js';
import { FlyDriver } from '../fly.js';
import { HetznerDriver } from '../hetzner.js';
import { VmWorldProvider } from './provider.js';

type Resolver = (organizationId: string | undefined, provider: string) => ResolvedWorldProviderConnection | Promise<ResolvedWorldProviderConnection>;

/** Without an organization connection (self-hosted, tests): the installation's environment key. */
function environmentResolver(variable: string, config: () => ResolvedWorldProviderConnection['config']): Resolver {
  return (organizationId, provider) => {
    const apiKey = process.env[variable];
    if (!apiKey) throw new Error(`${provider === 'fly' ? 'Fly.io' : 'Hetzner Cloud'} is not connected for this organization`);
    return { organizationId, provider, apiKey, config: config() };
  };
}

export function flyWorldProvider(resolve?: Resolver, referenceKeys?: WorldReferenceKeys): VmWorldProvider {
  return new VmWorldProvider(new FlyDriver(), resolve ?? environmentResolver('FLY_API_TOKEN', () => ({
    region: process.env.KARMAX_FLY_REGION, organization: process.env.KARMAX_FLY_ORG, image: process.env.KARMAX_FLY_IMAGE })), referenceKeys);
}

export function hetznerWorldProvider(resolve?: Resolver, referenceKeys?: WorldReferenceKeys): VmWorldProvider {
  return new VmWorldProvider(new HetznerDriver(), resolve ?? environmentResolver('HCLOUD_TOKEN', () => ({
    region: process.env.KARMAX_HETZNER_LOCATION, image: process.env.KARMAX_HETZNER_IMAGE })), referenceKeys);
}
