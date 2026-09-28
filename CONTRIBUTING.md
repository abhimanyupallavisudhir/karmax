# Contributing

[CLAUDE.md](CLAUDE.md) is the developer guide: architecture, commands, and the
rules that keep in-flight workflows replayable. [TESTING.md](TESTING.md) covers
the test suite and CI. Design decisions and their rationale live in the project
wiki's `SPEC` page. Security reports follow [SECURITY.md](SECURITY.md), not the
issue tracker.

## Making a change

1. Write a test that fails for the bug or the missing behaviour, then make it
   pass. Integration tests use real Temporal and real git with the mock agent;
   paid live suites run only with `KARMAX_RUN_LIVE=1`.
2. Run `npm run typecheck`, `npm run lint`, and the test files you touched
   (`npx vitest run tests/<file>.test.ts`). Run files that boot Temporal one at a
   time; `npm test` runs the whole suite sequentially by design.
3. Keep workflow and coordinator changes replay-compatible (`patched()`, version
   pins), with a replay test from a history recorded before the change.
4. One change per commit, with an imperative subject; the body says why.

A pull request needs the **typecheck + tests** check to pass.
[.github/CODEOWNERS](.github/CODEOWNERS) names an owner for the code that runs
with production's secrets or handles its keys (workflows, `deploy/`, the
dependency manifests, the vault and key handling). Enforcing it needs a second
reviewer identity (a team or a reviewer account) in that file first: pull
requests are opened as the owner account, and GitHub does not let an author
approve their own, so requiring code owner review with the owner alone would
block every such change.
