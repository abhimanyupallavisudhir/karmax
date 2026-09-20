// A real subprocess exercising the production protocol with controlled failures.
import { serveWorkerProcess } from '../../src/temporal/worker-process-server.ts';
const mode = process.env.WORKER_FIXTURE_MODE;
serveWorkerProcess(async () => ({
  worker: {
    async start() {
      if (mode === 'frozen') while (true) { /* deliberate CPU stall */ }
      if (mode === 'frozen-idle') setTimeout(() => { while (true) { /* deliberate CPU stall */ } }, 50);
    },
    async refresh() {
      if (mode === 'crash-refresh') process.exit(7);
      if (mode === 'frozen-refresh') while (true) { /* deliberate CPU stall */ }
      await new Promise(resolve => setTimeout(resolve, 20));
      if (mode === 'reject-refresh') throw new Error('bundle rejected');
    },
    async stop() { if (mode === 'failed-stop') throw new Error('drain failed'); },
  },
  async close() {},
}));
process.send({ type: 'fixture.ready' });
