import { admitWorkerProcess } from '../../src/util/instance.js';

try {
  const release = await admitWorkerProcess(process.env.KARMAX_HOME!);
  process.on('message', () => { release(); process.disconnect(); });
  process.once('disconnect', release);
  process.send!({ ok: true });
} catch (error) {
  process.send!({ ok: false, error: (error as Error).message }, () => process.disconnect());
}
