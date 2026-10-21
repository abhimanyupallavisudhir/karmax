import type { ResolvedWorldProviderConnection } from '../connections.js';
import type { WorldReferenceKeys } from '../reference-keys.js';
import { AwsDriver } from '../aws.js';
import { FlyDriver } from '../fly.js';
import { GcpDriver } from '../gcp.js';
import { HetznerDriver } from '../hetzner.js';
import { providerName } from '../connections.js';
import { VmWorldProvider, type VmUsageLedger } from './provider.js';

type Resolver = (organizationId: string | undefined, provider: string) => ResolvedWorldProviderConnection | Promise<ResolvedWorldProviderConnection>;

/** Without an organization connection (self-hosted, tests): the installation's environment key. */
function environmentResolver(variable: string, config: () => ResolvedWorldProviderConnection['config']): Resolver {
  return (organizationId, provider) => {
    const apiKey = process.env[variable];
    if (!apiKey) throw new Error(`${providerName(provider)} is not connected for this organization`);
    return { organizationId, provider, apiKey, config: config() };
  };
}

export function flyWorldProvider(resolve?: Resolver, referenceKeys?: WorldReferenceKeys, ledger?: VmUsageLedger): VmWorldProvider {
  return new VmWorldProvider(new FlyDriver(), resolve ?? environmentResolver('FLY_API_TOKEN', () => ({
    region: process.env.KARMAX_FLY_REGION, organization: process.env.KARMAX_FLY_ORG, image: process.env.KARMAX_FLY_IMAGE })), referenceKeys, { ledger });
}

export function hetznerWorldProvider(resolve?: Resolver, referenceKeys?: WorldReferenceKeys, ledger?: VmUsageLedger): VmWorldProvider {
  return new VmWorldProvider(new HetznerDriver(), resolve ?? environmentResolver('HCLOUD_TOKEN', () => ({
    region: process.env.KARMAX_HETZNER_LOCATION, image: process.env.KARMAX_HETZNER_IMAGE })), referenceKeys, { ledger });
}

export function awsWorldProvider(resolve?: Resolver, referenceKeys?: WorldReferenceKeys, ledger?: VmUsageLedger): VmWorldProvider {
  return new VmWorldProvider(new AwsDriver(), resolve ?? environmentResolver('KARMAX_AWS_KEY', () => ({
    region: process.env.KARMAX_AWS_REGION, image: process.env.KARMAX_AWS_IMAGE })), referenceKeys, { ledger });
}

export function gcpWorldProvider(resolve?: Resolver, referenceKeys?: WorldReferenceKeys, ledger?: VmUsageLedger): VmWorldProvider {
  return new VmWorldProvider(new GcpDriver(), resolve ?? environmentResolver('KARMAX_GCP_KEY', () => ({
    region: process.env.KARMAX_GCP_ZONE, image: process.env.KARMAX_GCP_IMAGE })), referenceKeys, { ledger });
}
