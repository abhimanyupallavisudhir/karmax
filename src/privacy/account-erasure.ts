import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import type { IdentityService } from '../auth/identity.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import { userScope } from '../autonomy/vault-keys.js';
import { GitProfiles, userGitScope } from '../autonomy/git-profiles.js';
import { AppGrants } from '../auth/app-grants.js';

export const closedAccountKey = (id: string) => `account-closed:${id}`;
const caseKey = (id: string) => `account-erasure:${id}`;
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class ErasureError extends Error {
  constructor(message: string, readonly status = 409) { super(message); }
}

export interface ErasureDecision {
  outcome: 'erased' | 'redacted' | 'retained' | 'not-applicable';
  /** A locator/reference and explanation, not a copy of the personal content. */
  evidence: string;
  reviewAt?: number;
  by: string;
  at: number;
}
export interface ErasureCase {
  userId: string;
  startedAt: number;
  startedBy: string;
  state: 'closing' | 'closed' | 'review-complete';
  revision: number;
  steps: string[];
  scope: { organizationIds: string[]; taskIds: string[]; gitProfiles: string[] };
  items: Array<{ id: string; label: string; decision?: ErasureDecision }>;
  closedAt?: number;
  reviewedAt?: number;
  retryRequired?: boolean;
  failedStep?: string;
}

const REVIEW_ITEMS = [
  { id: 'content-discovery', label: 'Search additional copies: free text, attachments, public shares, exports, logs, Temporal histories, checkpoints and worlds. Authorship alone is not a personal-data inventory.' },
  { id: 'legal-records', label: 'Review policy acceptances, billing, audit and security records. Identify any retained records, lawful purpose and review/expiry date.' },
  { id: 'third-parties', label: 'Review MCP/connected services and subprocessors; revoke personal access or notify recipients where required. Do not rewrite GitHub history automatically.' },
  { id: 'backups', label: 'Record backup expiry/beyond-use controls and save this suppression manifest outside the restore set. Reapply it before restoring service; account closure alone does not erase restored content.' },
  { id: 'response', label: 'Record the response to the requester, including exceptions and any further action. Do not store copies of sensitive correspondence here.' },
];

/** Deliberately narrow automation. Shared content is never deleted by user-id
 * cascade or labelled anonymous. Manual decisions remain explicit and auditable. */
export class AccountErasureService {
  constructor(private store: Store, private identity: Pick<IdentityService, 'listUsers' | 'removeUser'>,
    private broker?: CredentialBroker, private gitHome?: string) {}

  async get(userId: string): Promise<ErasureCase | undefined> {
    const raw = await this.store.kvGet(caseKey(userId));
    return raw ? JSON.parse(raw) : undefined;
  }

  async list() {
    const cases = (await this.store.kvEntries('account-erasure:')).map(row => JSON.parse(row.value) as ErasureCase);
    const requests = (await this.store.kvEntries('account-deletion:')).map(row => JSON.parse(row.value));
    return { cases, requests };
  }

