# Load test integrated-statements — 1460e39c6d

Run `loadtest-20261010T034400Z-2418`, origin/tavya/task_mup4gto91bfa7de841 (`1460e39c6d1e09a46b5186131a886a34cd9cfe14`), eu-central-1: system under test c7i.xlarge, worlds and load generator c7i.2xlarge, 50 ms added to every E2B round trip, 300 s held per step. Cost **$0.265**. Gateway processes seen: 1, worker processes seen: 1 (more than one means a restart).

**First wall: step 3, 64 tenants / 96 people / 239 open tasks** — API p95 4065 ms; event lag p95 22849 ms; 223 websocket failures or drops of 223 opens.

Steady window of each step (after its new tenants were set up). Latencies are as the load generator saw them through the HTTPS edge.

| step | tenants (people) | open tasks | running wf | req/s | API ms p50/p95/p99 | errors % | event lag ms p50/p95/p99 | turn overhead s p50/p95 | gateway heap / RSS MB | worker heap / RSS MB | worker loop p99 ms | app mem MB | host CPU % mean/max | PG conns | advisory waiters max | advisory wait max ms | Temporal backlog age ms | schedule-to-start p95 ms wf / act |
|---:|---:|---:|---:|---:|---|---:|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 1 | 8 (12) | 24 | 26 | 2.1 | 18 / 79 / 503 | 0 | 8 / 26 / 56 | 1.8 / 6.5 | 140 / 443 | 125 / 424 | 23.1 | 853 | 15 / 73 | 46 | 0 | 0 | 0 | 47.7 / 47.8 |
| 2 | 32 (48) | 105 | 108 | 7.7 | 20 / 134 / 633 | 0 | 11 / 94 / 165 | 2.7 / 3.8 | 181 / 492 | 127 / 527 | 31.2 | 1002 | 45 / 81 | 49 | 0 | 0 | 0 | 47.9 / 47.7 |
| 3 | 64 (96) | 239 | 239 | 13.4 | 1382 / 4065 / 6393 | 0 | 3901 / 22849 / 27705 | 24.4 / 109.6 | 231 / 560 | 181 / 675 | 52.8 | 1303 | 89 / 92 | 49 | 0 | 0 | 0 | 48.2 / 48.4 |

### Busiest statements at step 3 (karmax database, pg_stat_statements)

| calls/s | share | mean ms | statement |
|---:|---:|---:|---|
| 1782.9 | 31 % | 0.02 | `SELECT "organizationId" FROM projects WHERE id=$1` |
| 883.5 | 15.4 % | 0.01 | `SELECT "principalId", "scopeKey", json FROM principal_grants WHERE "principalId" = $1 ORDER BY "scopeKey"` |
| 877.8 | 15.3 % | 0.02 | `SELECT "projectId", principal, role, "joinedAt" FROM project_memberships WHERE "projectId"=$1 ORDER BY "joinedAt"` |
| 273.1 | 4.7 % | 0.27 | `SELECT karmax_seq_watermark($1, $2) AS w` |
| 269.9 | 4.7 % | 0.02 | `SELECT v FROM kv WHERE k = $1` |
| 237.2 | 4.1 % | 0.02 | `SELECT * FROM events WHERE "taskId" = $1 AND type IN ($2, $3, $4) AND seq > $5 AND seq <= $6 ORDER BY seq` |
| 138.8 | 2.4 % | 0.01 | `SELECT json FROM authorization_profiles WHERE "scopeKey" = $1 AND id = $2` |
| 114.2 | 2 % | 0 | `BEGIN` |
| 114.2 | 2 % | 0 | `COMMIT` |
| 79.8 | 1.4 % | 0.03 | `SELECT * FROM projects WHERE id = $1` |
| 67.8 | 1.2 % | 0.05 | `SELECT id, num, "projectId", "listId", title, workflow, "executionWorkflow", "workflowVersion", params, "createdAt", ord, "parentTaskId", "createdBy", assignee,` |
| 66.4 | 1.2 % | 0.02 | `SELECT handle FROM world_instances WHERE "worldId"=$1 AND state!=$2 ORDER BY generation DESC LIMIT $3` |

