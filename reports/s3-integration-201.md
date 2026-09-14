# Amazon S3 integration test — task #201

## Outcome

A real private AWS bucket is connected to the organization and the test project. Creation, fresh-task restoration, editing, renaming, deletion, empty/Unicode/binary/6 MiB files, historical byte verification, discard, read-only enforcement, concurrent promotion, and bounded failure cases passed. The main test resource remains at its nine-file phase-2 head.

AWS bucket: `karmax-s3-integration-20260910-201`, region `eu-north-1`.
Organization storage: `storage_mtw1c43f288af6cbc1`, prefix `karmax-tests`.
Test project: `proj_mtuabs498e1792de45` (S3 storage integration tests).
Main resource: `resource_mtw1pnft6b3d370f01`, `data/s3-test`, write/fork/review, explicitly bound to S3. IAM credentials are restricted to this bucket and stored in the vault; no credentials are included here.

## Sequential round trip (orchestrated by #219)

1. Phase 1 `task_mtuada1z3b097c4478`: seven files / 6,297,131 bytes, all fixture hashes verified; promoted `revision_mtyi1w1m2289128f37`, task done.
2. Phase 2 `task_mtuadaf47600249e5d`: original hashes restored in a fresh world; edits, rename, deletion and additions produced nine files / 6,298,942 bytes. Promoted `revision_mu00k1xuf134c223c9`, parent phase 1; task done.
3. Phase 3 `task_mtuadaos2c4a5dd7d9`: current bytes/hashes, renames, deletions, empty files, Unicode and discard passed; reviewed/confirmed done. The authorized historical API reread all original seven files, returning complete and manifestVerified=true with exact original hashes. Current head unchanged.

Original root digest: `b4a402b3d079c91757c9973512420e18976081c6e9a51edcbe6717f1d9b9fed0`.
Current root digest: `64068f615e77b324db9b0d2c757ddab0ce2c87043cea3a4cad858c0ead08571f`.

Read-only probe: UID 1000, file 0444, directory 0555; overwrite and create returned EACCES, normal promotion rejected. Independent settings GET confirmed unchanged revision/binding. Isolated attachment `resource_mu09rj1054b8b6ed3a` disabled with snapshot retained.

Caveat: ancillary legacy just-do helper `task_mu09s2il51a56b4d96` failed during workflow finalization after its read-only tests passed. It is not reported as a completed task. This is separate from the three completed software-dev phases.

## Additional live checks (2026-09-14, #201)

Isolated resource `resource_mu11mwgs656ea1413f`, `data/s3-isolation-probe`, same S3 location; never edited the main resource.

- Upload traversal `../escape.txt`: rejected (invalid upload path or part).
- First chunk numbered 1: rejected (expected part 0).
- Correct upload ID with wrong project: rejected (resource upload not found).
- Valid 22-byte staged upload: accepted; abort succeeded; reuse rejected. Resource still had no revisions/head afterward.
- Historical verification with wrong project, or a revision belonging to another resource: rejected (resource revision not found).
- Temporary S3 connection with deliberately invalid credentials: real AWS PUT returned 403 InvalidAccessKeyId. Temporary storage location removed afterward.

### Concurrent promotion

Tasks A `task_mu11nakza5bbf04199` and B `task_mu11nb5h9ff6833f64` forked the same empty baseline, each wrote a different nine-byte winner.txt and reached Review. Both promotion calls were issued concurrently.

- B succeeded: `revision_mu11r6dc5af24f6966`; SHA256 `851ca2879d9bed3d9714eaf320a5d7a03fdd5ef1440c5fd79486e7b8a02c5ee9` (writer-B plus LF).
- A rejected: resource baseline changed before publish. Its captured revision `revision_mu11r7une57dc0b85a` remains historical, never head; SHA256 `c8bf0e3943cbe35bcf9978b6f43bd4499934b44cf42501d6e442c856dfea7460` (writer-A plus LF).
- Authorized server-side S3 verification returned complete, manifestVerified=true, one file/nine bytes and exact SHA256 for each revision.
- A's pending changes discarded. Probe disabled. Head remains B. Both workflows await final Review approval because parent lacks review:approve; test assertions passed.

These are project/resource binding checks, not an exhaustive cross-tenant penetration test. Invalid credentials test connection failure; no production outage or deliberate stored-object corruption was introduced.

## Fixes and release evidence

The file picker was folder-only (webkitdirectory), explaining greyed-out individual files. Separate file/folder controls and zero-byte upload support were implemented and released. Snapshot promotion's PostgreSQL refs ambiguity was fixed and released. Historical verification was implemented/released in #242; it decrypts server-side without exposing internal keys.

#219 reported normal reviewed master deployment evidence for latest verified target `2e7f7f5d`: CI 34782812247, Deploy 34784286797, job 103796825185; readiness then Update complete; image `a1b8665a701fb649399e40b31ab63bd87c9ea04e8f550312473b262c75c9f445` matched active runtime. #219's detailed evidence is in its reviewed wiki change `planned/scoped-release-resume/continuation-evidence/MEMORY.md`.

Earlier onboarding fixes on this task branch also cover failed S3 probe cleanup/API discovery, Git pass asynchronous credential lifetime, AgentMail replay deduplication, remote payment helper ES-module execution, and browser-session persistence. Their focused tests were run during implementation. Upload browser/gateway checks, 18 storage/resource tests, real PostgreSQL regression and TypeScript checking passed for the S3 fixes.

Human-required onboarding and release gaps were recorded as side tasks throughout. The retained AWS bucket and main project data remain available for inspection.
