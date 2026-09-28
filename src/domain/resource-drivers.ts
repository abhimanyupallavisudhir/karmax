import type { ResourceAttachment, ResourceIsolation, ResourceTarget } from './types.js';

export interface ResourceDriverDefinition {
  id: string;
  label: string;
  dataPlane: 'snapshot' | 'credential';
  targets: ResourceTarget['kind'][];
  isolations: ResourceIsolation[];
  credentialRequired: boolean;
  reviewedPromotion: boolean;
}

const builtins: ResourceDriverDefinition[] = [
  { id: 'volume@1', label: 'Versioned files / model / SQLite', dataPlane: 'snapshot', targets: ['path'], isolations: ['fork'], credentialRequired: false, reviewedPromotion: true },
  { id: 'object-tree@1', label: 'Versioned object tree', dataPlane: 'snapshot', targets: ['path'], isolations: ['fork'], credentialRequired: false, reviewedPromotion: true },
  { id: 'secret@1', label: 'Secret', dataPlane: 'credential', targets: ['path', 'environment'], isolations: ['fork'], credentialRequired: true, reviewedPromotion: false },
  { id: 'database@1', label: 'Shared database connection', dataPlane: 'credential', targets: ['service', 'environment'], isolations: ['shared'], credentialRequired: true, reviewedPromotion: false },
  { id: 'service@1', label: 'External service credential', dataPlane: 'credential', targets: ['service', 'environment'], isolations: ['shared'], credentialRequired: true, reviewedPromotion: false },
];

// Freeze the arrays too: a shallow freeze let a caller that edited a catalog
// entry's `targets` change what validation accepts for every later request.
const frozen = (driver: ResourceDriverDefinition): ResourceDriverDefinition => Object.freeze({ ...driver,
  targets: Object.freeze([...driver.targets]) as ResourceTarget['kind'][],
  isolations: Object.freeze([...driver.isolations]) as ResourceIsolation[] });
export const RESOURCE_DRIVERS = new Map(builtins.map((driver) => [driver.id, frozen(driver)]));
export function resourceDriver(id: string): ResourceDriverDefinition | undefined { return RESOURCE_DRIVERS.get(id); }
export function resourceDriverCatalog(): ResourceDriverDefinition[] {
  return [...RESOURCE_DRIVERS.values()].map((driver) => ({ ...driver, targets: [...driver.targets], isolations: [...driver.isolations] }));
}
export function snapshotResource(value: ResourceAttachment | string): boolean {
  return resourceDriver(typeof value === 'string' ? value : value.driver)?.dataPlane === 'snapshot';
}
export function credentialResource(value: ResourceAttachment | string): boolean {
  return resourceDriver(typeof value === 'string' ? value : value.driver)?.dataPlane === 'credential';
}
