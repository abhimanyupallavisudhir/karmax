import { expect, it, vi } from 'vitest';
import { terminateOnWorkerFailure } from '../src/temporal/worker-pool.js';

it('WF-19: requests process shutdown when a worker dies', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    terminateOnWorkerFailure(new Error('poller stopped'));
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(log).toHaveBeenCalled();
  } finally { kill.mockRestore(); log.mockRestore(); }
});
