# Load test integrated — 1460e39c6d

Run `loadtest-20261009T233259Z-5abe`, origin/tavya/task_mup4gto91bfa7de841 (`1460e39c6d1e09a46b5186131a886a34cd9cfe14`), eu-central-1: system under test c7i.xlarge, worlds and load generator c7i.2xlarge, 50 ms added to every E2B round trip, 300 s held per step. Cost **$0.382**. Gateway processes seen: 1, worker processes seen: 1 (more than one means a restart).

**First wall: step 5, 64 tenants / 96 people / 231 open tasks** — API p95 3623 ms; event lag p95 21639 ms; 42 websocket failures or drops of 42 opens.

Steady window of each step (after its new tenants were set up). Latencies are as the load generator saw them through the HTTPS edge.

| step | tenants (people) | open tasks | running wf | req/s | API ms p50/p95/p99 | errors % | event lag ms p50/p95/p99 | turn overhead s p50/p95 | gateway heap / RSS MB | worker heap / RSS MB | worker loop p99 ms | app mem MB | host CPU % mean/max | PG conns | advisory waiters max | advisory wait max ms | Temporal backlog age ms | schedule-to-start p95 ms wf / act |
|---:|---:|---:|---:|---:|---|---:|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 1 | 4 (6) | 10 | 12 | 1.1 | 18 / 67 / 543 | 0 | 8 / 19 / 28 | 1.6 / 2.1 | 142 / 440 | 102 / 402 | 16.5 | 756 | 10 / 61 | 38 | 0 | 0 | 0 | 47.5 / 47.5 |
| 2 | 8 (12) | 25 | 24 | 1.9 | 16 / 67 / 564 | 0 | 7 / 22 / 28 | 1.7 / 2.0 | 140 / 444 | 103 / 418 | 15.3 | 810 | 13 / 49 | 41 | 0 | 0 | 0 | 47.5 / 47.5 |
| 3 | 16 (24) | 52 | 54 | 4.2 | 17 / 68 / 466 | 0 | 7 / 33 / 53 | 1.8 / 2.4 | 150 / 455 | 109 / 477 | 19 | 867 | 22 / 61 | 46 | 0 | 0 | 0 | 47.6 / 47.5 |
| 4 | 32 (48) | 115 | 115 | 7.2 | 18 / 104 / 585 | 0 | 10 / 72 / 115 | 2.3 / 3.2 | 184 / 499 | 129 / 551 | 32.1 | 1014 | 40 / 68 | 40 | 0 | 0 | 0 | 47.7 / 47.5 |
| 5 | 64 (96) | 231 | 235 | 13.6 | 1042 / 3623 / 5329 | 0 | 1396 / 21639 / 28167 | 13.4 / 38.9 | 226 / 565 | 180 / 685 | 41.9 | 1265 | 88 / 93 | 63 | 0 | 0 | 0 | 48.2 / 48.3 |

<details><summary>Step 1: 4 tenants</summary>

