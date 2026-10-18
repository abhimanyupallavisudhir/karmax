import { expect, it, vi } from 'vitest';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';

it('POST /api/tasks/:id/deliver-data brings an idle sub-task\'s data to its parent, and nothing else', async () => {
  const store = await Store.create(':memory:');
  try {
    const project = await store.createProject('Deliver');
    const make = (title: string, extra: Record<string, unknown> = {}) => store.createTask({ projectId: project.id, title,
      workflow: 'software-dev', workflowVersion: '1.30.0', params: { prompt: title } as any, ...extra });
    const parent = await make('Parent');
    const child = await make('A2', { parentTaskId: parent.id });
    const view = (taskId: string, status: string) => store.saveView(taskId, { taskId, title: 't', workflow: 'software-dev', stage: 'review',
      status, messages: [], actions: [] } as any);
    await view(child.id, 'waiting');
    const tokens = new TokenAuthority(store);
    const token = (await tokens.mintPrincipal('user:dev', ['task:read', 'task:edit'], project.id, undefined, project.organizationId)).token;
    const deliverNow = vi.fn(async () => [{ attachmentId: 'r', name: 'data', path: 'data', revisionId: 'v', added: 2, modified: 0, deleted: 0 }]);
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'test', tokens, resources: { deliverNow } as any });
    expect(await api.deliverSubTaskData(token, child.id)).toEqual({ taken: [expect.objectContaining({ added: 2 })] });
    expect(deliverNow).toHaveBeenCalledWith(child.id);
    await expect(api.deliverSubTaskData(token, parent.id)).rejects.toThrow(/only a sub-task/);
    await view(child.id, 'active');
    await expect(api.deliverSubTaskData(token, child.id)).rejects.toThrow(/working/);
  } finally { await store.close(); }
});