  async preview(userId: string) {
    // Exact namespace segments, also safe for the per-user Git key directory.
    try { userGitScope(userId); } catch { throw new ErasureError('invalid user id', 400); }
    const current = await this.get(userId);
    const user = (await this.identity.listUsers()).find(candidate => candidate.id === userId);
    if (!user && !current) throw new ErasureError('user not found', 404);
    const principal = `user:${userId}`;
    const memberships = await this.store.db.prepare('SELECT organizationId, role FROM organization_memberships WHERE userId=? ORDER BY organizationId').all(userId) as Array<{ organizationId: string; role: string }>;
    const related = await this.store.db.prepare(`SELECT id, projectId, json_extract(lastView, '$.status') AS status FROM tasks WHERE
      json_extract(createdBy, '$.userId')=? OR json_extract(assignee, '$.userId')=? OR
      json_extract(delegate, '$.userId')=? OR id IN (SELECT taskId FROM task_subscribers WHERE principalKey=?) OR
      id IN (SELECT taskId FROM confirmation_votes WHERE userId=?) OR
      id IN (SELECT json_extract(json, '$.taskId') FROM human_delegations WHERE json_extract(json, '$.humanUserId')=?)
      ORDER BY id`).all(userId, userId, userId, principal, userId, userId) as Array<{ id: string; projectId: string; status: string | null }>;
    const organizationIds = new Set(memberships.map(row => row.organizationId));
    for (const task of related) {
      const org = await this.store.projectOrganizationAsync(task.projectId);
      if (org) organizationIds.add(org);
    }
    const organizations = [];
    const blockers: string[] = [];
    for (const id of [...organizationIds].sort()) {
      const org = await this.store.getOrganization(id);
      if (!org) continue;
      const members = await this.store.listOrganizationMemberships(id);
      const role = memberships.find(row => row.organizationId === id)?.role;
      organizations.push({ id, kind: org.kind, role: role ?? null });
      if (role === 'owner' && !members.some(member => member.userId !== userId && member.role === 'owner'))
        blockers.push(`Transfer ownership of ${id} to a continuing owner (including personal workspaces), or separately offboard its resources first.`);
    }
    // Do not kill colleagues' work just because the subject subscribed to it.
    // Resolve/reassign linked live work explicitly before removing authority.
    const activeTasks = related.filter(row => !row.status || !['done', 'cancelled'].includes(row.status)).map(row => row.id);
    if (activeTasks.length) blockers.push(`Resolve linked nonterminal tasks before closure: ${activeTasks.join(', ')}`);
    const avatars = await this.store.db.prepare('SELECT id FROM avatars WHERE ownerUserId=? AND deletedAt IS NULL ORDER BY id').all(userId) as Array<{ id: string }>;
    if (avatars.length) blockers.push(`Transfer or remove owned Avatars: ${avatars.map(row => row.id).join(', ')}`);
    const linkedGit: Array<{ organizationId: string; profile: string }> = [];
    for (const org of await this.store.listOrganizations()) {
      for (const profile of await new GitProfiles(this.store, this.broker, this.gitHome, org.id).list()) {
        if (profile.source?.userId === userId) linkedGit.push({ organizationId: org.id, profile: profile.name });
      }
    }
    if (linkedGit.length) blockers.push('Replace organization Git profiles linked to this user before removing their credentials.');
    if (user?.role === 'admin') {
      let continuingAdmin = false;
      for (const other of await this.identity.listUsers())
        if (other.id !== userId && other.role === 'admin' && !(await this.store.kvGet(closedAccountKey(other.id)))) continuingAdmin = true;
      if (!continuingAdmin) blockers.push('Create another installation administrator before closing the last administrator.');
    }
    const profiles = await new GitProfiles(this.store, this.broker, this.gitHome, userGitScope(userId)).list();
    const inventory = { userId, identity: user ? { name: user.name, email: user.email } : null,
      organizations, relatedTaskIds: related.map(row => row.id), activeTasks, ownedAvatarIds: avatars.map(row => row.id), linkedGit,
      gitProfiles: profiles.map(profile => profile.name).sort(), blockers };
    return { ...inventory, fingerprint: hash(inventory), case: current ?? null,
      automatic: ['Revoke account access and delegation', 'Remove authentication identity and sessions',
        'Remove personal Git credentials and locally held GitHub authorizations', 'Remove memberships, grants, inbox and personal preferences'],
      preserved: ['Tasks, conversations, attachments, organization resources and Git history',
        'Billing, policy-acceptance and audit records pending review', 'Backups and external services pending review'],
      warning: 'Closure is not complete erasure or anonymisation. A separate decision is required for every review item.' };
  }

