import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Client } from '@temporalio/client';
import proto from '@temporalio/proto';
import type { Store } from '../store/db.js';

/** Snapshot only this tenant's task histories; shared coordinators require the
 * installation release gate (`src/ops/replay-check.ts`). Spool pages so both
 * replays see identical input. */
export async function snapshotReplayHistories(store: Store, client: Client, taskId: string,
  limits = { histories: 250, historyBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 }) {
  const owner = await store.taskAttribution(taskId);
  if (!owner?.organizationId) throw new Error('cannot establish the replay organization');
  return snapshotRunningHistories(client, {
    include: async (workflowId) => (await store.taskAttribution(workflowId))?.organizationId === owner.organizationId,
    limits, scope: 'organization',
  });
}

/** Spool the history of every running execution `include` accepts (all by
 * default) to disk, within `limits`, and replay them lazily from there. */
export async function snapshotRunningHistories(client: Client, options: {
  include?: (workflowId: string) => Promise<boolean> | boolean;
  limits: { histories: number; historyBytes: number; totalBytes: number };
  scope?: string;
}) {
  const { include, limits, scope = 'installation' } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-replay-histories-'));
  const records: Array<{ workflowId: string; workflowType?: string; pages: string[] }> = [];
  const release = () => fs.rmSync(root, { recursive: true, force: true });
  let totalBytes = 0;
  try {
    for await (const execution of client.workflow.list({ query: "ExecutionStatus='Running'" })) {
      if (include && !(await include(execution.workflowId))) continue;
      if (records.length >= limits.histories) throw new Error(`${scope} replay history count exceeds the replay limit`);
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
          throw new Error(`${scope} replay history bytes exceed the replay limit`);
        const file = path.join(root, `${records.length}-${pages.length}.bin`);
        fs.writeFileSync(file, encoded, { mode: 0o600 });
        pages.push(file);
        nextPageToken = response.nextPageToken?.length ? response.nextPageToken : undefined;
      } while (nextPageToken);
      records.push({ workflowId: execution.workflowId, workflowType: execution.type, pages });
    }
    return { count: records.length, release,
      typeOf: (workflowId: string) => records.find((record) => record.workflowId === workflowId)?.workflowType,
      async *histories() {
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
