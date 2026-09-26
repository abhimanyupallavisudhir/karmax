import { beforeAll, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
// @temporalio/proto 1.24 advertises index.d.ts but omits it from the package.
const { temporal } = createRequire(import.meta.url)('@temporalio/proto') as {
  temporal: { api: { history: { v1: { History: {
    fromObject: (value: object) => Parameters<typeof Worker.runReplayHistory>[1];
  } } } } };
};

// Minimal, sanitized Setup prefix from a softwareDev@1.26.0 execution that
// recorded the temporary resource-aware setup patch. After an image rebuild
// removed that patch, every Confirm signal was accepted but replay failed.
// Preserve compatibility with both older histories and the retired-marker shim
// proposed before the complete resource-aware implementation reached master.
const fixture = JSON.parse(fs.readFileSync(
  new URL('./fixtures/resource-world-setup-history.json', import.meta.url), 'utf8'));
let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
beforeAll(async () => {
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL('../src/workflows/index.ts', import.meta.url)),
  });
});

// All four workflows used the same activity/patch sequence during Setup. Only
// software-dev adds the conversation-publication patch before the first view.
function setupHistory(workflow: string, patch: 'absent' | 'active' | 'deprecated') {
  const history = structuredClone(fixture);
  const omitted = new Set<string>();
  if (!workflow.startsWith('softwareDev')) { omitted.add('5'); omitted.add('6'); }
  if (patch === 'absent') { omitted.add('15'); omitted.add('16'); }
  history.events = history.events.filter((e: any) => !omitted.has(e.eventId));
  history.events[0].workflowExecutionStartedEventAttributes.workflowType.name = workflow;
  if (patch === 'deprecated') {
    const marker = history.events.find((e: any) => e.eventId === '15');
    marker.markerRecordedEventAttributes.details['patch-data'].payloads[0].data = Buffer.from(JSON.stringify({
      id: 'resource-aware-world-setup-v1', deprecated: true,
    })).toString('base64');
  }
  // Keep references valid when omitting the patch's marker/upsert event pair.
  const ids = new Map(history.events.map((e: any, i: number) => [e.eventId, String(i + 1)]));
  for (const event of history.events) {
    event.eventId = ids.get(event.eventId);
    for (const [key, attributes] of Object.entries(event)) {
      if (!key.endsWith('Attributes')) continue;
      for (const field of Object.keys(attributes as object)) {
        if (field.endsWith('EventId')) (attributes as any)[field] = ids.get((attributes as any)[field]);
      }
    }
  }
  return temporal.api.history.v1.History.fromObject(history);
}

for (const workflow of ['softwareDev@1.26.0', 'justDo@1.7.0', 'mergeOnly@1.3.0', 'scriptExec']) {
  it.each(['absent', 'active', 'deprecated'] as const)(`${workflow} replays Setup with an %s patch`, async patch => {
    await Worker.runReplayHistory({ workflowBundle }, setupHistory(workflow, patch));
  }, 60_000);
}
