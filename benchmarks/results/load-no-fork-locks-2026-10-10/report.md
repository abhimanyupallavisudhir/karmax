# Load test no-fork-locks — 237f4bf2f3

Run `loadtest-20261010T093424Z-ee74`, 237f4bf2 (`237f4bf2f3bf35616054796cc6898c17bc4c6163`), eu-central-1: system under test c7i.xlarge, worlds and load generator c7i.2xlarge, 50 ms added to every E2B round trip, 300 s held per step. Cost **$0.493**. Gateway processes seen: 1, worker processes seen: 1 (more than one means a restart).

**First wall: step 7, 128 tenants / 192 people / 670 open tasks** — turn overhead p50 176358 ms.

Steady window of each step (after its new tenants were set up). Latencies are as the load generator saw them through the HTTPS edge.

| step | tenants (people) | open tasks | running wf | req/s | API ms p50/p95/p99 | errors % | event lag ms p50/p95/p99 | turn overhead s p50/p95 | gateway heap / RSS MB | worker heap / RSS MB | worker loop p99 ms | app mem MB | host CPU % mean/max | PG conns | advisory waiters max | advisory wait max ms | Temporal backlog age ms | schedule-to-start p95 ms wf / act |
|---:|---:|---:|---:|---:|---|---:|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 1 | 4 (6) | 10 | 10 | 1.2 | 15 / 67 / 589 | 0 | 7 / 15 / 20 | 1.6 / 1.8 | 142 / 426 | 102 / 396 | 14.4 | 788 | 8 / 59 | 52 | 0 | 0 | 0 | 47.5 / 47.5 |
| 2 | 8 (12) | 33 | 32 | 1.9 | 14 / 63 / 562 | 0 | 7 / 12 / 18 | 1.5 / 1.7 | 142 / 431 | 104 / 418 | 14.2 | 807 | 11 / 42 | 53 | 0 | 0 | 0 | 47.5 / 47.5 |
| 3 | 16 (24) | 60 | 60 | 4.1 | 14 / 62 / 553 | 0 | 7 / 14 / 21 | 1.6 / 1.9 | 145 / 438 | 115 / 467 | 18.6 | 877 | 19 / 54 | 59 | 0 | 0 | 0 | 47.5 / 47.5 |
| 4 | 32 (48) | 136 | 136 | 7.9 | 15 / 76 / 555 | 0 | 7 / 19 / 36 | 1.9 / 2.6 | 152 / 459 | 126 / 548 | 19.9 | 1005 | 33 / 54 | 60 | 0 | 0 | 0 | 47.7 / 47.6 |
| 5 | 64 (96) | 265 | 266 | 15.8 | 22 / 146 / 676 | 0 | 11 / 46 / 82 | 3.3 / 5.5 | 190 / 503 | 183 / 732 | 35.4 | 1247 | 64 / 90 | 62 | 0 | 0 | 0 | 49 / 49 |
| 6 | 96 (144) | 465 | 474 | 25.8 | 47 / 303 / 1001 | 0 | 683 / 1115 / 1461 | 40.1 / 51.1 | 202 / 514 | 218 / 824 | 67.6 | 1394 | 92 / 96 | 66 | 0 | 0 | 83 | 240.1 / 81.8 |
| 7 | 128 (192) | 670 | 684 | 43.8 | 46 / 315 / 1147 | 0.12 | 29 / 205 / 1043 | 176.4 / 260.9 | 206 / 522 | 202 / 924 | 67 | 1586 | 90 / 96 | 67 | 0 | 0 | 25977 | 10000 / 48.1 |

### Busiest statements at step 7 (karmax database, pg_stat_statements)

| calls/s | share | mean ms | statement |
|---:|---:|---:|---|
| 571.8 | 20.3 % | 0.01 | `SELECT v FROM kv WHERE k = $1` |
| 230.4 | 8.2 % | 0.02 | `SELECT "expiresAt" FROM session WHERE id=$1 AND "userId"=$2` |
| 153.7 | 5.4 % | 0.02 | `SELECT json FROM scoped_tokens WHERE "tokenHash"=$1 AND "revokedAt" IS NULL AND "expiresAt">$2` |
| 106.8 | 3.8 % | 0.01 | `SELECT "organizationId" FROM projects WHERE id=$1` |
| 104.5 | 3.7 % | 0 | `BEGIN` |
| 104.4 | 3.7 % | 0 | `COMMIT` |
| 93.1 | 3.3 % | 0.02 | `SELECT * FROM projects WHERE id = $1` |
| 83.5 | 3 % | 0.02 | `SELECT "projectId" FROM tasks WHERE id=$1` |
| 83.1 | 2.9 % | 0.3 | `SELECT karmax_seq_watermark($1, $2) AS w` |
| 77.7 | 2.8 % | 0.09 | `SELECT $9 AS kind, CAST(id AS TEXT) AS a, CAST(COALESCE("organizationId", $10) AS TEXT) AS b, CAST($11 AS TEXT) AS c FROM projects WHERE id = $1 UNION ALL SELEC` |
| 59.4 | 2.1 % | 0.01 | `SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3` |
| 58.2 | 2.1 % | 0.04 | `SELECT id, num, "projectId", "listId", title, workflow, "executionWorkflow", "workflowVersion", params, "createdAt", ord, "parentTaskId", "createdBy", assignee,` |

### gateway CPU by module at step 7 (3 profile(s), 61 s sampled)

| module | share |
|---|---:|
| `(runtime)` | 31.7 % |
| `(idle)` | 24.5 % |
| `src/store/postgres-sql.mjs` | 4.1 % |
| `pg` | 3.5 % |
| `(garbage collector)` | 3.4 % |
| `(program)` | 2.4 % |
| `node:internal/async_hooks` | 2.1 % |
| `pg-pool` | 2 % |
| `node:inspector` | 1.8 % |
| `pg-protocol` | 1.7 % |
| `src/store/db.ts` | 1.6 % |
| `src/store/async-sql.ts` | 1.6 % |
| `src/gateway/server.ts` | 1.5 % |
| `node:internal/async_local_storage/async_hooks` | 1.5 % |
| `@better-auth/core` | 1 % |

### worker CPU by module at step 7 (3 profile(s), 61 s sampled)

| module | share |
|---|---:|
| `(runtime)` | 43.7 % |
| `(idle)` | 20.6 % |
| `(program)` | 3.7 % |
| `(garbage collector)` | 3.4 % |
| `pg` | 2.1 % |
| `rxjs` | 1.9 % |
| `src/store/postgres-sql.mjs` | 1.8 % |
| `node:internal/async_hooks` | 1.7 % |
| `node:inspector` | 1.5 % |
| `@temporalio/common` | 1.5 % |
| `src/store/db.ts` | 1.2 % |
| `@temporalio/worker` | 1.1 % |
| `pg-protocol` | 1 % |
| `node:internal/async_local_storage/async_hooks` | 1 % |
| `pg-pool` | 0.9 % |

<details><summary>Step 1: 4 tenants</summary>

