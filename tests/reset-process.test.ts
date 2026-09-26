import { describe, expect, it } from 'vitest';
import { isRecordedTemporalProcess } from '../src/scripts/reset-process.js';

describe('reset Temporal process identity', () => {
  const record = { pid: 123, address: '127.0.0.1:7233' };

  it('accepts only the recorded Temporal dev server and port', () => {
    expect(isRecordedTemporalProcess(record,
      ['/usr/bin/temporal', 'server', 'start-dev', '--headless', '--port', '7233'])).toBe(true);
    expect(isRecordedTemporalProcess(record,
      ['/usr/bin/node', 'app.js', 'temporal server start-dev --port 7233'])).toBe(false);
    expect(isRecordedTemporalProcess(record,
      ['/usr/bin/temporal', 'server', 'start-dev', '--headless', '--port', '7234'])).toBe(false);
    expect(isRecordedTemporalProcess({ ...record, address: 'bad' },
      ['/usr/bin/temporal', 'server', 'start-dev', '--headless', '--port', '7233'])).toBe(false);
  });
});
