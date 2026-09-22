# Checkpoint encoding isolation — 2026-09-19

Reproduce with `npx tsx benchmarks/checkpoint-capacity.ts`. The fixture encodes one
24 MiB random binary file using a disposable encryption key. It does not read a
real task, contact a provider, or write an object store. Measured in the 2 GiB task
sandbox, with no concurrent test suite or type-check.

| Strategy | Total encoding time | Worst delay beyond a 10 ms timer interval |
| --- | ---: | ---: |
| Prior main-thread serialization/encryption, asynchronous compression | 1,297 ms | 202 ms |
| Isolated checkpoint encoder | 1,412 ms | 16 ms |

This single sample demonstrates event-loop isolation, not faster compression or
production throughput. Worker startup and IPC add overhead; the purpose is to
keep unrelated requests and heartbeats responsive. The whole comparison's peak
RSS was approximately 315 MiB, including both strategies; it is not a per-strategy
memory measurement.

The encoder admits one job and at most 16 queued jobs per process. Queued jobs do
not fetch file contents. One file is sent at a time, and the worker encodes base64
in 48 KiB chunks under zlib backpressure, rather than building an entire base64
JSON string. Its JS heap is capped at 128 MiB. File buffers and the completed
ciphertext are still in memory; the heap cap does not cap external Buffer memory.
Full object-store streaming and gateway/activity process separation remain work
for subsequent changes.

Regression coverage verifies the existing KMX1/AES-GCM envelope and version-1
restore format, binary data across chunk boundaries, deleted and empty files,
source/worker failure cleanup, queue overflow, and full world checkpoint restore.
