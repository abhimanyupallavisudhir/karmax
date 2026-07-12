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
  worktree is dirty when its merge runs, `finalizeMergeRepo` sweeps it up:
  `git add -A && git commit -m "karmax: work for <id>"` (`src/world/merge.ts:73`).
  Agents are *supposed* to commit deliberately; the sweep exists so uncommitted
  work is never silently dropped at the finish line. `git add -A` respects
  `.gitignore`, and the Review stage surfaces the full changed-file list, so a
  stray un-ignored file is caught where every other unwanted change is caught:
  at review. **Keep this.** The alternative (refuse to merge a dirty world)
  turns a forgotten `git commit` into a wedged pipeline.
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
   gitignoring; agents stage/commit deliberately (prompt guidance), and the
   merge-time sweep stays as data-loss insurance only.
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
  deliberately not modeled yet (see §7).
- **Signing is SSH-only** (`gpg.format ssh`): one mechanism, same key type as
  auth, key storable in the vault. GPG is out of scope — anyone who needs it
  has host git config, which the host-fallback tier already honors.

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

## 6. Onboarding & enforcement

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

## 7. Deliberately not built

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

## 8. Phases

1. **Profile registry + selection** — `GitProfile` type, Store persistence,
   global settings card, `ProjectConfig.gitProfile`, vault import helpers.
   No behavior change (nothing consumes it yet).
2. **Identity materialization** — worktree-scoped identity + SSH signing at
   world creation; uniform identity across agent/backstop/merge commits.
   Tests: two concurrent worlds on different profiles commit under different
   identities; user's checkout config untouched.
3. **Credential injection + remote policy** — broker-resolved
   `GIT_SSH_COMMAND`/`GH_TOKEN` in world exec, merge, and `openPr`;
   `remote` enum supersedes `openGithubPr`. Tests against a local bare repo
   over a constrained ssh stub; `gh` path behind the existing skip-if-absent
   guard.
4. **Preflight + cloud posture** — the doctor check; verify the no-host-state
   path end-to-end (a container world with no `~/.ssh`, no gh login, profile
   only).

---

**Bottom line**: keep local plumbing config-free and the merge-time backstop
commit; make identity and credentials a single named `GitProfile` (registry
global, selection per project, secrets as vault handles); materialize it
statelessly — worktree-scoped git config for identity/signing, per-subprocess
env (`GIT_SSH_COMMAND`, `GH_TOKEN`) for auth — and gate remotes behind an
explicit per-project `none|push|pr` policy. The cloud story is the same model
with the host-fallback tier empty, not a second code path.
