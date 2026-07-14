# Plan — git & GitHub configuration (identity, credentials, remotes)

How karmax should model git identity, git/GitHub credentials, multiple accounts,
and remote operations (push, PRs) — for the self-hosted install today and the
cloud install it is becoming. Design only; phases at the end.

---

## 1. What exists today (read first — some of it is surprising)

- **Local plumbing already works with zero config.** Worktrees, branches, and
  merges are pure local git. `ensureIdentity` (`src/world/git.ts:63`) sets
  `user.name karmax` / `user.email karmax@localhost` **only when nothing else
  resolves** (no global/user identity) — on a normal dev machine it is a no-op.
- **karmax already auto-commits — but only as a merge-time backstop.** If a
  worktree is dirty when the authoritative merge runs, `finalizeMergeRepo`
  sweeps it up: `git add -A && git commit -m "karmax: work for <id>"`
  (`src/world/merge.ts:73`). The sweep runs *after* the best-effort
  merge-agent turn ("Prepare branch for merge into <target>",
  `src/workflows/software-dev.ts:1202` → `finalizeMergeActivity` at `:1223`),
  so it fires only when that agent left the tree dirty — forgot to commit,
  judged wrong, or its turn failed outright. §6 replaces the blind sweep with
  a loop-back to the merge agent.
- **karmax never pushes as a side effect of merging.** The only push in the
  codebase is the opt-in PR path (`openGithubPr` → `git push -u origin` +
  `gh pr create`, `src/activities/core.ts:589`), which silently skips when `gh`
  isn't installed/authenticated.
- **All remote auth is inherited from the host.** Git subprocesses run with
  `process.env` + `GIT_TERMINAL_PROMPT=0` (`src/world/git.ts:19`) — whatever
  SSH agent / credential helper / `gh` login the host has, worlds get; anything
  interactive fails fast instead of hanging. There is no karmax-level notion of
  a git or GitHub account.
- **The pieces a real model needs already exist elsewhere:** the vault + broker
  (secrets as handles, resolved JIT, never journaled — SPEC §8.4) and
  config-homes (per-account environment minting with env scrubbing,
  `src/autonomy/config-homes.ts`) are exactly this pattern, built for Claude/
  Codex logins. Git/GitHub is the same shape with different env vars.

## 2. Principles

1. **Three layers, three policies.**
   - *Local plumbing* (worktrees, merges): must always work with zero
     configuration. Already true; nothing here may grow a config dependency.
   - *Identity* (who commits are attributed to, signing): declarative
     configuration, materialized per world.
   - *Remote actions* (fetch over auth, push, PRs): explicit and opt-in, never
     a side effect, credentialed per project.
2. **Committing is the agent's job.** Workflows cannot anticipate what needs
   gitignoring; agents stage/commit deliberately (prompt guidance), and a tree
   still dirty at merge time loops back to the merge agent (§6) rather than
   being blind-swept by machinery.
3. **One enforced setup, two credential sources.** Credentials are vault
   handles resolved JIT by the broker (the cloud mode); on a self-hosted box,
   an unconfigured profile falls through to the host environment (today's
   behavior, as the degenerate case). We do **not** support arbitrary auth
   setups: anything interactive is already rejected by `GIT_TERMINAL_PROMPT=0`,
   and stays rejected. "Enforce the correct setup" then costs nothing extra on
   cloud — there is no host state to fall through to, so a profile is simply
   required for any remote op, and the error says so.
4. **Stateless injection, never global mutation.** Account selection happens
   per subprocess via environment (`GIT_SSH_COMMAND`, `GH_TOKEN`) and per
   worktree via `git config --worktree`. Never `gh auth switch` (mutates global
   state — two concurrent tasks on different accounts would race), never edits
   to `~/.gitconfig` or the shared repo config, never credentials written into
   any config file.

## 3. The model: `GitProfile`

One named object bundles identity + credentials — the git analogue of a
config-home account:

```ts
interface GitProfile {
  name: string;          // 'personal', 'work-acme'
  userName: string;      // git user.name
  userEmail: string;     // git user.email
  signingKey?: string;   // vault handle → SSH signing key (gpg.format=ssh)
  sshKey?: string;       // vault handle → SSH private key for fetch/push
  githubToken?: string;  // vault handle → gh CLI + https pushes (GH_TOKEN)
}
```

- **Registry**: global settings hold the profiles (Store); key material lives
  in the vault as handles — the profile record itself contains no secrets.
