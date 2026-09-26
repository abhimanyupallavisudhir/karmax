import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import proto from '@temporalio/proto';
import type { Store } from '../store/db.js';

/** Snapshot only this tenant's task histories; shared coordinators require the
 * installation release gate. Spool pages so both replays see identical input. */
export async function snapshotReplayHistories(store: Store, client: Client, taskId: string,
  limits = { histories: 250, historyBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 }) {
  const owner = await store.taskAttribution(taskId);
  if (!owner?.organizationId) throw new Error('cannot establish the replay organization');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-replay-histories-'));
  const records: Array<{ workflowId: string; pages: string[] }> = [];
  const release = () => fs.rmSync(root, { recursive: true, force: true });
  let totalBytes = 0;
  try {
    for await (const execution of client.workflow.list({ query: "ExecutionStatus='Running'" })) {
      if ((await store.taskAttribution(execution.workflowId))?.organizationId !== owner.organizationId) continue;
      if (records.length >= limits.histories) throw new Error('organization replay history count exceeds the replay limit');
      const pages: string[] = [];
      let nextPageToken: Uint8Array | undefined;
      let historyBytes = 0;
      do {
        const response = await client.workflowService.getWorkflowExecutionHistory({
          namespace: client.options.namespace, execution: { workflowId: execution.workflowId, runId: execution.runId },
          maximumPageSize: 100, nextPageToken,
        });
        const encoded = proto.temporal.api.history.v1.History.encode(response.history ?? { events: [] }).finish();
        const bytes = encoded.byteLength;
        historyBytes += bytes;
        totalBytes += bytes;
        if (historyBytes > limits.historyBytes || totalBytes > limits.totalBytes)
          throw new Error('organization replay history bytes exceed the replay limit');
        const file = path.join(root, `${records.length}-${pages.length}.bin`);
        fs.writeFileSync(file, encoded, { mode: 0o600 });
        pages.push(file);
        nextPageToken = response.nextPageToken?.length ? response.nextPageToken : undefined;
      } while (nextPageToken);
      records.push({ workflowId: execution.workflowId, pages });
    }
    return { count: records.length, release, async *histories() {
      for (const record of records) {
        const events: proto.temporal.api.history.v1.IHistoryEvent[] = [];
        for (const file of record.pages) {
          for (const event of proto.temporal.api.history.v1.History.decode(fs.readFileSync(file)).events ?? []) events.push(event);
        }
        yield { workflowId: record.workflowId, history: { events } };
      }
    } };
  } catch (error) { release(); throw error; }
}