```json
{
 "step": 1,
 "tenants": 4,
 "teams": 1,
 "people": 6,
 "sockets": 12,
 "openTasks": 10,
 "tasksInTurn": 4,
 "tasksAtReview": 6,
 "runningWorkflows": 10,
 "sandboxes": {
  "running": 4,
  "paused": 13
 },
 "setupSeconds": 4,
 "failedSetups": 0,
 "requestsPerSecond": 1.2,
 "requests": 371,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 371,
  "p50": 15,
  "p95": 67,
  "p99": 589,
  "max": 634
 },
 "eventLag": {
  "n": 3722,
  "p50": 7,
  "p95": 15,
  "p99": 20,
  "max": 111
 },
 "turnOverhead": {
  "n": 27,
  "p50": 1568,
  "p95": 1797,
  "p99": 2270,
  "max": 2270
 },
 "firstTurn": {
  "n": 20,
  "p50": 25778,
  "p95": 41458,
  "p99": 41458,
  "max": 41458
 },
 "approveToDone": {
  "n": 7,
  "p50": 214,
  "p95": 309,
  "p99": 309,
  "max": 309
 },
 "cancelToCancelled": {
  "n": 7,
  "p50": 76,
  "p95": 112,
  "p99": 112,
  "max": 112
 },
 "wsConnect": {
  "n": 6,
  "p50": 30,
  "p95": 35,
  "p99": 35,
  "max": 35
 },
 "tenantSetup": {
  "n": 4,
  "p50": 4209,
  "p95": 4392,
  "p99": 4392,
  "max": 4392
 },
 "tasks": {
  "created": 24,
  "turns": 27,
  "done": 7,
  "cancelled": 7,
  "failed": 0,
  "stuck": 0,
  "followUps": 7,
  "resourceSaves": 8
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 3728
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 8,
   "p50": 589,
   "p95": 634,
   "p99": 634,
   "max": 634
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 24,
   "p50": 66,
   "p95": 84,
   "p99": 137,
   "max": 137
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 21,
   "p50": 36,
   "p95": 45,
   "p99": 51,
   "max": 51
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 54,
   "p50": 15,
   "p95": 24,
   "p99": 25,
   "max": 25
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 42,
   "p50": 17,
   "p95": 21,
   "p99": 32,
   "max": 32
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 42,
   "p50": 17,
   "p95": 21,
   "p99": 30,
   "max": 30
  }
 ],
 "hostCpuPct": {
  "mean": 8,
  "max": 59,
  "steal": 0.1,
  "iowait": 2
 },
 "load1Max": 2.76,
 "hostMemAvailableMinMb": 5856,
 "containers": {
  "app": {
   "cpuMeanPct": 14,
   "cpuMaxPct": 86,
   "memMaxMb": 788,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 6,
   "cpuMaxPct": 31,
   "memMaxMb": 159,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 6,
   "cpuMaxPct": 25,
   "memMaxMb": 128,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 0,
   "cpuMaxPct": 1,
   "memMaxMb": 22,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 142,
  "heapLimitMb": 662,
  "rssMaxMb": 426,
  "eldP99MaxMs": 12.7,
  "eldMaxMs": 191,
  "cpuMeanPct": 4,
  "gcPct": 0.1,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 102,
  "heapLimitMb": 1276,
  "rssMaxMb": 396,
  "eldP99MaxMs": 14.4,
  "eldMaxMs": 203,
  "cpuMeanPct": 6,
  "gcPct": 0.1,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 52,
  "karmaxConnectionsMax": 13,
  "maxConnections": 100,
  "lockWaitersMax": 0,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 7,
  "karmaxCommitsPerSecond": 132.5,
  "karmaxDbMb": 14
 },
 "appGauges": {
  "karmax_database_bytes": 14605335,
  "karmax_http_inflight": 1,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 143007368,
  "karmax_heap_used_bytes{heap=\"worker\"}": 105535224,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 444825600,
  "karmax_process_rss_bytes{process=\"worker\"}": 414900224,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021364735,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.021970943,
  "karmax_event_loop_delay_max_seconds": 0.207093759,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 0.0868915540000207,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 0.07317685899997221,
  "karmax_database_pending": 1,
  "karmax_database_connections": 7,
  "karmax_database_waiting": 0
 },
 "authorityChangesPerSecond": {
  "all": 0,
  "scoped": 0
 },
 "topStatements": [
  {
   "perSecond": 23.4,
   "meanMs": 0.01,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 13.4
  },
  {
   "perSecond": 11.9,
   "meanMs": 0.18,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 6.8
  },
  {
   "perSecond": 11.1,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 6.4
  },
  {
   "perSecond": 11.1,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 6.4
  },
  {
   "perSecond": 10,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 5.7
  },
  {
   "perSecond": 7.2,
   "meanMs": 0.01,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 4.1
  },
  {
   "perSecond": 6.9,
   "meanMs": 0.01,
   "query": "SELECT \"expiresAt\" FROM session WHERE id=$1 AND \"userId\"=$2",
   "sharePct": 3.9
  },
  {
   "perSecond": 6.1,
   "meanMs": 0.02,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 3.5
  },
  {
   "perSecond": 5.9,
   "meanMs": 0.01,
   "query": "SELECT handle FROM world_instances WHERE \"worldId\"=$1 AND state!=$2 ORDER BY generation DESC LIMIT $3",
   "sharePct": 3.4
  },
  {
   "perSecond": 4.5,
   "meanMs": 0.01,
   "query": "SELECT json FROM scoped_tokens WHERE \"tokenHash\"=$1 AND \"revokedAt\" IS NULL AND \"expiresAt\">$2",
   "sharePct": 2.6
  },
  {
   "perSecond": 4,
   "meanMs": 0.45,
   "query": "SELECT $2 FROM tasks WHERE id = $1 FOR UPDATE",
   "sharePct": 2.3
  },
  {
   "perSecond": 3.7,
   "meanMs": 0.01,
   "query": "SELECT json FROM settings WHERE \"scopeKey\" = $1 AND workflow = $2",
   "sharePct": 2.1
  }
 ],
 "metricsScrapeMaxMs": 66,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 572,
    "meanMs": 5.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "activity": {
    "count": 503,
    "meanMs": 5,
    "p50Ms": 25,
    "p95Ms": 47.5
   }
  },
  "serverLatency": {
   "persistence_latency": {
    "count": 6847,
    "meanMs": 1.8,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 1092,
    "meanMs": 4.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 1106,
    "meanMs": 4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 1356,
    "meanMs": 4.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 2590,
    "meanMs": 2.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 2589,
    "meanMs": 2.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 1357,
    "meanMs": 8.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_schedule": {
    "count": 2590,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 1075,
    "meanMs": 5.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "workflow_task_attempt": {
    "count": 567,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [],
 "errorSamples": []
}
```
</details>

<details><summary>Step 2: 8 tenants</summary>