  async close(userId: string, input: { fingerprint?: string; confirmation?: string; exportHandled?: boolean }, actor: string) {
    if (input.confirmation !== `CLOSE ${userId}` || input.exportHandled !== true)
      throw new ErasureError('Confirm the exact user id and that export/identity verification have been handled.', 400);
    // Commit the fence and manifest together. Revalidate ownership under the same
    // cross-process SQL write transaction; never rely on an earlier UI preview.
    let record = await this.store.transaction(async () => {
      // Blockers span users (the last administrator); the account's own
      // writers check the fence under its account lock.
      await this.store.lock('account-closure', `account:${userId}`);
      const preview = await this.preview(userId);
      if (preview.case?.state === 'closed' || preview.case?.state === 'review-complete') return preview.case;
      if (!preview.case) {
        if (preview.fingerprint !== input.fingerprint) throw new ErasureError('Inventory changed; refresh the preview.');
        if (preview.blockers.length) throw new ErasureError(preview.blockers.join('\n'));
      }
      const next: ErasureCase = preview.case ?? { userId, startedAt: Date.now(), startedBy: actor,
        state: 'closing', revision: 1, steps: [],
        scope: { organizationIds: preview.organizations.map(org => org.id), taskIds: preview.relatedTaskIds, gitProfiles: preview.gitProfiles }, items: [
          ...preview.organizations.map(org => ({ id: `organization:${org.id}`,
            label: `Review personal data in ${org.id} (${org.kind}): task text, conversations, files, settings and historical copies. Preserve other members' work; record controller instructions.` })),
          ...REVIEW_ITEMS.map(item => ({ ...item })),
        ] };
      await this.store.kvSet(closedAccountKey(userId), JSON.stringify({ userId, closedAt: next.startedAt }));
      // Remove memberships in the fence transaction, not after external cleanup:
      // another owner must not be allowed to leave while the sole remaining
      // owner is already fenced. A failed SQL cleanup rolls the fence back too.
      if (!next.steps.includes('access-and-preferences')) {
        await this.clearAccess(userId);
        next.steps.push('access-and-preferences');
      }
      await this.store.kvSet(caseKey(userId), JSON.stringify(next));
      await this.store.appendAudit({ principalId: actor, action: 'privacy.account.close-started', detail: { userId } });
      return next;
    });
    if (record.state !== 'closing') return record;
    // External side effects are idempotent; successful steps survive failures.
    // Concurrent retries execute the same narrow cleanup and merge progress.
    let activeStep = 'personal-credentials';
    const step = async (name: string, work: () => Promise<void>) => {
      activeStep = name;
      if ((await this.get(userId))!.steps.includes(name)) return;
      await work();
      await this.store.transaction(async () => {
        await this.store.lock(`account:${userId}`);
        const latest = (await this.get(userId))!;
        if (!latest.steps.includes(name)) latest.steps.push(name);
        latest.revision++;
        await this.store.kvSet(caseKey(userId), JSON.stringify(latest));
      });
    };
    try {
      await step('personal-credentials', async () => {
        if (!this.broker) throw new ErasureError('Credential broker unavailable; account remains fenced. Retry with the broker available.', 503);
        const profiles = new GitProfiles(this.store, this.broker, this.gitHome, userGitScope(userId));
        for (const name of new Set([...record.scope.gitProfiles, ...(await profiles.list()).map(profile => profile.name)]))
          await profiles.delete(name);
        // Exact colon-delimited user namespace: never touch organization App keys.
        for (const handle of await this.broker.listHandles())
          if (handle.startsWith(`github-app:user:${userId}:`) || handle.startsWith(`git:user:${userId}:`))
            await this.broker.deleteHandle(handle);
        for (const row of await this.store.kvEntries(`github-app:user:${userId}:`))
          if (row.key.startsWith(`github-app:user:${userId}:`)) await this.store.kvDelete(row.key);
        // Crypto-shred everything else the user owns in the vault (SS-1).
        await this.broker.destroyScope(userScope(userId));
      });
      await step('access-and-preferences', () => this.clearAccess(userId));
      await step('identity', () => this.identity.removeUser(userId));
      record = await this.store.transaction(async () => {
        await this.store.lock(`account:${userId}`);
        const latest = (await this.get(userId))!;
        // A slower concurrent retry must not undo a later operator review.
        if (latest.state === 'closing') latest.state = 'closed';
        latest.closedAt ??= Date.now(); latest.retryRequired = false; delete latest.failedStep; latest.revision++;
        await this.store.kvDelete(`account-deletion:${userId}`);
        await this.store.kvSet(caseKey(userId), JSON.stringify(latest));
        await this.store.appendAudit({ principalId: actor, action: 'privacy.account.closed', detail: { userId } });
        return latest;
      });
      return record;
    } catch {
      await this.store.transaction(async () => {
        await this.store.lock(`account:${userId}`);
        const latest = (await this.get(userId))!;
        if (latest.state !== 'closing') return;
        latest.retryRequired = true; latest.failedStep = activeStep; latest.revision++;
        await this.store.kvSet(caseKey(userId), JSON.stringify(latest));
      });
      // Do not persist provider errors that could contain credentials or PII.
      throw new ErasureError(`Account access is fenced; cleanup is incomplete at ${activeStep}. Fix the dependency and retry closure. No content was cascaded.`, 503);
    }
  }