- **Selection**: `ProjectConfig.gitProfile?: string` (the project is the unit
  that maps to "which of my accounts owns this repo"). Resolution:
  project profile → global default profile → **host fallback** (no injection;
  exactly today's behavior). Per-repo override inside a multi-repo project is
  deliberately not modeled yet (see §8).
- **Signing is SSH-only** (`gpg.format ssh`): one mechanism, same key type as
  auth, key storable in the vault. GPG is out of scope — anyone who needs it
  has host git config, which the host-fallback tier already honors.

### Hosted refinement

The implemented `GitProfile` remains the correct local/self-hosted model. The
first E2B slice can use that profile's SSH key during trusted clone provisioning,
removes it before the agent starts, and performs every later write through the
host Git broker. Production Karmax Cloud has a stronger trust boundary
(`PLAN-cloud.md`): a GitHub App installation owns repository discovery/API/
webhooks; per-repository SSH credentials own Git transport; and a trusted Git
broker outside the untrusted world holds the write credential. A production
cloud world gets at most read-only SSH clone access. `GitProfile` then supplies
commit identity/signing policy and local compatibility, not a shared write key
mounted into every task sandbox. There is no host fallback in managed cloud.

## 4. Materialization (two hook points, both existing)

**A. World creation** (`worktree.ts`, next to the `ensureIdentity` call):
if a profile resolves, enable `extensions.worktreeConfig` on the source repo
(one-time, additive) and write identity **worktree-scoped**:

```
git config --worktree user.name / user.email
git config --worktree gpg.format ssh + user.signingKey + commit.gpgsign   (if signingKey)
```

The user's own checkout and the shared `.git/config` are never touched with
profile identity; each world can carry a different account. `ensureIdentity`'s
`karmax@localhost` fallback remains for scratch repos and profile-less installs.
With a profile, **every** commit in the world — agent commits, the backstop
sweep, merge commits — carries the profile identity and signature; provenance
stays in the message (`karmax: …`), attribution/account-responsibility in the
identity. (Uniform identity is also what makes signed-commit branch protection
workable at all.)

**B. Remote-op env injection** (the world's `exec()` and the `git()` runner,
plus `openPr`): when the resolved profile has credentials, the broker resolves
handles JIT and injects:

- `sshKey` → key written to a 0600 file under the world's private dir (removed
  with the world) → `GIT_SSH_COMMAND='ssh -i <key> -o IdentitiesOnly=yes'`
- `githubToken` → `GH_TOKEN` (the `gh` CLI honors it over its own config store
  — this *is* the concurrency-safe `gh auth switch`) + a one-shot credential
  helper via `GIT_CONFIG_*` env vars for https remotes.

Purely environmental: nothing lands in any config file, nothing survives the
subprocess, siblings on other accounts are unaffected. This mirrors
`scrubbedEnv()` for Claude/Codex config-homes.

## 5. Remote policy (when to push / open PRs)

Per project, replacing the `openGithubPr` boolean:

```
remote: 'none' | 'push' | 'pr'      // default 'none'
```

- `none` — merges are local; nothing leaves the machine (today's default).
- `push` — after a merge lands on the target, push the target branch.
- `pr` — the existing behavior: push the task branch + `gh pr create`
  (`openGithubPr: true` migrates to this).

Beyond this policy, remote ops happen only when an agent is explicitly asked
(task prompt says "push"/"open a PR") — and then the injected env makes the
right account automatic. karmax itself never pushes outside the declared
policy. The Review stage remains the conceptual PR (SPEC §5.2); `pr` is for
repos whose canonical review lives on GitHub.

## 6. The merge-time sweep → a dirty-worktree loop-back

The sweep predates this design's question: *who decides* what an uncommitted
file is? `git add -A` exercises no judgment — commit-vs-gitignore is exactly
an agent call. Worse, the merge agent's own work (running tests, resolving
conflicts) can generate untracked artifacts *after* the Review gate approved
the diff, and the sweep lands them unseen.

Change: `finalizeMergeRepo` treats a dirty worktree as a **rejection**, the
same shape as conflicts — return `{ merged: false, dirty: <file list> }` —
and the workflow's existing rejection loop-back re-prompts the merge agent:

> Uncommitted changes in: `<files>`. Stage and commit what belongs in this
> change; gitignore (or delete) what doesn't. Then leave the tree clean.

