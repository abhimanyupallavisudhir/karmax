/** The OpenCode release a remote world runs, paired with this control plane the
 * way Claude Code is paired with the Agent SDK (`claudeCodeVersion`) and Codex
 * with `CODEX_VERSION`. 1.18.35 is the release the live tests ran against: ACP
 * protocol 1 with session resume/fork/list, image prompts, and
 * `export`/`import` keeping session ids (remote-acp.ts). Bump it only with
 * `KARMAX_RUN_LIVE=1 npx vitest run tests/remote-acp-live.test.ts` passing. */
export const OPENCODE_VERSION = '1.18.35';
export const OPENCODE_PACKAGE = `opencode-ai@${OPENCODE_VERSION}`;