  private async clearAccess(userId: string) {
    await this.store.transaction(async () => {
      await this.store.lock(`account:${userId}`);
      const db = this.store.db, principal = `user:${userId}`;
      for (const org of await this.store.listOrganizations(userId)) await this.store.removeOrganizationMembership(org.id, userId);
      await db.prepare('DELETE FROM delivery_outbox WHERE inboxId IN (SELECT id FROM inbox WHERE userId=?)').run(userId);
      for (const table of ['inbox', 'delivery_preferences', 'user_preferences', 'team_memberships', 'github_install_states', 'payment_oauth_states'])
        await db.prepare(`DELETE FROM ${table} WHERE userId=?`).run(userId);
      for (const table of ['project_memberships', 'task_subscribers']) await db.prepare(`DELETE FROM ${table} WHERE principalKey=?`).run(principal);
      await db.prepare('DELETE FROM principal_grants WHERE principalId=?').run(principal);
      await db.prepare('UPDATE preview_leases SET revokedAt=? WHERE createdBy IN (?,?)').run(Date.now(), userId, principal);
      await db.prepare("DELETE FROM human_delegations WHERE json_extract(json, '$.humanUserId')=?").run(userId);
      await db.prepare(`DELETE FROM scoped_tokens WHERE json_extract(json, '$.principal')=? OR
        json_extract(json, '$.humanSubject.userId')=? OR json_extract(json, '$.actor.userId')=?`).run(principal, userId, userId);
      for (const row of await this.store.kvEntries(`hosted:onboarding:${userId}:`))
        if (row.key.startsWith(`hosted:onboarding:${userId}:`)) await this.store.kvDelete(row.key);
      await this.store.kvDelete(`git:profiles:user:${userId}`);
      await this.store.kvDelete(`git:default-profile:user:${userId}`);
      await new AppGrants(this.store).revokeUser(userId); // CLI logins, MCP clients, personal tokens
    });
  }

  async decide(userId: string, input: { revision: number; itemId: string; outcome: ErasureDecision['outcome']; evidence: string; reviewAt?: number }, actor: string) {
    if (!['erased', 'redacted', 'retained', 'not-applicable'].includes(input.outcome)
      || typeof input.evidence !== 'string' || input.evidence.trim().length < 20 || input.evidence.length > 4000)
      throw new ErasureError('Select an outcome and provide 20–4000 characters of evidence/reason, without copying personal content.', 400);
    if ((input.outcome === 'retained' || input.itemId === 'backups')
      && (!Number.isSafeInteger(input.reviewAt) || input.reviewAt! <= Date.now()))
      throw new ErasureError('Retention and backup decisions require a future review/expiry date.', 400);
    if (input.reviewAt !== undefined && (!Number.isSafeInteger(input.reviewAt) || input.reviewAt <= Date.now()))
      throw new ErasureError('reviewAt must be a future epoch-millisecond date.', 400);
    return this.store.transaction(async () => {
      await this.store.lock(`account:${userId}`);
      const record = await this.get(userId);
      if (!record || record.state === 'closing') throw new ErasureError('Close the account successfully before resolving content review.');
      if (record.revision !== input.revision) throw new ErasureError('Case changed; reload before saving.');
      const item = record.items.find(item => item.id === input.itemId);
      if (!item) throw new ErasureError('Unknown review item', 400);
      item.decision = { outcome: input.outcome, evidence: input.evidence.trim(),
        ...(input.reviewAt ? { reviewAt: input.reviewAt } : {}), by: actor, at: Date.now() };
      record.state = 'closed'; delete record.reviewedAt; record.revision++;
      await this.store.kvSet(caseKey(userId), JSON.stringify(record));
      await this.store.appendAudit({ principalId: actor, action: 'privacy.account.decision', detail: { userId, itemId: input.itemId, outcome: input.outcome } });
      return record;
    });
  }

  async complete(userId: string, revision: number, confirmation: string, actor: string) {
    return this.store.transaction(async () => {
      await this.store.lock(`account:${userId}`);
      const record = await this.get(userId);
      if (!record || record.state === 'closing') throw new ErasureError('Account cleanup is incomplete.');
      if (record.revision !== revision) throw new ErasureError('Case changed; reload before completing.');
      if (confirmation !== `REVIEWED ${userId}`) throw new ErasureError('Confirm the exact reviewed user id.', 400);
      if (record.items.some(item => !item.decision || (item.decision.reviewAt != null && item.decision.reviewAt <= Date.now())))
        throw new ErasureError('Every review item needs a documented decision, with no overdue retention review.');
      record.state = 'review-complete'; record.reviewedAt = Date.now(); record.revision++;
      await this.store.kvSet(caseKey(userId), JSON.stringify(record));
      await this.store.appendAudit({ principalId: actor, action: 'privacy.account.review-complete', detail: { userId } });
      return record;
    });
  }
}
