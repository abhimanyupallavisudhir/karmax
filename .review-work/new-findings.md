Found while integrating (for the Resolution):
- CI-39 fixed 30c535b5,6bd520d6: shared test process leaked vi.mock modules, env vars and stubbed globals between files; duration shards hid it until new files reshuffled them (remote-agent x25, claude-terminal, provider-api-terminal, self.example x3). tests/helpers/file-isolation.ts + tests/module-mock-isolation.test.ts.
- CI-40 fixed e1648e6f: cron trigger test counted runs after one macrotask.
- CI-41 open: project-transfer-http "blocks active builds..." got 409 once on CI (f5842c08); not reproduced.
- WF-30 fixed 5d9c96e0: LT-6 compact turn start published "Starting agent" after the last cancel check (WF-11 regressed).
- AD-30 open MED: local PTY capture can drop a command's last output chunk: node-pty destroys the socket 200 ms after the child exits and boundedExec trusts the exit. Fix: end-of-output marker before accepting the exit status. Seen once in CI (bounded-exec 200 KB test).
- Sub-task items (pending): #396 review 1-12; verification regressions PS-1, PS-3, UI-18/RQ-14, CI-3, LT-17, LT-19, AU-16, AD-18/WF-21, PA-5, PA-12c; confirm-on-merged → cancelled; AuthorizationRequests.resolve claim race; codex-lineage CI failures.
