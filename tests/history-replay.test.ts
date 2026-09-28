import { it } from 'vitest';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import { historyFromJson } from './helpers/stub-task-worker.js';

// Recorded from 689f1c51 with stub activities (tests/helpers/stub-task-worker.ts),
// before the history-bounding fixes (WF-3, WF-4, LT-12): an eight-turn task
// parked for input, a landing wait on a repeated terminal failure, and hosted
// admission blocked by the plan in software-dev and just-do. Each is still
// running, so replay ends inside the wait the fixes changed. The long task
// recorded at bc2ea4db (tests/history-bounds.test.ts, 68 turns) passes the
// continue-as-new threshold at its last Do turns, so replay reaches that
// check with no marker recorded and must not continue. Recorded at 689f1c51
// on older pins (tests/helpers/record-task-history.ts): a v1.20 landing that
// polls a repeated failure without backing off, and a v1.23 task past the
// threshold. Recorded at a14b89e4: a merge-queue wait polling its position.
// Recorded at dac51479: a replacement parent parked at the sub-task barrier
// with a restored child, before the barrier reread such children.
it('replays task histories recorded before history bounding', async () => {
  const workflowBundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)),
  });
  for (const name of ['history-long-prechange', 'history-landing-duplicate-prechange',
    'history-admission-prechange', 'history-admission-justdo-prechange', 'history-long-past-threshold-prechange',
    'history-landing-duplicate-v1_20-prechange', 'history-long-v1_23-prechange', 'history-merge-queue-prechange',
    'history-subtask-barrier-prechange']) {
    const file = new URL(`./fixtures/${name}.json`, import.meta.url);
    const json = JSON.parse(fs.existsSync(file) ? fs.readFileSync(file, 'utf8')
      : zlib.gunzipSync(fs.readFileSync(new URL(`${file.href}.gz`))).toString('utf8'));
    await Worker.runReplayHistory({ workflowBundle }, historyFromJson(json), name);
  }
}, 120_000);
