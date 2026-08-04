# E2B transport timeouts are escalated instead of retried

## Bug

When host connectivity to E2B is interrupted, common E2B SDK errors are classified as non-retryable agent failures. Software-development tasks therefore enter `escalated/blocked` even though the failure is transient and no agent or project action can resolve it.

Observed messages include:

```text
The operation was aborted due to timeout
could not export remote codex state: [canceled] Request handshake timed out after 60000ms
```

Tasks 454, 457, 458, 459, and 461 encountered this after a VPN route change. Temporal recorded the affected agent turns as `RETRY_STATE_NON_RETRYABLE_FAILURE`. Task 459 had already committed and verified its implementation, but a timeout while exporting remote Codex state in cleanup masked the successful result and left the task blocked.

## Cause

`isTransportError()` recognizes phrases such as `request timed out` and `operation timed out`, but not E2B's `request handshake timed out` or `operation was aborted due to timeout`. `classifyTurnError()` consequently emits a non-retryable `agent-error` instead of retryable `agent-infra`.

Remote Codex state synchronization also runs in `finally`, so its transport failure can replace the turn's real outcome. E2B world creation retries only three times and escalates if a short network outage outlasts those attempts.

## Expected behavior

- Classify E2B command, PTY, filesystem, state-sync, and sandbox-control transport failures as retryable infrastructure failures using structured error information where available.
- Preserve a successful agent result when best-effort remote state synchronization fails; retry or report synchronization separately.
- Retry sandbox creation with outage-tolerant backoff instead of requiring human intervention for transient connectivity loss.
- Add regression tests for both messages above and for a successful turn followed by a remote-state synchronization timeout.