```json
{
 "step": 2,
 "tenants": 8,
 "teams": 2,
 "people": 12,
 "sockets": 24,
 "openTasks": 33,
 "tasksInTurn": 5,
 "tasksAtReview": 28,
 "runningWorkflows": 32,
 "sandboxes": {
  "running": 6,
  "paused": 41
 },
 "setupSeconds": 4,
 "failedSetups": 0,
 "requestsPerSecond": 1.9,
 "requests": 571,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 571,
  "p50": 14,
  "p95": 63,
  "p99": 562,
  "max": 629
 },
 "eventLag": {
  "n": 7952,
  "p50": 7,
  "p95": 12,
  "p99": 18,
  "max": 409
 },
 "turnOverhead": {
  "n": 63,
  "p50": 1492,
  "p95": 1712,
  "p99": 1828,
  "max": 1828
 },
 "firstTurn": {
  "n": 42,
  "p50": 25497,
  "p95": 39619,
  "p99": 40426,
  "max": 40426
 },
 "approveToDone": {
  "n": 11,
  "p50": 219,
  "p95": 238,
  "p99": 238,
  "max": 238
 },
 "cancelToCancelled": {
  "n": 7,
  "p50": 71,
  "p95": 108,
  "p99": 108,
  "max": 108
 },
 "wsConnect": {
  "n": 6,
  "p50": 26,
  "p95": 30,
  "p99": 30,
  "max": 30
 },
 "tenantSetup": {
  "n": 4,
  "p50": 3480,
  "p95": 3713,
  "p99": 3713,
  "max": 3713
 },
 "tasks": {
  "created": 41,
  "turns": 63,
  "done": 11,
  "cancelled": 7,
  "failed": 0,
  "stuck": 0,
  "followUps": 24,
  "resourceSaves": 14
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 7958
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 14,
   "p50": 546,
   "p95": 629,
   "p99": 629,
   "max": 629
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 41,
   "p50": 60,
   "p95": 78,
   "p99": 104,
   "max": 104
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 42,
   "p50": 38,
   "p95": 47,
   "p99": 64,
   "max": 64
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 68,
   "p50": 16,
   "p95": 34,
   "p99": 54,
   "max": 54
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 80,
   "p50": 16,
   "p95": 25,
   "p99": 70,
   "max": 70
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 68,
   "p50": 16,
   "p95": 25,
   "p99": 50,
   "max": 50
  }
 ],
 "hostCpuPct": {
  "mean": 11,
  "max": 42,
  "steal": 0,
  "iowait": 3.3
 },
 "load1Max": 1.14,
 "hostMemAvailableMinMb": 5739,
 "containers": {
  "app": {
   "cpuMeanPct": 20,
   "cpuMaxPct": 208,
   "memMaxMb": 807,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 9,
   "cpuMaxPct": 27,
   "memMaxMb": 181,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 7,
   "cpuMaxPct": 35,
   "memMaxMb": 149,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 0,
   "cpuMaxPct": 1,
   "memMaxMb": 27,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 142,
  "heapLimitMb": 662,
  "rssMaxMb": 431,
  "eldP99MaxMs": 15.1,
  "eldMaxMs": 179,
  "cpuMeanPct": 6,
  "gcPct": 0.1,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 104,
  "heapLimitMb": 1276,
  "rssMaxMb": 418,
  "eldP99MaxMs": 14.2,
  "eldMaxMs": 134,
  "cpuMeanPct": 10,
  "gcPct": 0.1,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 53,
  "karmaxConnectionsMax": 14,
  "maxConnections": 100,
  "lockWaitersMax": 0,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 6,
  "karmaxCommitsPerSecond": 235.3,
  "karmaxDbMb": 18
 },
 "appGauges": {
  "karmax_database_bytes": 18365463,
  "karmax_http_inflight": 2,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 150783472,
  "karmax_heap_used_bytes{heap=\"worker\"}": 108908064,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 450912256,
  "karmax_process_rss_bytes{process=\"worker\"}": 437186560,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021266431,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.021479423,
  "karmax_event_loop_delay_max_seconds": 0.207093759,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 0.20128808500046308,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 0.1896854269999623,
  "karmax_database_pending": 1,
  "karmax_database_connections": 8,
  "karmax_database_waiting": 0
 },
 "authorityChangesPerSecond": {
  "all": 0,
  "scoped": 0.01
 },
 "topStatements": [
  {
   "perSecond": 40.7,
   "meanMs": 0.01,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 12.7
  },
  {
   "perSecond": 21.2,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 6.6
  },
  {
   "perSecond": 21.2,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 6.6
  },
  {
   "perSecond": 20.3,
   "meanMs": 0.17,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 6.3
  },
  {
   "perSecond": 16.5,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 5.2
  },
  {
   "perSecond": 14.5,
   "meanMs": 0.01,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 4.5
  },
  {
   "perSecond": 12.6,
   "meanMs": 0.02,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 3.9
  },
  {
   "perSecond": 11.7,
   "meanMs": 0.01,
   "query": "SELECT handle FROM world_instances WHERE \"worldId\"=$1 AND state!=$2 ORDER BY generation DESC LIMIT $3",
   "sharePct": 3.7
  },
  {
   "perSecond": 11.5,
   "meanMs": 0.01,
   "query": "SELECT \"expiresAt\" FROM session WHERE id=$1 AND \"userId\"=$2",
   "sharePct": 3.6
  },
  {
   "perSecond": 8.2,
   "meanMs": 0.46,
   "query": "SELECT $2 FROM tasks WHERE id = $1 FOR UPDATE",
   "sharePct": 2.6
  },
  {
   "perSecond": 6.7,
   "meanMs": 0.01,
   "query": "SELECT json FROM scoped_tokens WHERE \"tokenHash\"=$1 AND \"revokedAt\" IS NULL AND \"expiresAt\">$2",
   "sharePct": 2.1
  },
  {
   "perSecond": 6.4,
   "meanMs": 0.09,
   "query": "INSERT INTO events (\"taskId\", type, ts, payload, origin) VALUES ($1, $2, $3, $4, $5) RETURNING seq",
   "sharePct": 2
  }
 ],
 "metricsScrapeMaxMs": 64,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 1154,
    "meanMs": 5.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "activity": {
    "count": 1016,
    "meanMs": 5.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   }
  },
  "serverLatency": {
   "persistence_latency": {
    "count": 12156,
    "meanMs": 1.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 2201,
    "meanMs": 4.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 2238,
    "meanMs": 4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 2669,
    "meanMs": 4.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 5499,
    "meanMs": 2.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 5494,
    "meanMs": 2.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 2669,
    "meanMs": 8.8,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_schedule": {
    "count": 5494,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 2170,
    "meanMs": 5.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "workflow_task_attempt": {
    "count": 1153,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [],
 "errorSamples": []
}
```
</details>

<details><summary>Step 3: 16 tenants</summary>

