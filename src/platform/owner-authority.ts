import { allows, type Capability } from './capabilities.js';

/**
 * Who may manage or read a credential: its owner (wiki features/vault-encryption,
 * features/service-connections).
 *
 * A vault item or app connection belongs to the organization, or to one of its
 * projects (`ownerProjectId`). The organization's vault powers stay organization
 * capabilities — `credential:write` (manage) and `credential:reveal` (read
 * regardless of policy, loosen it, approve requests) — which no project grant
 * can carry (PROJECT_GRANT_CEILING). What a project owns is instead its own
 * project's setting, like its project secrets: whoever may write that project's
 * settings (`project:settings:write`, a Project maintainer) manages it and reads
 * it. Organization authority keeps working over everything.
 */
export type OwnerPower = 'manage' | 'reveal';

export const ORGANIZATION_OWNER_CAPABILITY: Record<OwnerPower, Capability> = {
  manage: 'credential:write',
  reveal: 'credential:reveal',
};

/** What a project's own credentials need, for either power. */
export const PROJECT_OWNER_CAPABILITY: Capability = 'project:settings:write';

/**
 * Whether `caps`, held in `callerProjectId`, give `power` over something owned
 * by `ownerProjectId` (undefined: the organization). Capabilities held in one
 * project say nothing about another project's credentials, so a project owner
 * must match the caller's project; `callerProjectId` undefined means `caps` are
 * organization-wide grants, which hold in every project of it (an
 * Administrator maintains every project, so it also reads their own items).
 */
export function ownerAuthority(caps: Capability[], power: OwnerPower, ownerProjectId: string | undefined,
  callerProjectId: string | undefined): boolean {
  if (allows(caps, ORGANIZATION_OWNER_CAPABILITY[power])) return true;
  return !!ownerProjectId && (callerProjectId === undefined || ownerProjectId === callerProjectId)
    && allows(caps, PROJECT_OWNER_CAPABILITY);
}