<details><summary>Step 1: 8 tenants</summary>

```json
{
 "step": 1,
 "tenants": 8,
 "teams": 2,
 "people": 12,
 "sockets": 24,
 "openTasks": 24,
 "tasksInTurn": 5,
 "tasksAtReview": 19,
 "runningWorkflows": 26,
 "sandboxes": {
  "running": 5,
  "paused": 29
 },
 "setupSeconds": 6,
 "failedSetups": 0,
 "requestsPerSecond": 2.1,
 "requests": 639,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 639,
  "p50": 18,
  "p95": 79,
  "p99": 503,
  "max": 3017
 },
 "eventLag": {
  "n": 8266,
  "p50": 8,
  "p95": 26,
  "p99": 56,
  "max": 166
 },
 "turnOverhead": {
  "n": 69,
  "p50": 1779,
  "p95": 6527,
  "p99": 15136,
  "max": 15136
 },
 "firstTurn": {
  "n": 42,
  "p50": 29720,
  "p95": 44386,
  "p99": 50142,
  "max": 50142
 },
 "approveToDone": {
  "n": 10,
  "p50": 238,
  "p95": 410,
  "p99": 410,
  "max": 410
 },
 "cancelToCancelled": {
  "n": 10,
  "p50": 80,
  "p95": 97,
  "p99": 97,
  "max": 97
 },
 "wsConnect": {
  "n": 6,
  "p50": 28,
  "p95": 31,
  "p99": 31,
  "max": 31
 },
 "tenantSetup": {
  "n": 8,
  "p50": 4766,
  "p95": 5519,
  "p99": 5519,
  "max": 5519
 },
 "tasks": {
  "created": 43,
  "turns": 69,
  "done": 10,
  "cancelled": 10,
  "failed": 0,
  "stuck": 0,
  "followUps": 30,
  "resourceSaves": 15
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 8272
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 15,
   "p50": 437,
   "p95": 557,
   "p99": 557,
   "max": 557
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 43,
   "p50": 71,
   "p95": 115,
   "p99": 181,
   "max": 181
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 50,
   "p50": 40,
   "p95": 54,
   "p99": 109,
   "max": 109
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 79,
   "p50": 21,
   "p95": 44,
   "p99": 2045,
   "max": 2045
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 79,
   "p50": 20,
   "p95": 37,
   "p99": 3017,
   "max": 3017
  },
  {
   "route": "GET /api/tasks/:id/events",
   "n": 79,
   "p50": 17,
   "p95": 31,
   "p99": 42,
   "max": 42
  }
 ],
 "hostCpuPct": {
  "mean": 15,
  "max": 73,
  "steal": 0,
  "iowait": 3
 },
 "load1Max": 2.82,
 "hostMemAvailableMinMb": 5741,
 "containers": {
  "app": {
   "cpuMeanPct": 26,
   "cpuMaxPct": 102,
   "memMaxMb": 853,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 14,
   "cpuMaxPct": 44,
   "memMaxMb": 160,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 10,
   "cpuMaxPct": 44,
   "memMaxMb": 145,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 0,
   "cpuMaxPct": 1,
   "memMaxMb": 28,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 140,
  "heapLimitMb": 662,
  "rssMaxMb": 443,
  "eldP99MaxMs": 19.7,
  "eldMaxMs": 204,
  "cpuMeanPct": 7,
  "gcPct": 0.1,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 125,
  "heapLimitMb": 1276,
  "rssMaxMb": 424,
  "eldP99MaxMs": 23.1,
  "eldMaxMs": 231,
  "cpuMeanPct": 15,
  "gcPct": 0.2,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 46,
  "karmaxConnectionsMax": 12,
  "maxConnections": 100,
  "lockWaitersMax": 0,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 9,
  "karmaxCommitsPerSecond": 442,
  "karmaxDbMb": 16
 },
 "appGauges": {
  "karmax_database_bytes": 17079319,
  "karmax_http_inflight": 2,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 151426120,
  "karmax_heap_used_bytes{heap=\"worker\"}": 128573336,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 464977920,
  "karmax_process_rss_bytes{process=\"worker\"}": 445054976,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021299199,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.024821759,
  "karmax_event_loop_delay_max_seconds": 0.206700543,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 0.6349800280000757,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 0.17711584499990474,
  "karmax_database_pending": 4,
  "karmax_database_connections": 4,
  "karmax_database_waiting": 0
 },
 "topStatements": [
  {
   "perSecond": 74.1,
   "meanMs": 0.19,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 13.8
  },
  {
   "perSecond": 53.2,
   "meanMs": 0.02,
   "query": "SELECT * FROM events WHERE \"taskId\" = $1 AND type IN ($2, $3, $4) AND seq > $5 AND seq <= $6 ORDER BY seq",
   "sharePct": 9.9
  },
  {
   "perSecond": 45.3,
   "meanMs": 0.01,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 8.5
  },
  {
   "perSecond": 39.3,
   "meanMs": 0.01,
   "query": "SELECT \"organizationId\" FROM projects WHERE id=$1",
   "sharePct": 7.3
  },
  {
   "perSecond": 23,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 4.3
  },
  {
   "perSecond": 23,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 4.3
  },
  {
   "perSecond": 21,
   "meanMs": 0.01,
   "query": "SELECT json FROM authorization_profiles WHERE \"scopeKey\" = $1 AND id = $2",
   "sharePct": 3.9
  },
  {
   "perSecond": 18.2,
   "meanMs": 0.01,
   "query": "SELECT \"principalId\", \"scopeKey\", json FROM principal_grants WHERE \"principalId\" = $1 ORDER BY \"scopeKey\"",
   "sharePct": 3.4
  },
  {
   "perSecond": 17.4,
   "meanMs": 0.01,
   "query": "SELECT \"projectId\", principal, role, \"joinedAt\" FROM project_memberships WHERE \"projectId\"=$1 ORDER BY \"joinedAt\"",
   "sharePct": 3.2
  },
  {
   "perSecond": 17.2,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 3.2
  },
  {
   "perSecond": 15.2,
   "meanMs": 0.01,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 2.8
  },
  {
   "perSecond": 13.4,
   "meanMs": 0.03,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 2.5
  }
 ],
 "metricsScrapeMaxMs": 75,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 1297,
    "meanMs": 6.6,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "activity": {
    "count": 1146,
    "meanMs": 7.3,
    "p50Ms": 25.2,
    "p95Ms": 47.8
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 14,
    "meanMs": 69,
    "p50Ms": 43.8,
    "p95Ms": 430
   },
   "persistence_latency": {
    "count": 13760,
    "meanMs": 2.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 2481,
    "meanMs": 5,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 2529,
    "meanMs": 5.2,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "task_latency": {
    "count": 2976,
    "meanMs": 4.8,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 5656,
    "meanMs": 2.8,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 5656,
    "meanMs": 2.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 2976,
    "meanMs": 10.1,
    "p50Ms": 25.1,
    "p95Ms": 47.6
   },
   "task_latency_schedule": {
    "count": 5656,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 2443,
    "meanMs": 7,
    "p50Ms": 25.1,
    "p95Ms": 47.8
   },
   "workflow_task_attempt": {
    "count": 1302,
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

<details><summary>Step 2: 32 tenants</summary>

```json
{
 "step": 2,
 "tenants": 32,
 "teams": 8,
 "people": 48,
 "sockets": 96,
 "openTasks": 105,
 "tasksInTurn": 17,
 "tasksAtReview": 88,
 "runningWorkflows": 108,
 "sandboxes": {
  "running": 17,
  "paused": 140
 },
 "setupSeconds": 23,
 "failedSetups": 0,
 "requestsPerSecond": 7.7,
 "requests": 2323,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 2323,
  "p50": 20,
  "p95": 134,
  "p99": 633,
  "max": 1474
 },
 "eventLag": {
  "n": 28992,
  "p50": 11,
  "p95": 94,
  "p99": 165,
  "max": 498
 },
 "turnOverhead": {
  "n": 237,
  "p50": 2696,
  "p95": 3844,
  "p99": 4198,
  "max": 5627
 },
 "firstTurn": {
  "n": 160,
  "p50": 27544,
  "p95": 42588,
  "p99": 43348,
  "max": 44409
 },
 "approveToDone": {
  "n": 45,
  "p50": 346,
  "p95": 877,
  "p99": 1307,
  "max": 1307
 },
 "cancelToCancelled": {
  "n": 42,
  "p50": 110,
  "p95": 294,
  "p99": 498,
  "max": 498
 },
 "wsConnect": {
  "n": 6,
  "p50": 33,
  "p95": 36,
  "p99": 36,
  "max": 36
 },
 "tenantSetup": {
  "n": 24,
  "p50": 6311,
  "p95": 8792,
  "p99": 9861,
  "max": 9861
 },
 "tasks": {
  "created": 152,
  "turns": 237,
  "done": 45,
  "cancelled": 42,
  "failed": 0,
  "stuck": 0,
  "followUps": 85,
  "resourceSaves": 45
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 28998
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 45,
   "p50": 645,
   "p95": 1018,
   "p99": 1474,
   "max": 1474
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 152,
   "p50": 99,
   "p95": 216,
   "p99": 340,
   "max": 491
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 172,
   "p50": 52,
   "p95": 179,
   "p99": 297,
   "max": 306
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 297,
   "p50": 22,
   "p95": 92,
   "p99": 148,
   "max": 169
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 297,
   "p50": 22,
   "p95": 88,
   "p99": 238,
   "max": 539
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 345,
   "p50": 20,
   "p95": 86,
   "p99": 163,
   "max": 245
  }
 ],
 "hostCpuPct": {
  "mean": 45,
  "max": 81,
  "steal": 0.1,
  "iowait": 4
 },
 "load1Max": 3.53,
 "hostMemAvailableMinMb": 5469,
 "containers": {
  "app": {
   "cpuMeanPct": 92,
   "cpuMaxPct": 213,
   "memMaxMb": 1002,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 52,
   "cpuMaxPct": 106,
   "memMaxMb": 211,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 33,
   "cpuMaxPct": 58,
   "memMaxMb": 171,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 1,
   "cpuMaxPct": 2,
   "memMaxMb": 48,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 181,
  "heapLimitMb": 662,
  "rssMaxMb": 492,
  "eldP99MaxMs": 17.6,
  "eldMaxMs": 47,
  "cpuMeanPct": 29,
  "gcPct": 1.2,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 127,
  "heapLimitMb": 1276,
  "rssMaxMb": 527,
  "eldP99MaxMs": 31.2,
  "eldMaxMs": 76,
  "cpuMeanPct": 46,
  "gcPct": 0.8,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 49,
  "karmaxConnectionsMax": 13,
  "maxConnections": 100,
  "lockWaitersMax": 2,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 31,
  "karmaxCommitsPerSecond": 2165.3,
  "karmaxDbMb": 30
 },
 "appGauges": {
  "karmax_database_bytes": 31243287,
  "karmax_http_inflight": 4,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 189434296,
  "karmax_heap_used_bytes{heap=\"worker\"}": 128357960,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 508317696,
  "karmax_process_rss_bytes{process=\"worker\"}": 552787968,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021348351,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.025198591,
  "karmax_event_loop_delay_max_seconds": 0.206700543,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 2.0399421229997503,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 1.2403350739984873,
  "karmax_database_pending": 101,
  "karmax_database_connections": 4,
  "karmax_database_waiting": 97
 },
 "topStatements": [
  {
   "perSecond": 499.6,
   "meanMs": 0.01,
   "query": "SELECT \"organizationId\" FROM projects WHERE id=$1",
   "sharePct": 19.9
  },
  {
   "perSecond": 244.5,
   "meanMs": 0.02,
   "query": "SELECT \"principalId\", \"scopeKey\", json FROM principal_grants WHERE \"principalId\" = $1 ORDER BY \"scopeKey\"",
   "sharePct": 9.7
  },
  {
   "perSecond": 241.6,
   "meanMs": 0.02,
   "query": "SELECT \"projectId\", principal, role, \"joinedAt\" FROM project_memberships WHERE \"projectId\"=$1 ORDER BY \"joinedAt\"",
   "sharePct": 9.6
  },
  {
   "perSecond": 219.9,
   "meanMs": 0.2,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 8.7
  },
  {
   "perSecond": 162.3,
   "meanMs": 0.01,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 6.5
  },
  {
   "perSecond": 161.9,
   "meanMs": 0.02,
   "query": "SELECT * FROM events WHERE \"taskId\" = $1 AND type IN ($2, $3, $4) AND seq > $5 AND seq <= $6 ORDER BY seq",
   "sharePct": 6.4
  },
  {
   "perSecond": 78.6,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 3.1
  },
  {
   "perSecond": 78.6,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 3.1
  },
  {
   "perSecond": 76,
   "meanMs": 0.01,
   "query": "SELECT json FROM authorization_profiles WHERE \"scopeKey\" = $1 AND id = $2",
   "sharePct": 3
  },
  {
   "perSecond": 55.5,
   "meanMs": 0.01,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 2.2
  },
  {
   "perSecond": 48.1,
   "meanMs": 0.03,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 1.9
  },
  {
   "perSecond": 45.8,
   "meanMs": 0.01,
   "query": "SELECT * FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
   "sharePct": 1.8
  }
 ],
 "metricsScrapeMaxMs": 523,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 4403,
    "meanMs": 8.5,
    "p50Ms": 25.2,
    "p95Ms": 47.9
   },
   "activity": {
    "count": 3872,
    "meanMs": 8.8,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 2,
    "meanMs": 10.5,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "persistence_latency": {
    "count": 42357,
    "meanMs": 2.7,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 8449,
    "meanMs": 6.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 8536,
    "meanMs": 5.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 10235,
    "meanMs": 6.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 20560,
    "meanMs": 3.5,
    "p50Ms": 25,
    "p95Ms": 47.6
   },
   "task_latency_processing": {
    "count": 20555,
    "meanMs": 3.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 10235,
    "meanMs": 13.3,
    "p50Ms": 25.2,
    "p95Ms": 48
   },
   "task_latency_schedule": {
    "count": 20555,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 8275,
    "meanMs": 8.6,
    "p50Ms": 25.2,
    "p95Ms": 47.8
   },
   "workflow_task_attempt": {
    "count": 4406,
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

<details><summary>Step 3: 64 tenants — broke</summary>

```json
{
 "step": 3,
 "tenants": 64,
 "teams": 16,
 "people": 96,
 "sockets": 192,
 "openTasks": 239,
 "tasksInTurn": 47,
 "tasksAtReview": 190,
 "runningWorkflows": 239,
 "sandboxes": {
  "running": 48,
  "paused": 316
 },
 "setupSeconds": 100,
 "failedSetups": 0,
 "requestsPerSecond": 13.4,
 "requests": 4032,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 3,
 "api": {
  "n": 4032,
  "p50": 1382,
  "p95": 4065,
  "p99": 6393,
  "max": 8027
 },
 "eventLag": {
  "n": 38193,
  "p50": 3901,
  "p95": 22849,
  "p99": 27705,
  "max": 30679
 },
 "turnOverhead": {
  "n": 360,
  "p50": 24446,
  "p95": 109557,
  "p99": 117580,
  "max": 123231
 },
 "firstTurn": {
  "n": 227,
  "p50": 51045,
  "p95": 135962,
  "p99": 139433,
  "max": 147339
 },
 "approveToDone": {
  "n": 73,
  "p50": 6646,
  "p95": 78778,
  "p99": 109783,
  "max": 109783
 },
 "cancelToCancelled": {
  "n": 65,
  "p50": 8188,
  "p95": 75513,
  "p99": 89208,
  "max": 89208
 },
 "wsConnect": {
  "n": 229,
  "p50": 417,
  "p95": 651,
  "p99": 824,
  "max": 834
 },
 "tenantSetup": {
  "n": 32,
  "p50": 19021,
  "p95": 35596,
  "p99": 36031,
  "max": 36031
 },
 "tasks": {
  "created": 210,
  "turns": 360,
  "done": 73,
  "cancelled": 65,
  "failed": 0,
  "stuck": 0,
  "followUps": 146,
  "resourceSaves": 65
 },
 "sockets_": {
  "opens": 223,
  "refused": 0,
  "failures": 0,
  "drops": 223,
  "closes": {
   "socketClosed 1013": 223
  },
  "events": 38422
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 66,
   "p50": 6582,
   "p95": 7616,
   "p99": 8027,
   "max": 8027
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 211,
   "p50": 4439,
   "p95": 5653,
   "p99": 5819,
   "max": 5945
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 281,
   "p50": 3174,
   "p95": 4170,
   "p99": 4503,
   "max": 4670
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 558,
   "p50": 2425,
   "p95": 3200,
   "p99": 3513,
   "max": 3692
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 618,
   "p50": 2150,
   "p95": 3042,
   "p99": 3357,
   "max": 3534
  },
  {
   "route": "GET /api/tasks/:id/events",
   "n": 558,
   "p50": 1790,
   "p95": 2479,
   "p99": 2716,
   "max": 2939
  }
 ],
 "hostCpuPct": {
  "mean": 89,
  "max": 92,
  "steal": 0.1,
  "iowait": 1.8
 },
 "load1Max": 9.65,
 "hostMemAvailableMinMb": 5082,
 "containers": {
  "app": {
   "cpuMeanPct": 199,
   "cpuMaxPct": 232,
   "memMaxMb": 1303,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 107,
   "cpuMaxPct": 128,
   "memMaxMb": 287,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 45,
   "cpuMaxPct": 64,
   "memMaxMb": 187,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 2,
   "cpuMaxPct": 4,
   "memMaxMb": 82,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 231,
  "heapLimitMb": 662,
  "rssMaxMb": 560,
  "eldP99MaxMs": 28.2,
  "eldMaxMs": 67,
  "cpuMeanPct": 90,
  "gcPct": 8.7,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 181,
  "heapLimitMb": 1276,
  "rssMaxMb": 675,
  "eldP99MaxMs": 52.8,
  "eldMaxMs": 132,
  "cpuMeanPct": 80,
  "gcPct": 2,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 49,
  "karmaxConnectionsMax": 12,
  "maxConnections": 100,
  "lockWaitersMax": 1,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 238,
  "karmaxCommitsPerSecond": 5207.3,
  "karmaxDbMb": 53
 },
 "appGauges": {
  "karmax_database_bytes": 55450647,
  "karmax_http_inflight": 35,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 232508056,
  "karmax_heap_used_bytes{heap=\"worker\"}": 186360016,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 587526144,
  "karmax_process_rss_bytes{process=\"worker\"}": 707764224,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.022626303,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.028475391,
  "karmax_event_loop_delay_max_seconds": 0.206700543,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 3.4676849199991477,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 8.765855754994469,
  "karmax_database_pending": 234,
  "karmax_database_connections": 4,
  "karmax_database_waiting": 230
 },
 "topStatements": [
  {
   "perSecond": 1782.9,
   "meanMs": 0.02,
   "query": "SELECT \"organizationId\" FROM projects WHERE id=$1",
   "sharePct": 31
  },
  {
   "perSecond": 883.5,
   "meanMs": 0.01,
   "query": "SELECT \"principalId\", \"scopeKey\", json FROM principal_grants WHERE \"principalId\" = $1 ORDER BY \"scopeKey\"",
   "sharePct": 15.4
  },
  {
   "perSecond": 877.8,
   "meanMs": 0.02,
   "query": "SELECT \"projectId\", principal, role, \"joinedAt\" FROM project_memberships WHERE \"projectId\"=$1 ORDER BY \"joinedAt\"",
   "sharePct": 15.3
  },
  {
   "perSecond": 273.1,
   "meanMs": 0.27,
   "query": "SELECT karmax_seq_watermark($1, $2) AS w",
   "sharePct": 4.7
  },
  {
   "perSecond": 269.9,
   "meanMs": 0.02,
   "query": "SELECT v FROM kv WHERE k = $1",
   "sharePct": 4.7
  },
  {
   "perSecond": 237.2,
   "meanMs": 0.02,
   "query": "SELECT * FROM events WHERE \"taskId\" = $1 AND type IN ($2, $3, $4) AND seq > $5 AND seq <= $6 ORDER BY seq",
   "sharePct": 4.1
  },
  {
   "perSecond": 138.8,
   "meanMs": 0.01,
   "query": "SELECT json FROM authorization_profiles WHERE \"scopeKey\" = $1 AND id = $2",
   "sharePct": 2.4
  },
  {
   "perSecond": 114.2,
   "meanMs": 0,
   "query": "BEGIN",
   "sharePct": 2
  },
  {
   "perSecond": 114.2,
   "meanMs": 0,
   "query": "COMMIT",
   "sharePct": 2
  },
  {
   "perSecond": 79.8,
   "meanMs": 0.03,
   "query": "SELECT * FROM projects WHERE id = $1",
   "sharePct": 1.4
  },
  {
   "perSecond": 67.8,
   "meanMs": 0.05,
   "query": "SELECT id, num, \"projectId\", \"listId\", title, workflow, \"executionWorkflow\", \"workflowVersion\", params, \"createdAt\", ord, \"parentTaskId\", \"createdBy\", assignee, delegate, \"confirmationPolicy\", \"intentId\", \"attemptNumber\", notes, \"lastView\" ",
   "sharePct": 1.2
  },
  {
   "perSecond": 66.4,
   "meanMs": 0.02,
   "query": "SELECT handle FROM world_instances WHERE \"worldId\"=$1 AND state!=$2 ORDER BY generation DESC LIMIT $3",
   "sharePct": 1.2
  }
 ],
 "metricsScrapeMaxMs": 1890,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 6526,
    "meanMs": 13,
    "p50Ms": 25.4,
    "p95Ms": 48.2
   },
   "activity": {
    "count": 5733,
    "meanMs": 14.1,
    "p50Ms": 25.5,
    "p95Ms": 48.4
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 37,
    "meanMs": 31.8,
    "p50Ms": 30.8,
    "p95Ms": 86.8
   },
   "persistence_latency": {
    "count": 65445,
    "meanMs": 4.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 12612,
    "meanMs": 10.7,
    "p50Ms": 25,
    "p95Ms": 47.6
   },
   "task_dispatch_latency": {
    "count": 12721,
    "meanMs": 10.3,
    "p50Ms": 25.1,
    "p95Ms": 47.6
   },
   "task_latency": {
    "count": 14924,
    "meanMs": 10.3,
    "p50Ms": 25,
    "p95Ms": 47.6
   },
   "task_latency_load": {
    "count": 31838,
    "meanMs": 5,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "task_latency_processing": {
    "count": 31822,
    "meanMs": 5.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 14924,
    "meanMs": 21.2,
    "p50Ms": 25.7,
    "p95Ms": 48.8
   },
   "task_latency_schedule": {
    "count": 31821,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 12259,
    "meanMs": 13.5,
    "p50Ms": 25.4,
    "p95Ms": 48.3
   },
   "workflow_task_attempt": {
    "count": 6528,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [
  "API p95 4065 ms",
  "event lag p95 22849 ms",
  "223 websocket failures or drops of 223 opens"
 ],
 "errorSamples": [
  {
   "route": "POST /api/projects/:id/tasks",
   "status": 403,
   "detail": "{\"error\":\"invalid or expired token\",\"code\":\"capability_denied\"}"
  },
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "status": 403,
   "detail": "{\"error\":\"invalid or expired token\",\"code\":\"capability_denied\"}"
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "status": 403,
   "detail": "{\"error\":\"invalid or expired token\",\"code\":\"capability_denied\"}"
  }
 ]
}
```
</details>