```json
{
 "step": 3,
 "tenants": 16,
 "teams": 4,
 "people": 24,
 "sockets": 48,
 "openTasks": 60,
 "tasksInTurn": 11,
 "tasksAtReview": 49,
 "runningWorkflows": 60,
 "sandboxes": {
  "running": 10,
  "paused": 80
 },
 "setupSeconds": 6,
 "failedSetups": 0,
 "requestsPerSecond": 4.1,
 "requests": 1216,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 1216,
  "p50": 14,
  "p95": 62,
  "p99": 553,
  "max": 692
 },
 "eventLag": {
  "n": 15804,
  "p50": 7,
  "p95": 14,
  "p99": 21,
  "max": 155
 },
 "turnOverhead": {
  "n": 118,
  "p50": 1591,
  "p95": 1875,
  "p99": 2045,
  "max": 2055
 },
 "firstTurn": {
  "n": 82,
  "p50": 22857,
  "p95": 38996,
  "p99": 40693,
  "max": 40693
 },
 "approveToDone": {
  "n": 43,
  "p50": 210,
  "p95": 382,
  "p99": 525,
  "max": 525
 },
 "cancelToCancelled": {
  "n": 17,
  "p50": 71,
  "p95": 157,
  "p99": 157,
  "max": 157
 },
 "wsConnect": {
  "n": 6,
  "p50": 32,
  "p95": 38,
  "p99": 38,
  "max": 38
 },
 "tenantSetup": {
  "n": 8,
  "p50": 4003,
  "p95": 6253,
  "p99": 6253,
  "max": 6253
 },
 "tasks": {
  "created": 86,
  "turns": 118,
  "done": 43,
  "cancelled": 17,
  "failed": 0,
  "stuck": 0,
  "followUps": 38,
  "resourceSaves": 27
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 15810
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 27,
   "p50": 545,
   "p95": 672,
   "p99": 692,
   "max": 692
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 86,
   "p50": 61,
   "p95": 78,
   "p99": 127,
   "max": 127
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 98,
   "p50": 36,
   "p95": 60,
   "p99": 114,
   "max": 114
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 158,
   "p50": 16,
   "p95": 32,
   "p99": 42,
   "max": 51
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 158,
   "p50": 16,
   "p95": 25,
   "p99": 41,
   "max": 42
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 167,
   "p50": 15,
   "p95": 24,
   "p99": 38,
   "max": 44
  }
 ],
 "hostCpuPct": {
  "mean": 19,
  "max": 54,
  "steal": 0.1,
  "iowait": 3.8
 },
 "load1Max": 1.04,
 "hostMemAvailableMinMb": 5589,
 "containers": {
  "app": {
   "cpuMeanPct": 36,
   "cpuMaxPct": 97,
   "memMaxMb": 877,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 19,
   "cpuMaxPct": 57,
   "memMaxMb": 209,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 15,
   "cpuMaxPct": 55,
   "memMaxMb": 165,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 1,
   "cpuMaxPct": 2,
   "memMaxMb": 35,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 145,
  "heapLimitMb": 662,
  "rssMaxMb": 438,
  "eldP99MaxMs": 13.6,
  "eldMaxMs": 202,
  "cpuMeanPct": 9,
  "gcPct": 0.2,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 115,
  "heapLimitMb": 1276,
  "rssMaxMb": 467,
  "eldP99MaxMs": 18.6,
  "eldMaxMs": 157,
  "cpuMeanPct": 19,
  "gcPct": 0.3,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 59,
  "karmaxConnectionsMax": 20,
  "maxConnections": 100,
  "lockWaitersMax": 0,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 17,
  "karmaxCommitsPerSecond": 478.1,
  "karmaxDbMb": 24
 },
 "appGauges": {
  "karmax_database_bytes": 25320471,
  "karmax_http_inflight": 2,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 151462976,
  "karmax_heap_used_bytes{heap=\"worker\"}": 123229528,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 458940416,
  "karmax_process_rss_bytes{process=\"worker\"}": 490184704,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021250047,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.021528575,
  "karmax_event_loop_delay_max_seconds": 0.213778431,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 0.7227423240003311,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 0.4812389719996448,
  "karmax_database_pending": 1,
  "karmax_database_connections": 8,
  "karmax_database_waiting": 0
 },
 "authorityChangesPerSecond": {
  "all": 0,
  "scoped": 0
 },
 "topStatements": [
  {
   "perSecond": 87.7,
   "meanMs": 0.01,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 13.5
  },
  {
   "perSecond": 42.7,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 6.6
  },
  {
   "perSecond": 42.7,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 6.6
  },
  {
   "perSecond": 36.4,
   "meanMs": 0.17,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 5.6
  },
  {
   "perSecond": 29.3,
   "meanMs": 0.01,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 4.5
  },
  {
   "perSecond": 28.7,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 4.4
  },
  {
   "perSecond": 26.5,
   "meanMs": 0.03,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 4.1
  },
  {
   "perSecond": 24.4,
   "meanMs": 0.01,
   "query": "SELECT \"expiresAt\" FROM session WHERE id=$1 AND \"userId\"=$2",
   "sharePct": 3.7
  },
  {
   "perSecond": 24.4,
   "meanMs": 0.01,
   "query": "SELECT handle FROM world_instances WHERE \"worldId\"=$1 AND state!=$2 ORDER BY generation DESC LIMIT $3",
   "sharePct": 3.7
  },
  {
   "perSecond": 16.7,
   "meanMs": 0.46,
   "query": "SELECT $2 FROM tasks WHERE id = $1 FOR UPDATE",
   "sharePct": 2.6
  },
  {
   "perSecond": 14.8,
   "meanMs": 0.01,
   "query": "SELECT json FROM scoped_tokens WHERE \"tokenHash\"=$1 AND \"revokedAt\" IS NULL AND \"expiresAt\">$2",
   "sharePct": 2.3
  },
  {
   "perSecond": 13,
   "meanMs": 0.09,
   "query": "INSERT INTO events (\"taskId\", type, ts, payload, origin) VALUES ($1, $2, $3, $4, $5) RETURNING seq",
   "sharePct": 2
  }
 ],
 "metricsScrapeMaxMs": 78,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 2457,
    "meanMs": 5.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "activity": {
    "count": 2164,
    "meanMs": 6.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 1,
    "meanMs": 6.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "persistence_latency": {
    "count": 23997,
    "meanMs": 2.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 4698,
    "meanMs": 4.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 4749,
    "meanMs": 4.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 5714,
    "meanMs": 4.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 11682,
    "meanMs": 2.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 11699,
    "meanMs": 2.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 5714,
    "meanMs": 9.8,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_schedule": {
    "count": 11699,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 4621,
    "meanMs": 6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "workflow_task_attempt": {
    "count": 2470,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [],
 "errorSamples": []
}
```
</details>

<details><summary>Step 4: 32 tenants</summary>

