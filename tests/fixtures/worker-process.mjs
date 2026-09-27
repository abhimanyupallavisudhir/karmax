// A real subprocess exercising the production protocol with controlled failures.
import { announceEventsAppended, serveWorkerProcess } from '../../src/temporal/worker-process-server.ts';
const mode = process.env.WORKER_FIXTURE_MODE;
serveWorkerProcess(async () => ({
  worker: {
    async start() {
      if (mode === 'rejected-callback') setTimeout(() => { void Promise.reject(new Error('callback write failed')); }, 10);
      if (mode === 'frozen') while (true) { /* deliberate CPU stall */ }
      if (mode === 'frozen-idle') setTimeout(() => { while (true) { /* deliberate CPU stall */ } }, 50);
      if (mode === 'announce') setTimeout(() => {
        for (let i = 0; i < 5; i++) announceEventsAppended(); // one burst of commits
        setTimeout(() => announceEventsAppended(), 50); // a later commit
      }, 20);
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
