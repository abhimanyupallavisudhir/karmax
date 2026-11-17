/**
 * A task's human delegation lasts as long as the task and its person's
 * authority: it never lapses by the clock. What bounds it is live: a turn acts
 * with no more than its person can do now (`personGrantNow` in
 * platform/task-authority.ts), and revocation (the task deleted, the person
 * deprovisioned, their account closed) ends it. Until 2026-11-17 delegations
 * lasted 30 days, which stopped every series a month after its person last
 * touched it (#977, #982). An explicit `ttlMs` remains, for tests.
 */
export const DELEGATION_NO_EXPIRY = Number.MAX_SAFE_INTEGER;