```json
{
 "step": 4,
 "tenants": 32,
 "teams": 8,
 "people": 48,
 "sockets": 96,
 "openTasks": 136,
 "tasksInTurn": 20,
 "tasksAtReview": 116,
 "runningWorkflows": 136,
 "sandboxes": {
  "running": 21,
  "paused": 184
 },
 "setupSeconds": 14,
 "failedSetups": 0,
 "requestsPerSecond": 7.9,
 "requests": 2376,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 2376,
  "p50": 15,
  "p95": 76,
  "p99": 555,
  "max": 752
 },
 "eventLag": {
  "n": 30054,
  "p50": 7,
  "p95": 19,
  "p99": 36,
  "max": 227
 },
 "turnOverhead": {
  "n": 240,
  "p50": 1922,
  "p95": 2592,
  "p99": 3821,
  "max": 4189
 },
 "firstTurn": {
  "n": 164,
  "p50": 25485,
  "p95": 40585,
  "p99": 41742,
  "max": 43701
 },
 "approveToDone": {
  "n": 54,
  "p50": 241,
  "p95": 637,
  "p99": 648,
  "max": 648
 },
 "cancelToCancelled": {
  "n": 38,
  "p50": 73,
  "p95": 135,
  "p99": 165,
  "max": 165
 },
 "wsConnect": {
  "n": 6,
  "p50": 26,
  "p95": 35,
  "p99": 35,
  "max": 35
 },
 "tenantSetup": {
  "n": 16,
  "p50": 5061,
  "p95": 7951,
  "p99": 7951,
  "max": 7951
 },
 "tasks": {
  "created": 163,
  "turns": 240,
  "done": 54,
  "cancelled": 38,
  "failed": 0,
  "stuck": 0,
  "followUps": 84,
  "resourceSaves": 48
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 30060
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 48,
   "p50": 555,
   "p95": 713,
   "p99": 752,
   "max": 752
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 163,
   "p50": 70,
   "p95": 124,
   "p99": 203,
   "max": 242
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 176,
   "p50": 38,
   "p95": 73,
   "p99": 131,
   "max": 136
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 335,
   "p50": 17,
   "p95": 38,
   "p99": 59,
   "max": 79
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 318,
   "p50": 17,
   "p95": 37,
   "p99": 60,
   "max": 75
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 318,
   "p50": 17,
   "p95": 37,
   "p99": 68,
   "max": 92
  }
 ],
 "hostCpuPct": {
  "mean": 33,
  "max": 54,
  "steal": 0.1,
  "iowait": 4.6
 },
 "load1Max": 2.65,
 "hostMemAvailableMinMb": 5421,
 "containers": {
  "app": {
   "cpuMeanPct": 61,
   "cpuMaxPct": 153,
   "memMaxMb": 1005,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 37,
   "cpuMaxPct": 79,
   "memMaxMb": 273,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 28,
   "cpuMaxPct": 57,
   "memMaxMb": 176,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 1,
   "cpuMaxPct": 2,
   "memMaxMb": 50,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 152,
  "heapLimitMb": 662,
  "rssMaxMb": 459,
  "eldP99MaxMs": 17.4,
  "eldMaxMs": 223,
  "cpuMeanPct": 17,
  "gcPct": 0.4,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 126,
  "heapLimitMb": 1276,
  "rssMaxMb": 548,
  "eldP99MaxMs": 19.9,
  "eldMaxMs": 187,
  "cpuMeanPct": 36,
  "gcPct": 0.6,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 60,
  "karmaxConnectionsMax": 21,
  "maxConnections": 100,
  "lockWaitersMax": 1,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 25,
  "karmaxCommitsPerSecond": 924.4,
  "karmaxDbMb": 38
 },
 "appGauges": {
  "karmax_database_bytes": 39762967,
  "karmax_http_inflight": 3,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 154916544,
  "karmax_heap_used_bytes{heap=\"worker\"}": 125644304,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 479404032,
  "karmax_process_rss_bytes{process=\"worker\"}": 572641280,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021233663,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.022265855,
  "karmax_event_loop_delay_max_seconds": 0.510132223,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 2.1506815629999534,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 1.2022698020018043,
  "karmax_database_pending": 2,
  "karmax_database_connections": 8,
  "karmax_database_waiting": 0
 },
 "authorityChangesPerSecond": {
  "all": 0,
  "scoped": 0.18
 },
 "topStatements": [
  {
   "perSecond": 168.3,
   "meanMs": 0.01,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 13.7
  },
  {
   "perSecond": 79,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 6.4
  },
  {
   "perSecond": 79,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 6.4
  },
  {
   "perSecond": 65.3,
   "meanMs": 0.18,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 5.3
  },
  {
   "perSecond": 57.1,
   "meanMs": 0.01,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 4.6
  },
  {
   "perSecond": 50.3,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 4.1
  },
  {
   "perSecond": 49.1,
   "meanMs": 0.03,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 4
  },
  {
   "perSecond": 48.3,
   "meanMs": 0.02,
   "query": "SELECT \"expiresAt\" FROM session WHERE id=$1 AND \"userId\"=$2",
   "sharePct": 3.9
  },
  {
   "perSecond": 46.3,
   "meanMs": 0.01,
   "query": "SELECT handle FROM world_instances WHERE \"worldId\"=$1 AND state!=$2 ORDER BY generation DESC LIMIT $3",
   "sharePct": 3.8
  },
  {
   "perSecond": 31.4,
   "meanMs": 0.56,
   "query": "SELECT $2 FROM tasks WHERE id = $1 FOR UPDATE",
   "sharePct": 2.6
  },
  {
   "perSecond": 29.1,
   "meanMs": 0.01,
   "query": "SELECT json FROM scoped_tokens WHERE \"tokenHash\"=$1 AND \"revokedAt\" IS NULL AND \"expiresAt\">$2",
   "sharePct": 2.4
  },
  {
   "perSecond": 24.6,
   "meanMs": 0.1,
   "query": "INSERT INTO events (\"taskId\", type, ts, payload, origin) VALUES ($1, $2, $3, $4, $5) RETURNING seq",
   "sharePct": 2
  }
 ],
 "metricsScrapeMaxMs": 90,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 4574,
    "meanMs": 8.4,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "activity": {
    "count": 4026,
    "meanMs": 8.9,
    "p50Ms": 25.1,
    "p95Ms": 47.6
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 1,
    "meanMs": 14.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "persistence_latency": {
    "count": 43634,
    "meanMs": 2.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 8768,
    "meanMs": 5.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 8860,
    "meanMs": 5,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 10653,
    "meanMs": 5.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 21916,
    "meanMs": 3.5,
    "p50Ms": 25,
    "p95Ms": 47.6
   },
   "task_latency_processing": {
    "count": 21889,
    "meanMs": 2.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 10653,
    "meanMs": 12.4,
    "p50Ms": 25.2,
    "p95Ms": 48
   },
   "task_latency_schedule": {
    "count": 21889,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 8600,
    "meanMs": 8.6,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "workflow_task_attempt": {
    "count": 4560,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [],
 "errorSamples": []
}
```
</details>

<details><summary>Step 5: 64 tenants</summary>

```json
{
 "step": 5,
 "tenants": 64,
 "teams": 16,
 "people": 96,
 "sockets": 192,
 "openTasks": 265,
 "tasksInTurn": 47,
 "tasksAtReview": 218,
 "runningWorkflows": 266,
 "sandboxes": {
  "running": 48,
  "paused": 366
 },
 "setupSeconds": 34,
 "failedSetups": 0,
 "requestsPerSecond": 15.8,
 "requests": 4747,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 4747,
  "p50": 22,
  "p95": 146,
  "p99": 676,
  "max": 1417
 },
 "eventLag": {
  "n": 58916,
  "p50": 11,
  "p95": 46,
  "p99": 82,
  "max": 351
 },
 "turnOverhead": {
  "n": 479,
  "p50": 3286,
  "p95": 5519,
  "p99": 6883,
  "max": 7406
 },
 "firstTurn": {
  "n": 302,
  "p50": 28935,
  "p95": 42939,
  "p99": 44547,
  "max": 45640
 },
 "approveToDone": {
  "n": 114,
  "p50": 438,
  "p95": 964,
  "p99": 1188,
  "max": 1426
 },
 "cancelToCancelled": {
  "n": 75,
  "p50": 143,
  "p95": 459,
  "p99": 813,
  "max": 813
 },
 "wsConnect": {
  "n": 6,
  "p50": 24,
  "p95": 38,
  "p99": 38,
  "max": 38
 },
 "tenantSetup": {
  "n": 32,
  "p50": 7412,
  "p95": 11017,
  "p99": 11532,
  "max": 11532
 },
 "tasks": {
  "created": 295,
  "turns": 479,
  "done": 114,
  "cancelled": 75,
  "failed": 0,
  "stuck": 0,
  "followUps": 186,
  "resourceSaves": 97
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 58922
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 97,
   "p50": 656,
   "p95": 1105,
   "p99": 1417,
   "max": 1417
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 295,
   "p50": 96,
   "p95": 285,
   "p99": 543,
   "max": 849
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 374,
   "p50": 49,
   "p95": 150,
   "p99": 477,
   "max": 561
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 642,
   "p50": 25,
   "p95": 100,
   "p99": 311,
   "max": 407
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 642,
   "p50": 25,
   "p95": 92,
   "p99": 298,
   "max": 400
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 675,
   "p50": 23,
   "p95": 88,
   "p99": 220,
   "max": 289
  }
 ],
 "hostCpuPct": {
  "mean": 64,
  "max": 90,
  "steal": 0,
  "iowait": 5.1
 },
 "load1Max": 6.02,
 "hostMemAvailableMinMb": 5053,
 "containers": {
  "app": {
   "cpuMeanPct": 119,
   "cpuMaxPct": 215,
   "memMaxMb": 1247,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 72,
   "cpuMaxPct": 129,
   "memMaxMb": 332,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 50,
   "cpuMaxPct": 80,
   "memMaxMb": 198,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 2,
   "cpuMaxPct": 3,
   "memMaxMb": 77,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 190,
  "heapLimitMb": 662,
  "rssMaxMb": 503,
  "eldP99MaxMs": 22.8,
  "eldMaxMs": 304,
  "cpuMeanPct": 30,
  "gcPct": 0.9,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 183,
  "heapLimitMb": 1276,
  "rssMaxMb": 732,
  "eldP99MaxMs": 35.4,
  "eldMaxMs": 257,
  "cpuMeanPct": 69,
  "gcPct": 1.5,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 62,
  "karmaxConnectionsMax": 20,
  "maxConnections": 100,
  "lockWaitersMax": 2,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 69,
  "karmaxCommitsPerSecond": 1777,
  "karmaxDbMb": 66
 },
 "appGauges": {
  "karmax_database_bytes": 68828183,
  "karmax_http_inflight": 5,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 200038192,
  "karmax_heap_used_bytes{heap=\"worker\"}": 195663328,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 527429632,
  "karmax_process_rss_bytes{process=\"worker\"}": 766480384,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021315583,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.025083903,
  "karmax_event_loop_delay_max_seconds": 0.510132223,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 6.834595721000799,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 5.326071993007809,
  "karmax_database_pending": 2,
  "karmax_database_connections": 8,
  "karmax_database_waiting": 0
 },
 "authorityChangesPerSecond": {
  "all": 0,
  "scoped": 0.34
 },
 "topStatements": [
  {
   "perSecond": 325.1,
   "meanMs": 0.01,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 13.8
  },
  {
   "perSecond": 155.3,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 6.6
  },
  {
   "perSecond": 155.3,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 6.6
  },
  {
   "perSecond": 117.3,
   "meanMs": 0.23,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 5
  },
  {
   "perSecond": 106.6,
   "meanMs": 0.02,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 4.5
  },
  {
   "perSecond": 95.8,
   "meanMs": 0.04,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 4.1
  },
  {
   "perSecond": 95.3,
   "meanMs": 0.01,
   "query": "SELECT \"expiresAt\" FROM session WHERE id=$1 AND \"userId\"=$2",
   "sharePct": 4
  },
  {
   "perSecond": 91.4,
   "meanMs": 0.02,
   "query": "SELECT handle FROM world_instances WHERE \"worldId\"=$1 AND state!=$2 ORDER BY generation DESC LIMIT $3",
   "sharePct": 3.9
  },
  {
   "perSecond": 87.3,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 3.7
  },
  {
   "perSecond": 61.2,
   "meanMs": 0.99,
   "query": "SELECT $2 FROM tasks WHERE id = $1 FOR UPDATE",
   "sharePct": 2.6
  },
  {
   "perSecond": 56.9,
   "meanMs": 0.01,
   "query": "SELECT json FROM scoped_tokens WHERE \"tokenHash\"=$1 AND \"revokedAt\" IS NULL AND \"expiresAt\">$2",
   "sharePct": 2.4
  },
  {
   "perSecond": 48.1,
   "meanMs": 0.11,
   "query": "INSERT INTO events (\"taskId\", type, ts, payload, origin) VALUES ($1, $2, $3, $4, $5) RETURNING seq",
   "sharePct": 2
  }
 ],
 "metricsScrapeMaxMs": 189,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 9028,
    "meanMs": 14.6,
    "p50Ms": 25.8,
    "p95Ms": 49
   },
   "activity": {
    "count": 7943,
    "meanMs": 15.4,
    "p50Ms": 25.8,
    "p95Ms": 49
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 61,
    "meanMs": 37.4,
    "p50Ms": 31.1,
    "p95Ms": 90.7
   },
   "persistence_latency": {
    "count": 83793,
    "meanMs": 3.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 17354,
    "meanMs": 8.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 17484,
    "meanMs": 7.9,
    "p50Ms": 25,
    "p95Ms": 47.6
   },
   "task_latency": {
    "count": 20703,
    "meanMs": 7.7,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 43025,
    "meanMs": 5.7,
    "p50Ms": 25.2,
    "p95Ms": 47.9
   },
   "task_latency_processing": {
    "count": 43041,
    "meanMs": 3.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 20703,
    "meanMs": 19.6,
    "p50Ms": 26.2,
    "p95Ms": 49.7
   },
   "task_latency_schedule": {
    "count": 43041,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 16971,
    "meanMs": 15,
    "p50Ms": 25.8,
    "p95Ms": 49
   },
   "workflow_task_attempt": {
    "count": 9030,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [],
 "errorSamples": []
}
```
</details>

