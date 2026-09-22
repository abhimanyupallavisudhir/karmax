import { WorkerManager } from '../../src/temporal/worker-pool.js';
import { serveWorkerProcess } from '../../src/temporal/worker-process-server.js';

serveWorkerProcess(async () => {
  const address = process.env.WORKER_FIXTURE_TEMPORAL_ADDRESS;
  if (!address) throw new Error('isolated Temporal address is required');
  return {
    worker: new WorkerManager({ address, namespace: 'default' }, {}, () => process.exit(1)),
    close: async () => {},
  };
});
