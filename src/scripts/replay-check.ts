import fs from 'node:fs';
import { DefaultLogger, Runtime } from '@temporalio/worker';
import { deploymentConfig, hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { paths } from '../config/paths.js';
import { buildVersionedBundle } from '../packages/bundle.js';
import { WorkflowManager } from '../packages/manager.js';
import { WorkflowRepoLoader } from '../packages/repo.js';
import { makeClient } from '../temporal/client.js';
import { temporalConnectionFromEnv } from '../temporal/connection-env.js';
import { replayRunningWorkflows } from '../ops/replay-check.js';

// `deploy/karmax update` runs this in a release's image before the release
// serves: every running workflow must replay under its code (WF-34). Exit 1
// names the workflows it cannot replay; exit 2 means it could not check.

hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
const conn = temporalConnectionFromEnv();
if (!conn) {
  console.error('replay-check: KARMAX_TEMPORAL_ADDRESS is not set, so there is no shared Temporal to check against.');
  process.exit(2);
}
// Failures are reported below; the replay worker's own warnings would repeat them.
Runtime.install({ logger: new DefaultLogger('ERROR'), telemetryOptions: { logging: { filter: { core: 'ERROR', other: 'ERROR' } } } });

try {
  // Bundle exactly what the release's worker will serve: the built-ins plus the
  // installed workflow packages it restores from disk at boot.
  const p = paths();
  const workflows = new WorkflowManager({ refresh: async () => {} }, new WorkflowRepoLoader(p.workflows), undefined,
    p.workflows, async () => ({}), deploymentConfig(process.env).hosted);
  await workflows.restore((message) => console.error(`replay-check: ${message}`), false);
  const bundle = await buildVersionedBundle(workflows.workflowRefs);
  const { client, close } = await makeClient(conn);
  try {
    const { checked, failures } = await replayRunningWorkflows(client, bundle);
    if (!failures.length) {
      console.log(`Replayed all ${checked} running workflows under this release.`);
    } else {
      console.error(`${failures.length} of ${checked} running workflows cannot replay under this release:`);
      for (const failure of failures.slice(0, 20))
        console.error(`  ${failure.workflowId} (${failure.workflowType ?? 'unknown type'}): ${failure.message.split('\n')[0]!.slice(0, 300)}`);
      if (failures.length > 20) console.error(`  …and ${failures.length - 20} more.`);
      process.exitCode = 1;
    }
  } finally { await close(); }
} catch (error) {
  console.error(`replay-check: could not check: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