Bounded by the same `MAX_MERGE_ATTEMPTS`; exhaustion (or a merge-agent turn
that fails outright with a dirty tree) escalates to the human/parent like any
other merge failure — no silent sweep on the last attempt either, since that
would blind-commit in exactly the cases nobody could look. The one special
case that keeps auto-completing is the resolved-but-uncommitted merge
(`MERGE_HEAD` present, everything staged, no unresolved paths — the existing
`merge.ts:69` comment): completing that is mechanical, not judgment. The
initial merge prompt also gains one line ("commit what should land; gitignore
what shouldn't") so the loop-back is the exception, not the norm.

This weakens finalize's guarantee from "work always lands" to "work lands or
a human is asked" — the right trade: post-Review, silently committing files
nobody saw is worse than pausing. Applies identically to `merge-only.ts`
(same finalize activity).

## 7. Onboarding & enforcement

- A **Git accounts** card in global settings (same shape as the Workflows
  card): list profiles, add one (name/email + paste-a-PAT + import an SSH key
  into the vault). Import helpers can shell out once to `gh auth token` /
  read `~/.ssh/<key>` — a one-time copy into the vault, not a live dependency
  on host state.
- A **preflight check** (surfaced on the project settings card and as the
  error message when a remote op fails): which tier the project resolves to —
  profile-with-credentials / host-fallback (and whether the host actually has
  non-interactive auth for the repo's remotes) / nothing. On cloud the
  host-fallback tier is empty by construction, so "configure a git profile"
  becomes the single, enforced answer without any cloud-specific code path.

## 8. Deliberately not built

- **Per-repo profile override in multi-repo projects.** A project = an account
  until proven otherwise; adding `repos: [{path, gitProfile}]` later is
  mechanical.
- **`gh auth switch` / multiple gh config dirs.** Superseded by `GH_TOKEN`
  injection.
- **Interactive auth of any kind** (password prompts, browser flows at push
  time). `GIT_TERMINAL_PROMPT=0` already fails these fast; the preflight
  message tells the user to mint a profile instead.
- **GPG signing, .netrc, arbitrary credential helpers.** Host-fallback honors
  whatever the host has; karmax-managed profiles support exactly one setup.

## 9. Phases

All implemented (tests in `tests/git-profiles.test.ts`, `tests/merge.test.ts`,
`tests/multi-repo.test.ts`; the loop-back is exercised by the whole pipeline
suite via the mock merge agent):

0. **Dirty-worktree loop-back (§6)** ✅ — `finalizeMergeRepo` rejects on dirty
   (`MergeResult.dirty`, paths repo-prefixed in multi-repo worlds) instead of
   sweeping; the resolved-but-uncommitted merge (`MERGE_HEAD`, no unresolved
   paths) still auto-completes. software-dev loops the rejection back to the
   merge agent (same `MAX_MERGE_ATTEMPTS` budget as conflicts; exhaustion
   escalates); the initial merge prompt says to commit/gitignore up front. The
   mock agent answers the loop-back by committing — so every pipeline test
   exercises the new path. merge-only has no merge agent: dirty ⇒ failed with
   the file list (rare — nothing runs there but confirm turns).
1. **Profile registry + selection** ✅ — `GitProfile` (`src/domain/types.ts`),
   `GitProfiles` service (`src/autonomy/git-profiles.ts`; registry in the
   store's kv, secrets in the vault under `git:<name>:{ssh,signing,token}`),
   gateway endpoints (`/api/git-profiles` GET/POST/DELETE + `/default` +
   `/preflight`), a **Git accounts** card in Global settings,
   `ProjectConfig.gitProfile` + a project/global `gitProfile` FieldSpec.
2. **Identity materialization** ✅ — `WorldSpec.gitIdentity`; the worktree
   provider writes `git config --worktree` identity (+ `gpg.format ssh`,
   `user.signingKey`, `commit.gpgsign`) via `extensions.worktreeConfig`;
   `ensureIdentity`'s karmax@localhost fallback stays for profile-less worlds.
   Merge commits land on the target (outside worktree config reach), so
   `finalizeMerge` takes the identity and injects it per command with `-c`.
3. **Credential injection + remote policy** ✅ — `GitProfiles.env()` resolves
   JIT via the broker: ssh key → 0600 file + `GIT_SSH_COMMAND`; token →
   `GH_TOKEN` + a `GIT_ASKPASS` shim for https remotes (the shim echoes
   `$GH_TOKEN`; no secret in any file/argv). Injected into agent subprocesses
   (`TurnInput.extraEnv` → `scrubbedEnv`), `openPr`, and the new `pushTarget`
   activity. `remote: none|push|pr` supersedes `openGithubPr` (deprecated,
   still honored via `remotePolicyOf`); 'push' and 'pr' push the target after
   a merge lands (best-effort — the local merge is the deliverable).
4. **Preflight** ✅ — `GitProfiles.preflight()`: resolved tier, identity,
   signing, push auth, gh availability, per-repo origin reachability
   (non-interactive); surfaced as a **Git setup** card in project settings.

Implementation deviations from the sections above (all deliberate):
- Key files are materialized **per profile** under `state/git-profiles/<name>/`
  (0600, refreshed on every profile save), not per world — one file, no
  per-world cleanup, same trust domain as the vault key itself.
- Container worlds don't get worktree-scoped identity yet (worktree provider
  only) — tracked with the other §8 non-goals.

---

**Bottom line**: keep local plumbing config-free; turn the merge-time sweep
into a dirty-worktree loop-back to the merge agent (commit-vs-gitignore is a
judgment call, so it goes to an agent, then a human — never `git add -A`);
make identity and credentials a single named `GitProfile` (registry
global, selection per project, secrets as vault handles); materialize it
statelessly — worktree-scoped git config for identity/signing, per-subprocess
env (`GIT_SSH_COMMAND`, `GH_TOKEN`) for auth — and gate remotes behind an
explicit per-project `none|push|pr` policy. The cloud story is the same model
at the policy layer, but its credential source is an organization repository
connection plus trusted Git broker, with the host-fallback tier empty and no
write credential inside the agent world (`PLAN-cloud.md`).
