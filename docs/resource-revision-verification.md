# Historical resource byte verification

Use `verify_resource_revision` with `project_id`, `resource_id`, `revision_id`,
optional `offset` (default 0), and `limit` (default 100, maximum 1000).
The platform MCP schema uses camelCase; provider-native tools use snake_case.
Already-running agents can use `platform_request` without refreshing tool schemas:

```text
GET /api/projects/PROJECT_ID/resources/RESOURCE_ID/revisions/REVISION_ID/verify?offset=0&limit=100
```

This explicit, read-only operation requires `project:settings:read` in the exact
project's organization and scope. The revision must belong to that project's
resource attachment. Staged resources must first pass their task Review.
Ordinary resource GET/list operations continue to return metadata only.

The server fetches the encrypted manifest and each selected file's chunks through
the snapshot engine and credential broker. It validates the manifest envelope,
attachment, immutable storage placement, totals, paths and root digest, then
streams and decrypts every chunk of each selected file and checks its size and
SHA256. Empty files are checked too. Plaintext, sealed references, object names,
provider errors, ciphertext URLs, credentials and encryption keys stay host-side.
No resource head, revision, source task, lease or storage object is changed.

The response identifies `projectId`, `resourceId`, the actual `revisionId`, and
`storageLocationId` (null means legacy managed storage). After manifest validation,
`rootDigest`, `totalFiles` and `totalBytes` describe the full tree. These alone are
**not byte-verification evidence**. `files` contains the verified page's paths,
byte sizes and SHA256 hashes; `verifiedFiles` and `verifiedBytes` count only that
page's successfully checked files.

- `status: complete`: this call verified every file, starting at offset 0.
- `status: partial`: only returned files were verified. Follow `nextOffset` with
  the same revision. An absent `nextOffset` means the end of the tree, even when
  this call began after offset 0. To establish full coverage across pages, require
  successful contiguous pages from 0 through `totalFiles` with the same revision
  and root digest, and sum their verified file/byte counts against the totals.
- `status: failed`: verification did not finish. `issue: unreadable-or-corrupt`
  deliberately does not distinguish missing objects, invalid ciphertext, hash
  mismatches or unavailable keys from provider exception text. Returned files,
  if any, were checked before the failure; the full tree was not verified.
  `issue: invalid-offset` means the requested offset exceeds the tree length.

Each page checks at most 256 MiB of file plaintext and 1000 files. The existing
engine still loads and validates the whole manifest on each call. A page stopped
by the byte budget reports `issue: byte-limit` and its next offset. If that offset
does not advance, the next file exceeds the single-call budget; this API cannot
verify that file. Do not repeatedly retry the same page or claim complete coverage.
Paths are returned whole and limited by manifest validation to 4096 characters.

There is no download/export endpoint: this capability supplies evidence without
adding a plaintext transport or materializing a historical tree onto a host.