<details><summary>Step 6: 96 tenants</summary>

```json
{
 "step": 6,
 "tenants": 96,
 "teams": 24,
 "people": 144,
 "sockets": 288,
 "openTasks": 465,
 "tasksInTurn": 143,
 "tasksAtReview": 316,
 "runningWorkflows": 474,
 "sandboxes": {
  "running": 149,
  "paused": 557
 },
 "setupSeconds": 48,
 "failedSetups": 0,
 "requestsPerSecond": 25.8,
 "requests": 7747,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 1,
 "api": {
  "n": 7747,
  "p50": 47,
  "p95": 303,
  "p99": 1001,
  "max": 2459
 },
 "eventLag": {
  "n": 74020,
  "p50": 683,
  "p95": 1115,
  "p99": 1461,
  "max": 1823
 },
 "turnOverhead": {
  "n": 582,
  "p50": 40069,
  "p95": 51099,
  "p99": 52574,
  "max": 54611
 },
 "firstTurn": {
  "n": 368,
  "p50": 67791,
  "p95": 86105,
  "p99": 90460,
  "max": 94241
 },
 "approveToDone": {
  "n": 134,
  "p50": 11640,
  "p95": 15672,
  "p99": 16742,
  "max": 18388
 },
 "cancelToCancelled": {
  "n": 91,
  "p50": 3016,
  "p95": 5404,
  "p99": 7497,
  "max": 7497
 },
 "wsConnect": {
  "n": 6,
  "p50": 31,
  "p95": 36,
  "p99": 36,
  "max": 36
 },
 "tenantSetup": {
  "n": 32,
  "p50": 10645,
  "p95": 15520,
  "p99": 16552,
  "max": 16552
 },
 "tasks": {
  "created": 388,
  "turns": 582,
  "done": 134,
  "cancelled": 91,
  "failed": 1,
  "stuck": 0,
  "followUps": 252,
  "resourceSaves": 148
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 74026
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 148,
   "p50": 1000,
   "p95": 1808,
   "p99": 2180,
   "max": 2459
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 389,
   "p50": 226,
   "p95": 696,
   "p99": 999,
   "max": 1262
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 480,
   "p50": 129,
   "p95": 418,
   "p99": 758,
   "max": 1056
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 1106,
   "p50": 58,
   "p95": 226,
   "p99": 411,
   "max": 605
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 1104,
   "p50": 56,
   "p95": 226,
   "p99": 467,
   "max": 726
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 1128,
   "p50": 50,
   "p95": 179,
   "p99": 315,
   "max": 613
  }
 ],
 "hostCpuPct": {
  "mean": 92,
  "max": 96,
  "steal": 0.1,
  "iowait": 2.1
 },
 "load1Max": 12.2,
 "hostMemAvailableMinMb": 4727,
 "containers": {
  "app": {
   "cpuMeanPct": 178,
   "cpuMaxPct": 220,
   "memMaxMb": 1394,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 113,
   "cpuMaxPct": 147,
   "memMaxMb": 356,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 72,
   "cpuMaxPct": 91,
   "memMaxMb": 237,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 3,
   "cpuMaxPct": 5,
   "memMaxMb": 104,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 202,
  "heapLimitMb": 662,
  "rssMaxMb": 514,
  "eldP99MaxMs": 39.2,
  "eldMaxMs": 444,
  "cpuMeanPct": 43,
  "gcPct": 1.9,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 218,
  "heapLimitMb": 1276,
  "rssMaxMb": 824,
  "eldP99MaxMs": 67.6,
  "eldMaxMs": 392,
  "cpuMeanPct": 100,
  "gcPct": 3.8,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 66,
  "karmaxConnectionsMax": 21,
  "maxConnections": 100,
  "lockWaitersMax": 1,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 294,
  "karmaxCommitsPerSecond": 2355.2,
  "karmaxDbMb": 98
 },
 "appGauges": {
  "karmax_database_bytes": 102538263,
  "karmax_http_inflight": 18,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 206608792,
  "karmax_heap_used_bytes{heap=\"worker\"}": 233969032,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 538832896,
  "karmax_process_rss_bytes{process=\"worker\"}": 864468992,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021987327,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.028753919,
  "karmax_event_loop_delay_max_seconds": 0.510132223,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 12.321824995002915,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 29.229180582012948,
  "karmax_database_pending": 23,
  "karmax_database_connections": 8,
  "karmax_database_waiting": 15
 },
 "authorityChangesPerSecond": {
  "all": 0,
  "scoped": 0.73
 },
 "topStatements": [
  {
   "perSecond": 471,
   "meanMs": 0.02,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 15.2
  },
  {
   "perSecond": 193.5,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 6.2
  },
  {
   "perSecond": 193.5,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 6.2
  },
  {
   "perSecond": 149.1,
   "meanMs": 0.02,
   "query": "SELECT \"expiresAt\" FROM session WHERE id=$1 AND \"userId\"=$2",
   "sharePct": 4.8
  },
  {
   "perSecond": 140,
   "meanMs": 0.02,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 4.5
  },
  {
   "perSecond": 126,
   "meanMs": 0.41,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 4.1
  },
  {
   "perSecond": 116,
   "meanMs": 0.05,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 3.7
  },
  {
   "perSecond": 106.5,
   "meanMs": 0.02,
   "query": "SELECT handle FROM world_instances WHERE \"worldId\"=$1 AND state!=$2 ORDER BY generation DESC LIMIT $3",
   "sharePct": 3.4
  },
  {
   "perSecond": 91.6,
   "meanMs": 0.02,
   "query": "SELECT json FROM scoped_tokens WHERE \"tokenHash\"=$1 AND \"revokedAt\" IS NULL AND \"expiresAt\">$2",
   "sharePct": 3
  },
  {
   "perSecond": 88.1,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 2.8
  },
  {
   "perSecond": 78.7,
   "meanMs": 1.2,
   "query": "SELECT $2 FROM tasks WHERE id = $1 FOR UPDATE",
   "sharePct": 2.5
  },
  {
   "perSecond": 69.8,
   "meanMs": 0.01,
   "query": "SELECT \"organizationId\" FROM projects WHERE id=$1",
   "sharePct": 2.3
  }
 ],
 "metricsScrapeMaxMs": 603,
 "temporal": {
  "backlogAgeMaxMs": 83,
  "backlogCountMax": 2,
  "scheduleToStart": {
   "workflow": {
    "count": 11345,
    "meanMs": 39.7,
    "p50Ms": 32,
    "p95Ms": 240.1
   },
   "activity": {
    "count": 10021,
    "meanMs": 25.6,
    "p50Ms": 28.6,
    "p95Ms": 81.8
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 2528,
    "meanMs": 89.8,
    "p50Ms": 66.8,
    "p95Ms": 429.7
   },
   "persistence_latency": {
    "count": 122669,
    "meanMs": 5.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 19843,
    "meanMs": 19,
    "p50Ms": 26.2,
    "p95Ms": 49.7
   },
   "task_dispatch_latency": {
    "count": 22132,
    "meanMs": 26.3,
    "p50Ms": 28.1,
    "p95Ms": 88.3
   },
   "task_latency": {
    "count": 26154,
    "meanMs": 15.7,
    "p50Ms": 25.9,
    "p95Ms": 49.2
   },
   "task_latency_load": {
    "count": 56131,
    "meanMs": 7.1,
    "p50Ms": 25.4,
    "p95Ms": 48.3
   },
   "task_latency_processing": {
    "count": 56111,
    "meanMs": 7.8,
    "p50Ms": 25.4,
    "p95Ms": 48.3
   },
   "task_latency_queue": {
    "count": 26154,
    "meanMs": 31.3,
    "p50Ms": 29.5,
    "p95Ms": 86.6
   },
   "task_latency_schedule": {
    "count": 56110,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 21366,
    "meanMs": 33.1,
    "p50Ms": 30.3,
    "p95Ms": 97.4
   },
   "workflow_task_attempt": {
    "count": 11389,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [],
 "errorSamples": [
  {
   "route": "POST /api/projects/:id/tasks",
   "status": 403,
   "detail": "{\"error\":\"invalid or expired token\",\"code\":\"capability_denied\"}"
  }
 ]
}
```
</details>

