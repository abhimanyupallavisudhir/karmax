import { serveWorkerProcess } from './worker-process-server.js';

// Install control admission and the independent parent guardian before loading
// any application services. This entrypoint is only for a supervised child.
serveWorkerProcess(async () => {
  const { createActivityWorkerRuntime } = await import('../runtime/activity-worker.js');
  return createActivityWorkerRuntime();
});
