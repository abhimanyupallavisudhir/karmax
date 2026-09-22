import { expect, it } from 'vitest';
import { GatewayMetrics } from '../src/gateway/metrics.js';

it('bounds labels, omits sensitive URL values, and counts completion/abort only once', () => {
  const metrics = new GatewayMetrics();
  try {
    for (let i = 0; i < 500; i++) {
      const end = metrics.begin(`/api/tasks/private-${i}?token=secret-${i}`);
      end(i % 2 ? 200 : 499); end(500);
    }
    const output = metrics.prometheus();
    expect(output).toContain('karmax_http_inflight 0');
    expect(output).toContain('karmax_http_request_duration_seconds_count{route="task"} 500');
    expect(output).toContain('karmax_http_errors_total{route="task"} 250');
    expect(output).not.toMatch(/private-|secret-|NaN|Infinity/);
    expect(output.length).toBeLessThan(2500);
  } finally { metrics.close(); }
});