<details><summary>Step 7: 128 tenants — broke</summary>

```json
{
 "step": 7,
 "tenants": 128,
 "teams": 32,
 "people": 192,
 "sockets": 384,
 "openTasks": 670,
 "tasksInTurn": 342,
 "tasksAtReview": 303,
 "runningWorkflows": 684,
 "sandboxes": {
  "running": 331,
  "paused": 634
 },
 "setupSeconds": 68,
 "failedSetups": 0,
 "requestsPerSecond": 43.8,
 "requests": 13133,
 "errorRatePct": 0.12,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 13133,
  "p50": 46,
  "p95": 315,
  "p99": 1147,
  "max": 3520
 },
 "eventLag": {
  "n": 43138,
  "p50": 29,
  "p95": 205,
  "p99": 1043,
  "max": 1862
 },
 "turnOverhead": {
  "n": 222,
  "p50": 176358,
  "p95": 260895,
  "p99": 275213,
  "max": 281146
 },
 "firstTurn": {
  "n": 136,
  "p50": 219618,
  "p95": 295194,
  "p99": 307673,
  "max": 311164
 },
 "approveToDone": {
  "n": 55,
  "p50": 77810,
  "p95": 145370,
  "p99": 169838,
  "max": 169838
 },
 "cancelToCancelled": {
  "n": 38,
  "p50": 11876,
  "p95": 41108,
  "p99": 57394,
  "max": 57394
 },
 "wsConnect": {
  "n": 6,
  "p50": 317,
  "p95": 350,
  "p99": 350,
  "max": 350
 },
 "tenantSetup": {
  "n": 32,
  "p50": 14949,
  "p95": 23528,
  "p99": 24804,
  "max": 24804
 },
 "tasks": {
  "created": 253,
  "turns": 222,
  "done": 55,
  "cancelled": 38,
  "failed": 0,
  "stuck": 0,
  "followUps": 131,
  "resourceSaves": 195
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 43144
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 195,
   "p50": 1081,
   "p95": 2423,
   "p99": 2968,
   "max": 3520
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 253,
   "p50": 237,
   "p95": 873,
   "p99": 1574,
   "max": 1796
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 229,
   "p50": 122,
   "p95": 482,
   "p99": 1317,
   "max": 1432
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 2042,
   "p50": 63,
   "p95": 351,
   "p99": 940,
   "max": 3150
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 2187,
   "p50": 61,
   "p95": 335,
   "p99": 1813,
   "max": 3250
  },
  {
   "route": "GET /api/tasks/:id/events",
   "n": 2045,
   "p50": 45,
   "p95": 238,
   "p99": 410,
   "max": 734
  }
 ],
 "hostCpuPct": {
  "mean": 90,
  "max": 96,
  "steal": 0.1,
  "iowait": 2.5
 },
 "load1Max": 11.41,
 "hostMemAvailableMinMb": 4601,
 "containers": {
  "app": {
   "cpuMeanPct": 205,
   "cpuMaxPct": 257,
   "memMaxMb": 1586,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 95,
   "cpuMaxPct": 135,
   "memMaxMb": 362,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 54,
   "cpuMaxPct": 80,
   "memMaxMb": 260,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 4,
   "cpuMaxPct": 7,
   "memMaxMb": 134,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 206,
  "heapLimitMb": 662,
  "rssMaxMb": 522,
  "eldP99MaxMs": 40.9,
  "eldMaxMs": 419,
  "cpuMeanPct": 51,
  "gcPct": 2.4,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 202,
  "heapLimitMb": 1276,
  "rssMaxMb": 924,
  "eldP99MaxMs": 67,
  "eldMaxMs": 356,
  "cpuMeanPct": 113,
  "gcPct": 2.4,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 67,
  "karmaxConnectionsMax": 22,
  "maxConnections": 100,
  "lockWaitersMax": 2,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 240,
  "karmaxCommitsPerSecond": 2295.8,
  "karmaxDbMb": 120
 },
 "appGauges": {
  "karmax_database_bytes": 126041111,
  "karmax_http_inflight": 25,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 216105880,
  "karmax_heap_used_bytes{heap=\"worker\"}": 203272712,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 547295232,
  "karmax_process_rss_bytes{process=\"worker\"}": 969326592,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.023003135,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.030883839,
  "karmax_event_loop_delay_max_seconds": 0.510132223,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 18.239143685001455,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 39.747788240000745,
  "karmax_database_pending": 37,
  "karmax_database_connections": 8,
  "karmax_database_waiting": 29
 },
 "authorityChangesPerSecond": {
  "all": 0,
  "scoped": 0.82
 },
 "topStatements": [
  {
   "perSecond": 571.8,
   "meanMs": 0.01,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 20.3
  },
  {
   "perSecond": 230.4,
   "meanMs": 0.02,
   "query": "SELECT \"expiresAt\" FROM session WHERE id=$1 AND \"userId\"=$2",
   "sharePct": 8.2
  },
  {
   "perSecond": 153.7,
   "meanMs": 0.02,
   "query": "SELECT json FROM scoped_tokens WHERE \"tokenHash\"=$1 AND \"revokedAt\" IS NULL AND \"expiresAt\">$2",
   "sharePct": 5.4
  },
  {
   "perSecond": 106.8,
   "meanMs": 0.01,
   "query": "SELECT \"organizationId\" FROM projects WHERE id=$1",
   "sharePct": 3.8
  },
  {
   "perSecond": 104.5,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 3.7
  },
  {
   "perSecond": 104.4,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 3.7
  },
  {
   "perSecond": 93.1,
   "meanMs": 0.02,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 3.3
  },
  {
   "perSecond": 83.5,
   "meanMs": 0.02,
   "query": "SELECT \"projectId\" FROM tasks WHERE id=$1",
   "sharePct": 3
  },
  {
   "perSecond": 83.1,
   "meanMs": 0.3,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 2.9
  },
  {
   "perSecond": 77.7,
   "meanMs": 0.09,
   "query": "SELECT $9 AS kind, CAST(id AS TEXT) AS a, CAST(COALESCE(\"organizationId\", $10) AS TEXT) AS b, CAST($11 AS TEXT) AS c FROM projects WHERE id = $1 UNION ALL SELECT $12, CAST(\"principalId\" AS TEXT), CAST(\"scopeKey\" AS TEXT), CAST(json AS TEXT)",
   "sharePct": 2.8
  },
  {
   "perSecond": 59.4,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 2.1
  },
  {
   "perSecond": 58.2,
   "meanMs": 0.04,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 2.1
  }
 ],
 "metricsScrapeMaxMs": 867,
 "temporal": {
  "backlogAgeMaxMs": 25977,
  "backlogCountMax": 215,
  "scheduleToStart": {
   "workflow": {
    "count": 5992,
    "meanMs": 11755.8,
    "p50Ms": 8361.3,
    "p95Ms": 10000
   },
   "activity": {
    "count": 5436,
    "meanMs": 13.7,
    "p50Ms": 25.3,
    "p95Ms": 48.1
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 5909,
    "meanMs": 11859.6,
    "p50Ms": 8469,
    "p95Ms": 10000
   },
   "persistence_latency": {
    "count": 94946,
    "meanMs": 4.5,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 5700,
    "meanMs": 19.6,
    "p50Ms": 25.5,
    "p95Ms": 48.4
   },
   "task_dispatch_latency": {
    "count": 11685,
    "meanMs": 6035.5,
    "p50Ms": 1853.4,
    "p95Ms": 10000
   },
   "task_latency": {
    "count": 20387,
    "meanMs": 7.2,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "task_latency_load": {
    "count": 36688,
    "meanMs": 4.5,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 36677,
    "meanMs": 4.4,
    "p50Ms": 25.1,
    "p95Ms": 47.6
   },
   "task_latency_queue": {
    "count": 20387,
    "meanMs": 15.9,
    "p50Ms": 25.4,
    "p95Ms": 48.2
   },
   "task_latency_schedule": {
    "count": 36677,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 11428,
    "meanMs": 6170.4,
    "p50Ms": 4326.9,
    "p95Ms": 10000
   },
   "workflow_task_attempt": {
    "count": 5997,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [
  "turn overhead p50 176358 ms"
 ],
 "errorSamples": [
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 500,
   "detail": "{\"error\":\"task task_mv28n6f82166eb5cb1 has no conversation yet\"}"
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 500,
   "detail": "{\"error\":\"task task_mv28nlv00fb2f25466 has no conversation yet\"}"
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 500,
   "detail": "{\"error\":\"task task_mv28npqs2cc2b8d968 has no conversation yet\"}"
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 500,
   "detail": "{\"error\":\"task task_mv28nt1zf3469ee6ed has no conversation yet\"}"
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 500,
   "detail": "{\"error\":\"task task_mv28nvs7ef696a5d95 has no conversation yet\"}"
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 500,
   "detail": "{\"error\":\"task task_mv28o5mq834d73efcd has no conversation yet\"}"
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 500,
   "detail": "{\"error\":\"task task_mv28oju59d2655012a has no conversation yet\"}"
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 500,
   "detail": "{\"error\":\"task task_mv28ofig5831a3b993 has no conversation yet\"}"
  }
 ]
}
```
</details>