```json
{
 "step": 1,
 "tenants": 4,
 "teams": 1,
 "people": 6,
 "sockets": 12,
 "openTasks": 10,
 "tasksInTurn": 5,
 "tasksAtReview": 5,
 "runningWorkflows": 12,
 "sandboxes": {
  "running": 5,
  "paused": 9
 },
 "setupSeconds": 4,
 "failedSetups": 0,
 "requestsPerSecond": 1.1,
 "requests": 326,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 326,
  "p50": 18,
  "p95": 67,
  "p99": 543,
  "max": 556
 },
 "eventLag": {
  "n": 4796,
  "p50": 8,
  "p95": 19,
  "p99": 28,
  "max": 122
 },
 "turnOverhead": {
  "n": 40,
  "p50": 1573,
  "p95": 2144,
  "p99": 2578,
  "max": 2578
 },
 "firstTurn": {
  "n": 19,
  "p50": 26268,
  "p95": 39361,
  "p99": 39361,
  "max": 39361
 },
 "approveToDone": {
  "n": 7,
  "p50": 207,
  "p95": 235,
  "p99": 235,
  "max": 235
 },
 "cancelToCancelled": {
  "n": 4,
  "p50": 103,
  "p95": 104,
  "p99": 104,
  "max": 104
 },
 "wsConnect": {
  "n": 6,
  "p50": 25,
  "p95": 30,
  "p99": 30,
  "max": 30
 },
 "tenantSetup": {
  "n": 4,
  "p50": 3745,
  "p95": 4392,
  "p99": 4392,
  "max": 4392
 },
 "tasks": {
  "created": 21,
  "turns": 40,
  "done": 7,
  "cancelled": 4,
  "failed": 0,
  "stuck": 0,
  "followUps": 24,
  "resourceSaves": 6
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 4802
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 6,
   "p50": 543,
   "p95": 556,
   "p99": 556,
   "max": 556
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 21,
   "p50": 67,
   "p95": 80,
   "p99": 177,
   "max": 177
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 35,
   "p50": 39,
   "p95": 57,
   "p99": 66,
   "max": 66
  },
  {
   "route": "GET /api/tasks/:id/events",
   "n": 36,
   "p50": 17,
   "p95": 38,
   "p99": 42,
   "max": 42
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 36,
   "p50": 22,
   "p95": 33,
   "p99": 34,
   "max": 34
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 36,
   "p50": 19,
   "p95": 31,
   "p99": 31,
   "max": 31
  }
 ],
 "hostCpuPct": {
  "mean": 10,
  "max": 61,
  "steal": 0,
  "iowait": 2.1
 },
 "load1Max": 1.24,
 "hostMemAvailableMinMb": 5831,
 "containers": {
  "app": {
   "cpuMeanPct": 12,
   "cpuMaxPct": 43,
   "memMaxMb": 756,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 11,
   "cpuMaxPct": 25,
   "memMaxMb": 204,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 6,
   "cpuMaxPct": 23,
   "memMaxMb": 131,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 0,
   "cpuMaxPct": 1,
   "memMaxMb": 23,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 142,
  "heapLimitMb": 662,
  "rssMaxMb": 440,
  "eldP99MaxMs": 14.5,
  "eldMaxMs": 198,
  "cpuMeanPct": 4,
  "gcPct": 0.1,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 102,
  "heapLimitMb": 1276,
  "rssMaxMb": 402,
  "eldP99MaxMs": 16.5,
  "eldMaxMs": 276,
  "cpuMeanPct": 9,
  "gcPct": 0.1,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 38,
  "karmaxConnectionsMax": 9,
  "maxConnections": 100,
  "lockWaitersMax": 0,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 10,
  "karmaxCommitsPerSecond": 231.8,
  "karmaxDbMb": 14
 },
 "appGauges": {
  "karmax_database_bytes": 15195159,
  "karmax_http_inflight": 2,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 150458392,
  "karmax_heap_used_bytes{heap=\"worker\"}": 106053464,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 460759040,
  "karmax_process_rss_bytes{process=\"worker\"}": 421543936,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021479423,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.022200319,
  "karmax_event_loop_delay_max_seconds": 0.209190911,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 0.15197077500006298,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 0.09162580999996885,
  "karmax_database_pending": 1,
  "karmax_database_connections": 4,
  "karmax_database_waiting": 0
 },
 "topStatements": [],
 "metricsScrapeMaxMs": 101,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 772,
    "meanMs": 5.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "activity": {
    "count": 678,
    "meanMs": 4.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   }
  },
  "serverLatency": {
   "persistence_latency": {
    "count": 8628,
    "meanMs": 1.8,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 1467,
    "meanMs": 4.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 1498,
    "meanMs": 3.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 1704,
    "meanMs": 4.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 3336,
    "meanMs": 2.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 3336,
    "meanMs": 2.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 1704,
    "meanMs": 8.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_schedule": {
    "count": 3336,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 1450,
    "meanMs": 5.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "workflow_task_attempt": {
    "count": 771,
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
 "openTasks": 25,
 "tasksInTurn": 8,
 "tasksAtReview": 17,
 "runningWorkflows": 24,
 "sandboxes": {
  "running": 8,
  "paused": 30
 },
 "setupSeconds": 4,
 "failedSetups": 0,
 "requestsPerSecond": 1.9,
 "requests": 576,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 576,
  "p50": 16,
  "p95": 67,
  "p99": 564,
  "max": 648
 },
 "eventLag": {
  "n": 8066,
  "p50": 7,
  "p95": 22,
  "p99": 28,
  "max": 215
 },
 "turnOverhead": {
  "n": 63,
  "p50": 1651,
  "p95": 1983,
  "p99": 2389,
  "max": 2389
 },
 "firstTurn": {
  "n": 35,
  "p50": 23149,
  "p95": 40841,
  "p99": 41962,
  "max": 41962
 },
 "approveToDone": {
  "n": 13,
  "p50": 209,
  "p95": 233,
  "p99": 233,
  "max": 233
 },
 "cancelToCancelled": {
  "n": 9,
  "p50": 77,
  "p95": 122,
  "p99": 122,
  "max": 122
 },
 "wsConnect": {
  "n": 6,
  "p50": 23,
  "p95": 27,
  "p99": 27,
  "max": 27
 },
 "tenantSetup": {
  "n": 4,
  "p50": 3495,
  "p95": 3912,
  "p99": 3912,
  "max": 3912
 },
 "tasks": {
  "created": 36,
  "turns": 63,
  "done": 13,
  "cancelled": 9,
  "failed": 0,
  "stuck": 0,
  "followUps": 30,
  "resourceSaves": 17
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 8072
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 17,
   "p50": 550,
   "p95": 648,
   "p99": 648,
   "max": 648
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 36,
   "p50": 65,
   "p95": 92,
   "p99": 110,
   "max": 110
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 52,
   "p50": 42,
   "p95": 57,
   "p99": 67,
   "max": 67
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 67,
   "p50": 18,
   "p95": 31,
   "p99": 43,
   "max": 43
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 67,
   "p50": 19,
   "p95": 28,
   "p99": 34,
   "max": 34
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 80,
   "p50": 17,
   "p95": 27,
   "p99": 29,
   "max": 29
  }
 ],
 "hostCpuPct": {
  "mean": 13,
  "max": 49,
  "steal": 0.1,
  "iowait": 2.4
 },
 "load1Max": 0.86,
 "hostMemAvailableMinMb": 5747,
 "containers": {
  "app": {
   "cpuMeanPct": 19,
   "cpuMaxPct": 63,
   "memMaxMb": 810,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 13,
   "cpuMaxPct": 35,
   "memMaxMb": 219,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 8,
   "cpuMaxPct": 27,
   "memMaxMb": 150,
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
  "rssMaxMb": 444,
  "eldP99MaxMs": 18.5,
  "eldMaxMs": 52,
  "cpuMeanPct": 6,
  "gcPct": 0.1,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 103,
  "heapLimitMb": 1276,
  "rssMaxMb": 418,
  "eldP99MaxMs": 15.3,
  "eldMaxMs": 31,
  "cpuMeanPct": 12,
  "gcPct": 0.2,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 41,
  "karmaxConnectionsMax": 12,
  "maxConnections": 100,
  "lockWaitersMax": 0,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 4,
  "karmaxCommitsPerSecond": 394.4,
  "karmaxDbMb": 18
 },
 "appGauges": {
  "karmax_database_bytes": 18783255,
  "karmax_http_inflight": 2,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 147249248,
  "karmax_heap_used_bytes{heap=\"worker\"}": 108422960,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 465309696,
  "karmax_process_rss_bytes{process=\"worker\"}": 438505472,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021299199,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.021626879,
  "karmax_event_loop_delay_max_seconds": 0.209190911,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 0.24839880899975425,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 0.22978867399776973,
  "karmax_database_pending": 1,
  "karmax_database_connections": 4,
  "karmax_database_waiting": 0
 },
 "topStatements": [],
 "metricsScrapeMaxMs": 62,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 1195,
    "meanMs": 5.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "activity": {
    "count": 1050,
    "meanMs": 5.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   }
  },
  "serverLatency": {
   "persistence_latency": {
    "count": 12459,
    "meanMs": 1.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 2273,
    "meanMs": 4.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 2316,
    "meanMs": 3.9,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 2698,
    "meanMs": 4.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 5706,
    "meanMs": 2.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 5710,
    "meanMs": 2.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 2698,
    "meanMs": 8.8,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_schedule": {
    "count": 5710,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 2245,
    "meanMs": 5.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "workflow_task_attempt": {
    "count": 1202,
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
 "openTasks": 52,
 "tasksInTurn": 11,
 "tasksAtReview": 41,
 "runningWorkflows": 54,
 "sandboxes": {
  "running": 12,
  "paused": 77
 },
 "setupSeconds": 5,
 "failedSetups": 0,
 "requestsPerSecond": 4.2,
 "requests": 1257,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 1257,
  "p50": 17,
  "p95": 68,
  "p99": 466,
  "max": 777
 },
 "eventLag": {
  "n": 15376,
  "p50": 7,
  "p95": 33,
  "p99": 53,
  "max": 126
 },
 "turnOverhead": {
  "n": 122,
  "p50": 1818,
  "p95": 2381,
  "p99": 2638,
  "max": 2786
 },
 "firstTurn": {
  "n": 70,
  "p50": 29036,
  "p95": 40627,
  "p99": 41330,
  "max": 41330
 },
 "approveToDone": {
  "n": 27,
  "p50": 234,
  "p95": 321,
  "p99": 447,
  "max": 447
 },
 "cancelToCancelled": {
  "n": 24,
  "p50": 81,
  "p95": 119,
  "p99": 162,
  "max": 162
 },
 "wsConnect": {
  "n": 4,
  "p50": 15,
  "p95": 18,
  "p99": 18,
  "max": 18
 },
 "tenantSetup": {
  "n": 8,
  "p50": 4967,
  "p95": 5299,
  "p99": 5299,
  "max": 5299
 },
 "tasks": {
  "created": 78,
  "turns": 122,
  "done": 27,
  "cancelled": 24,
  "failed": 0,
  "stuck": 0,
  "followUps": 49,
  "resourceSaves": 17
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 15380
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 17,
   "p50": 553,
   "p95": 777,
   "p99": 777,
   "max": 777
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 78,
   "p50": 67,
   "p95": 141,
   "p99": 215,
   "max": 215
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 100,
   "p50": 40,
   "p95": 67,
   "p99": 124,
   "max": 124
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 161,
   "p50": 19,
   "p95": 33,
   "p99": 63,
   "max": 85
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 161,
   "p50": 18,
   "p95": 29,
   "p99": 81,
   "max": 120
  },
  {
   "route": "GET /api/projects/:id/tasks",
   "n": 183,
   "p50": 18,
   "p95": 28,
   "p99": 42,
   "max": 53
  }
 ],
 "hostCpuPct": {
  "mean": 22,
  "max": 61,
  "steal": 0,
  "iowait": 4.2
 },
 "load1Max": 1.46,
 "hostMemAvailableMinMb": 5627,
 "containers": {
  "app": {
   "cpuMeanPct": 44,
   "cpuMaxPct": 114,
   "memMaxMb": 867,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 26,
   "cpuMaxPct": 60,
   "memMaxMb": 242,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 15,
   "cpuMaxPct": 42,
   "memMaxMb": 163,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 1,
   "cpuMaxPct": 2,
   "memMaxMb": 38,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 150,
  "heapLimitMb": 662,
  "rssMaxMb": 455,
  "eldP99MaxMs": 34.7,
  "eldMaxMs": 50,
  "cpuMeanPct": 12,
  "gcPct": 0.4,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 109,
  "heapLimitMb": 1276,
  "rssMaxMb": 477,
  "eldP99MaxMs": 19,
  "eldMaxMs": 53,
  "cpuMeanPct": 23,
  "gcPct": 0.4,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 46,
  "karmaxConnectionsMax": 17,
  "maxConnections": 100,
  "lockWaitersMax": 0,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 18,
  "karmaxCommitsPerSecond": 909.8,
  "karmaxDbMb": 25
 },
 "appGauges": {
  "karmax_database_bytes": 25762839,
  "karmax_http_inflight": 2,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 159169536,
  "karmax_heap_used_bytes{heap=\"worker\"}": 110860176,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 478240768,
  "karmax_process_rss_bytes{process=\"worker\"}": 499998720,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021282815,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.021676031,
  "karmax_event_loop_delay_max_seconds": 0.209190911,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 0.739070100999157,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 0.5466955909951667,
  "karmax_database_pending": 2,
  "karmax_database_connections": 4,
  "karmax_database_waiting": 0
 },
 "topStatements": [],
 "metricsScrapeMaxMs": 87,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 2355,
    "meanMs": 6.4,
    "p50Ms": 25,
    "p95Ms": 47.6
   },
   "activity": {
    "count": 2068,
    "meanMs": 6.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 1,
    "meanMs": 12,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "persistence_latency": {
    "count": 23333,
    "meanMs": 2.1,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 4484,
    "meanMs": 4.7,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 4558,
    "meanMs": 4.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 5366,
    "meanMs": 4.7,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 11049,
    "meanMs": 2.7,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 11062,
    "meanMs": 2.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 5366,
    "meanMs": 10.3,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "task_latency_schedule": {
    "count": 11062,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 4423,
    "meanMs": 6.5,
    "p50Ms": 25,
    "p95Ms": 47.6
   },
   "workflow_task_attempt": {
    "count": 2355,
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
 "openTasks": 115,
 "tasksInTurn": 24,
 "tasksAtReview": 91,
 "runningWorkflows": 115,
 "sandboxes": {
  "running": 24,
  "paused": 162
 },
 "setupSeconds": 19,
 "failedSetups": 0,
 "requestsPerSecond": 7.2,
 "requests": 2159,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 2159,
  "p50": 18,
  "p95": 104,
  "p99": 585,
  "max": 968
 },
 "eventLag": {
  "n": 28260,
  "p50": 10,
  "p95": 72,
  "p99": 115,
  "max": 316
 },
 "turnOverhead": {
  "n": 231,
  "p50": 2334,
  "p95": 3204,
  "p99": 3696,
  "max": 4136
 },
 "firstTurn": {
  "n": 133,
  "p50": 27195,
  "p95": 39544,
  "p99": 42127,
  "max": 42265
 },
 "approveToDone": {
  "n": 45,
  "p50": 275,
  "p95": 594,
  "p99": 842,
  "max": 842
 },
 "cancelToCancelled": {
  "n": 32,
  "p50": 124,
  "p95": 351,
  "p99": 366,
  "max": 366
 },
 "wsConnect": {
  "n": 6,
  "p50": 23,
  "p95": 47,
  "p99": 47,
  "max": 47
 },
 "tenantSetup": {
  "n": 16,
  "p50": 6840,
  "p95": 9849,
  "p99": 9849,
  "max": 9849
 },
 "tasks": {
  "created": 134,
  "turns": 231,
  "done": 45,
  "cancelled": 32,
  "failed": 0,
  "stuck": 0,
  "followUps": 103,
  "resourceSaves": 45
 },
 "sockets_": {
  "opens": 0,
  "refused": 0,
  "failures": 0,
  "drops": 0,
  "closes": {},
  "events": 28266
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 45,
   "p50": 573,
   "p95": 800,
   "p99": 968,
   "max": 968
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 134,
   "p50": 77,
   "p95": 228,
   "p99": 310,
   "max": 324
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 180,
   "p50": 46,
   "p95": 148,
   "p99": 203,
   "max": 277
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 281,
   "p50": 20,
   "p95": 71,
   "p99": 113,
   "max": 169
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 281,
   "p50": 20,
   "p95": 65,
   "p99": 127,
   "max": 177
  },
  {
   "route": "GET /api/tasks/:id/events",
   "n": 281,
   "p50": 16,
   "p95": 61,
   "p99": 121,
   "max": 130
  }
 ],
 "hostCpuPct": {
  "mean": 40,
  "max": 68,
  "steal": 0,
  "iowait": 4.4
 },
 "load1Max": 3.88,
 "hostMemAvailableMinMb": 5445,
 "containers": {
  "app": {
   "cpuMeanPct": 76,
   "cpuMaxPct": 170,
   "memMaxMb": 1014,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 48,
   "cpuMaxPct": 92,
   "memMaxMb": 285,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 27,
   "cpuMaxPct": 53,
   "memMaxMb": 172,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 1,
   "cpuMaxPct": 3,
   "memMaxMb": 52,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 184,
  "heapLimitMb": 662,
  "rssMaxMb": 499,
  "eldP99MaxMs": 15.3,
  "eldMaxMs": 39,
  "cpuMeanPct": 26,
  "gcPct": 1,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 129,
  "heapLimitMb": 1276,
  "rssMaxMb": 551,
  "eldP99MaxMs": 32.1,
  "eldMaxMs": 69,
  "cpuMeanPct": 41,
  "gcPct": 0.7,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 40,
  "karmaxConnectionsMax": 11,
  "maxConnections": 100,
  "lockWaitersMax": 2,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 31,
  "karmaxCommitsPerSecond": 2085.1,
  "karmaxDbMb": 37
 },
 "appGauges": {
  "karmax_database_bytes": 39189527,
  "karmax_http_inflight": 3,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 197967312,
  "karmax_heap_used_bytes{heap=\"worker\"}": 128220696,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 522752000,
  "karmax_process_rss_bytes{process=\"worker\"}": 578797568,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021266431,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.022183935,
  "karmax_event_loop_delay_max_seconds": 0.209190911,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 1.4445018479980758,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 1.4256331870004393,
  "karmax_database_pending": 3,
  "karmax_database_connections": 4,
  "karmax_database_waiting": 0
 },
 "topStatements": [],
 "metricsScrapeMaxMs": 140,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 4253,
    "meanMs": 7.4,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "activity": {
    "count": 3739,
    "meanMs": 7.8,
    "p50Ms": 25,
    "p95Ms": 47.5
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
    "count": 40962,
    "meanMs": 2.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 8112,
    "meanMs": 5.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 8228,
    "meanMs": 5.2,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency": {
    "count": 9609,
    "meanMs": 5.4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 20295,
    "meanMs": 3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_processing": {
    "count": 20296,
    "meanMs": 2.7,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 9609,
    "meanMs": 11.9,
    "p50Ms": 25.1,
    "p95Ms": 47.8
   },
   "task_latency_schedule": {
    "count": 20296,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 7992,
    "meanMs": 7.6,
    "p50Ms": 25.1,
    "p95Ms": 47.6
   },
   "workflow_task_attempt": {
    "count": 4247,
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

<details><summary>Step 5: 64 tenants — broke</summary>

```json
{
 "step": 5,
 "tenants": 64,
 "teams": 16,
 "people": 96,
 "sockets": 192,
 "openTasks": 231,
 "tasksInTurn": 42,
 "tasksAtReview": 188,
 "runningWorkflows": 235,
 "sandboxes": {
  "running": 40,
  "paused": 337
 },
 "setupSeconds": 106,
 "failedSetups": 0,
 "requestsPerSecond": 13.6,
 "requests": 4075,
 "errorRatePct": 0,
 "rateLimited": 0,
 "clientErrors": 0,
 "api": {
  "n": 4075,
  "p50": 1042,
  "p95": 3623,
  "p99": 5329,
  "max": 7695
 },
 "eventLag": {
  "n": 47331,
  "p50": 1396,
  "p95": 21639,
  "p99": 28167,
  "max": 30337
 },
 "turnOverhead": {
  "n": 398,
  "p50": 13357,
  "p95": 38868,
  "p99": 95335,
  "max": 113363
 },
 "firstTurn": {
  "n": 244,
  "p50": 43395,
  "p95": 71890,
  "p99": 121549,
  "max": 131180
 },
 "approveToDone": {
  "n": 85,
  "p50": 4829,
  "p95": 66635,
  "p99": 78525,
  "max": 78525
 },
 "cancelToCancelled": {
  "n": 71,
  "p50": 4614,
  "p95": 23785,
  "p99": 62450,
  "max": 62450
 },
 "wsConnect": {
  "n": 48,
  "p50": 362,
  "p95": 528,
  "p99": 537,
  "max": 537
 },
 "tenantSetup": {
  "n": 32,
  "p50": 19956,
  "p95": 34969,
  "p99": 37348,
  "max": 37348
 },
 "tasks": {
  "created": 208,
  "turns": 398,
  "done": 85,
  "cancelled": 71,
  "failed": 1,
  "stuck": 0,
  "followUps": 157,
  "resourceSaves": 77
 },
 "sockets_": {
  "opens": 42,
  "refused": 0,
  "failures": 0,
  "drops": 42,
  "closes": {
   "socketClosed 1013": 42
  },
  "events": 47379
 },
 "slowestRoutes": [
  {
   "route": "POST /api/projects/:id/resources/:id/import",
   "n": 77,
   "p50": 5241,
   "p95": 7404,
   "p99": 7695,
   "max": 7695
  },
  {
   "route": "POST /api/projects/:id/tasks",
   "n": 208,
   "p50": 3540,
   "p95": 5162,
   "p99": 5329,
   "max": 5489
  },
  {
   "route": "POST /api/tasks/:id/signal",
   "n": 307,
   "p50": 2595,
   "p95": 3937,
   "p99": 4274,
   "max": 4447
  },
  {
   "route": "GET /api/tasks/:id/conversation",
   "n": 565,
   "p50": 2072,
   "p95": 3125,
   "p99": 3303,
   "max": 3485
  },
  {
   "route": "GET /api/tasks/:id",
   "n": 580,
   "p50": 1912,
   "p95": 2985,
   "p99": 3143,
   "max": 3204
  },
  {
   "route": "GET /api/tasks/:id/events",
   "n": 566,
   "p50": 1485,
   "p95": 2306,
   "p99": 2592,
   "max": 2755
  }
 ],
 "hostCpuPct": {
  "mean": 88,
  "max": 93,
  "steal": 0.1,
  "iowait": 2.7
 },
 "load1Max": 8.97,
 "hostMemAvailableMinMb": 4921,
 "containers": {
  "app": {
   "cpuMeanPct": 196,
   "cpuMaxPct": 233,
   "memMaxMb": 1265,
   "memLimitMb": 4096
  },
  "postgresql": {
   "cpuMeanPct": 108,
   "cpuMaxPct": 148,
   "memMaxMb": 359,
   "memLimitMb": 768
  },
  "temporal": {
   "cpuMeanPct": 43,
   "cpuMaxPct": 59,
   "memMaxMb": 196,
   "memLimitMb": 2048
  },
  "caddy": {
   "cpuMeanPct": 2,
   "cpuMaxPct": 4,
   "memMaxMb": 84,
   "memLimitMb": 512
  }
 },
 "appRestarts": 0,
 "appOomKilled": false,
 "gateway": {
  "heapUsedMaxMb": 226,
  "heapLimitMb": 662,
  "rssMaxMb": 565,
  "eldP99MaxMs": 27.5,
  "eldMaxMs": 65,
  "cpuMeanPct": 89,
  "gcPct": 8.4,
  "pids": 1
 },
 "worker": {
  "heapUsedMaxMb": 180,
  "heapLimitMb": 1276,
  "rssMaxMb": 685,
  "eldP99MaxMs": 41.9,
  "eldMaxMs": 97,
  "cpuMeanPct": 77,
  "gcPct": 1.9,
  "pids": 1
 },
 "postgres": {
  "connectionsMax": 63,
  "karmaxConnectionsMax": 12,
  "maxConnections": 100,
  "lockWaitersMax": 1,
  "advisoryWaitersMax": 0,
  "advisoryWaitersMean": 0,
  "advisoryWaitMaxMs": 0,
  "longestXactMs": 97,
  "karmaxCommitsPerSecond": 5454.1,
  "karmaxDbMb": 62
 },
 "appGauges": {
  "karmax_database_bytes": 64789527,
  "karmax_http_inflight": 34,
  "karmax_heap_used_bytes{heap=\"gateway\"}": 240308048,
  "karmax_heap_used_bytes{heap=\"worker\"}": 180705680,
  "karmax_heap_limit_bytes{heap=\"gateway\"}": 694157312,
  "karmax_heap_limit_bytes{heap=\"worker\"}": 1337982976,
  "karmax_process_rss_bytes{process=\"gateway\"}": 592445440,
  "karmax_process_rss_bytes{process=\"worker\"}": 717373440,
  "karmax_event_loop_delay_seconds{quantile=\"0.95\"}": 0.021528575,
  "karmax_event_loop_delay_seconds{quantile=\"0.99\"}": 0.025542655,
  "karmax_event_loop_delay_max_seconds": 0.209190911,
  "karmax_store_global_lock_wait_seconds_sum{process=\"gateway\"}": 0,
  "karmax_store_global_lock_wait_seconds_sum{process=\"worker\"}": 0,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"gateway\"}": 2.8939375959914875,
  "karmax_store_entity_lock_wait_seconds_sum{process=\"worker\"}": 8.228478441009095,
  "karmax_database_pending": 232,
  "karmax_database_connections": 4,
  "karmax_database_waiting": 228
 },
 "topStatements": [],
 "metricsScrapeMaxMs": 1741,
 "temporal": {
  "backlogAgeMaxMs": 0,
  "backlogCountMax": 0,
  "scheduleToStart": {
   "workflow": {
    "count": 6949,
    "meanMs": 12.2,
    "p50Ms": 25.4,
    "p95Ms": 48.2
   },
   "activity": {
    "count": 6102,
    "meanMs": 12.9,
    "p50Ms": 25.4,
    "p95Ms": 48.3
   }
  },
  "serverLatency": {
   "asyncmatch_latency": {
    "count": 26,
    "meanMs": 33.2,
    "p50Ms": 28.3,
    "p95Ms": 92.5
   },
   "persistence_latency": {
    "count": 67602,
    "meanMs": 4,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "syncmatch_latency": {
    "count": 13358,
    "meanMs": 9.7,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_dispatch_latency": {
    "count": 13498,
    "meanMs": 9.3,
    "p50Ms": 25,
    "p95Ms": 47.6
   },
   "task_latency": {
    "count": 15755,
    "meanMs": 9.3,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_load": {
    "count": 33736,
    "meanMs": 4.7,
    "p50Ms": 25.1,
    "p95Ms": 47.7
   },
   "task_latency_processing": {
    "count": 33709,
    "meanMs": 4.6,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_latency_queue": {
    "count": 15755,
    "meanMs": 19.6,
    "p50Ms": 25.5,
    "p95Ms": 48.5
   },
   "task_latency_schedule": {
    "count": 33709,
    "meanMs": 0,
    "p50Ms": 25,
    "p95Ms": 47.5
   },
   "task_schedule_to_start_latency": {
    "count": 13051,
    "meanMs": 12.5,
    "p50Ms": 25.4,
    "p95Ms": 48.2
   },
   "workflow_task_attempt": {
    "count": 6941,
    "meanMs": 1000,
    "p50Ms": 500,
    "p95Ms": 950
   }
  }
 },
 "broken": [
  "API p95 3623 ms",
  "event lag p95 21639 ms",
  "42 websocket failures or drops of 42 opens"
 ],
 "errorSamples": []
}
```
</details>

## Compared with baseline (`45522f01a9`)

| step | tenants (people) | open tasks | running wf | req/s | API ms p50/p95/p99 | errors % | event lag ms p50/p95/p99 | turn overhead s p50/p95 | gateway heap / RSS MB | worker heap / RSS MB | worker loop p99 ms | app mem MB | host CPU % mean/max | PG conns | advisory waiters max | advisory wait max ms | Temporal backlog age ms | schedule-to-start p95 ms wf / act |
|---:|---:|---:|---:|---:|---|---:|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---|
| 1 | 4 (6) | 9 | 13 | 1.1 | 16 / 63 / 595 | 0 | 6 / 18 / 25 | 1.6 / 1.8 | 128 / 423 | 112 / 409 | 15.6 | 816 | 8 / 59 | 48 | 0 | 0 | 0 | 47.5 / 47.5 |
| 2 | 8 (12) | 20 | 25 | 2.5 | 15 / 62 / 91 | 0 | 6 / 19 / 27 | 1.5 / 1.7 | 138 / 432 | 101 / 432 | 15.2 | 839 | 13 / 51 | 50 | 0 | 0 | 0 | 47.5 / 47.5 |
| 3 | 16 (24) | 51 | 51 | 4.3 | 15 / 65 / 538 | 0 | 6 / 29 / 44 | 1.6 / 2.0 | 142 / 444 | 109 / 462 | 21.7 | 907 | 19 / 32 | 49 | 0 | 0 | 0 | 47.5 / 47.5 |
| 4 | 32 (48) | 112 | 115 | 7.4 | 17 / 121 / 587 | 0 | 9 / 69 / 120 | 2.1 / 3.0 | 184 / 492 | 122 / 540 | 36 | 1046 | 39 / 92 | 58 | 0 | 0 | 0 | 47.6 / 47.6 |
| 5 | 64 (96) | 252 | 245 | 14 | 1083 / 3429 / 5377 | 0 | 3339 / 17621 / 22956 | 16.7 / 102.0 | 581 / 894 | 175 / 683 | 46.7 | 1662 | 87 / 90 | 56 | 1 | 15 | 0 | 48 / 47.9 |

