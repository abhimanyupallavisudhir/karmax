import { expect, it, vi } from 'vitest';
import { matchesRecordedTemporalProcess, stopRecordedDevServer } from '../src/temporal/dev-server.js';

const record = { pid: 123, address: '127.0.0.1:7233', startTick: '100' };
const argv = ['/home/test/.temporalio/bin/temporal', 'server', 'start-dev', '--port', '7233', '--db-filename', '/data/temporal.db'];
it('WF-21: accepts the recorded Temporal process only with matching identity and database', () => {
  expect(matchesRecordedTemporalProcess(record, { startTick: '100', argv }, '/data/temporal.db')).toBe(true);
  expect(matchesRecordedTemporalProcess(record, { startTick: '101', argv }, '/data/temporal.db')).toBe(false);
  expect(matchesRecordedTemporalProcess(record, { startTick: '100', argv }, '/other/temporal.db')).toBe(false);
  expect(matchesRecordedTemporalProcess(record, { startTick: '100', argv: ['/bin/sleep', 'server', 'start-dev'] }, '/data/temporal.db')).toBe(false);
  expect(matchesRecordedTemporalProcess(record, { startTick: undefined, argv }, '/data/temporal.db')).toBe(false);
});
it('WF-21: verifies legacy records by exact command arguments', () => {
  const legacy = { pid: 123, address: record.address };
  expect(matchesRecordedTemporalProcess(legacy, { argv }, '/data/temporal.db')).toBe(true);
  expect(matchesRecordedTemporalProcess(legacy, { argv: [...argv, '7234'] }, '/data/temporal.db')).toBe(true);
  expect(matchesRecordedTemporalProcess({ ...legacy, address: '127.0.0.1:7234' }, { argv }, '/data/temporal.db')).toBe(false);
});

it('WF-21: never sends a destructive signal to an unrelated live process', async () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    expect(await stopRecordedDevServer({ pid: process.pid, address: '127.0.0.1:7233', uiUrl: '', namespace: 'default' }, '/data/temporal.db')).toBe(false);
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  } finally { kill.mockRestore(); }
});