## Compared with integrated (`1460e39c6d`)

| step | tenants (people) | open tasks | running wf | req/s | API ms p50/p95/p99 | errors % | event lag ms p50/p95/p99 | turn overhead s p50/p95 | gateway heap / RSS MB | worker heap / RSS MB | worker loop p99 ms | app mem MB | host CPU % mean/max | PG conns | advisory waiters max | advisory wait max ms | Temporal backlog age ms | schedule-to-start p95 ms wf / act |
|---:|---:|---:|---:|---:|---|---:|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 1 | 4 (6) | 10 | 12 | 1.1 | 18 / 67 / 543 | 0 | 8 / 19 / 28 | 1.6 / 2.1 | 142 / 440 | 102 / 402 | 16.5 | 756 | 10 / 61 | 38 | 0 | 0 | 0 | 47.5 / 47.5 |
| 2 | 8 (12) | 25 | 24 | 1.9 | 16 / 67 / 564 | 0 | 7 / 22 / 28 | 1.7 / 2.0 | 140 / 444 | 103 / 418 | 15.3 | 810 | 13 / 49 | 41 | 0 | 0 | 0 | 47.5 / 47.5 |
| 3 | 16 (24) | 52 | 54 | 4.2 | 17 / 68 / 466 | 0 | 7 / 33 / 53 | 1.8 / 2.4 | 150 / 455 | 109 / 477 | 19 | 867 | 22 / 61 | 46 | 0 | 0 | 0 | 47.6 / 47.5 |
| 4 | 32 (48) | 115 | 115 | 7.2 | 18 / 104 / 585 | 0 | 10 / 72 / 115 | 2.3 / 3.2 | 184 / 499 | 129 / 551 | 32.1 | 1014 | 40 / 68 | 40 | 0 | 0 | 0 | 47.7 / 47.5 |
| 5 | 64 (96) | 231 | 235 | 13.6 | 1042 / 3623 / 5329 | 0 | 1396 / 21639 / 28167 | 13.4 / 38.9 | 226 / 565 | 180 / 685 | 41.9 | 1265 | 88 / 93 | 63 | 0 | 0 | 0 | 48.2 / 48.3 |

