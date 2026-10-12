import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { git, gitOrThrow } from '../src/world/git.js';

// pramana#22 end to end: real Temporal, a real worktree world holding a
// writable resource saved by real restic, and a job that keeps writing into
// it while the agent creates a sub-task. The parent must stay alive, its
// agent must hear why no sub-task was created, and once the writer is
// stopped the same request must start the child from the parent's data.

let h: Harness;
beforeAll(async () => { h = await bootHarness('mock'); }, 60_000);
afterAll(async () => { await h?.stop(); });

const view = (handle: { query<T>(name: string): Promise<T> }) => handle.query<any>('view');
const agentSaid = async (handle: { query<T>(name: string): Promise<T> }) =>
  ((await view(handle)).messages as { role: string; text: string }[]).filter((m) => m.role === 'agent').map((m) => m.text).join('\n');

it('a writer in the parent\'s data makes create_sub_task fail back to the agent, and a retry after stopping it starts the child', async () => {
  const repo = await h.makeRepo('subtask-writer');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'raw_data/\n');
  await git(repo, ['add', '-A']);
  await gitOrThrow(repo, ['commit', '-qm', 'ignore the data']);
  const project = await h.store.createProject('subtask-writer', { repos: [repo] });
  const attachment = await h.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'Raw data', driver: 'volume@1', target: { kind: 'path', path: 'raw_data' }, access: 'write',
    isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' });
  await h.resources.importFiles(attachment.id, Array.from({ length: 50 }, (_, i) => ({ path: `pages/${i}.txt`, data: Buffer.from(`page ${i}\n`) })));
  const prompt = [
    // A server writing its log into the data folder until told to stop.
    '@job while [ ! -e stop-writer ]; do date +%s%N >> raw_data/server.log; sleep 0.02; done',
    '@subtask OCR :: @write ocr.txt :: from child',
  ].join('\n');
  const task = await h.store.createTask({ projectId: project.id, title: 'Corpus', workflow: 'software-dev',
    workflowVersion: '1.28.0', params: { prompt } });
  const parent = await h.client.workflow.start('softwareDev@1.28.0', {
    taskQueue: TASK_QUEUE, workflowId: task.id,
    args: [{ taskId: task.id, projectId: project.id, title: 'Corpus', prompt, base: 'main', target: 'main',
      project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }],
  });
  try {
    // The failure comes back to the agent as a message, naming what kept changing.
    await expect.poll(async () => ((await view(parent)).messages as { role: string; text: string }[])
      .find((m) => m.role === 'user' && m.text.startsWith('create_sub_task "OCR" failed'))?.text, { timeout: 90_000 })
      .toMatch(/raw_data kept changing while it was being saved: 1 file changed between saves \(server\.log\)\. Something is still writing into it, usually a server or job/);
    expect((await h.store.eventsOfType(task.id, 'subtask.failed')).map((e) => e.payload)).toMatchObject([{ title: 'OCR' }]);
    expect(await h.store.childTasks(task.id)).toEqual([]);
    // The parent is alive and its agent takes turns again.
    await expect.poll(async () => (await view(parent)).status, { timeout: 30_000 }).toBe('waiting');
    expect((await parent.describe()).status.name).toBe('RUNNING');

    // The agent read why, stops the writer and asks again.
    await parent.signal('followUp', { id: 'retry', role: 'user', ts: Date.now(), text: [
      '@heard', '@run touch stop-writer && sleep 1', '@subtask OCR :: @write ocr.txt :: from child'].join('\n') });
    await expect.poll(() => agentSaid(parent), { timeout: 30_000 }).toMatch(/heard: .*user: create_sub_task "OCR" failed: no sub-task was created/);
    await expect.poll(async () => (await view(parent)).subTasks?.length ?? 0, { timeout: 90_000 }).toBe(1);
    const [child] = await h.store.childTasks(task.id);
    // It starts from the parent's data as saved for it, the server's log included.
    const versions = child!.params._parentResources as Record<string, string>;
    expect(Object.keys(versions)).toEqual([attachment.id]);
    const saved = await h.resources.verifyRevision(project.id, attachment.id, versions[attachment.id]!, 0, 1000);
    expect(saved.files.map((file) => file.path)).toContain('server.log');
    expect((await parent.describe()).status.name).toBe('RUNNING');
  } finally {
    await parent.signal('cancel').catch(() => undefined);
    await parent.result().catch(() => undefined);
  }
}, 240_000);
