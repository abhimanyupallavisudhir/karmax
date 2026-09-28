import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { stubGateway } from './helpers/stub-gateway.js';

/**
 * RQ-3: the task list shows only principal attempts, so a `view.updated` from
 * another attempt looked like an unseen task and reloaded the whole list. Its
 * event now says it is a sibling attempt.
 * RQ-16: every readable project's events, agent output included, reached every
 * open tab. A socket that names what it shows (`watch`) now receives streamed
 * detail only for those tasks and only lifecycle events from other projects.
 */
async function fixture() {
  const h = await stubGateway();
  const project = await h.store.createProject('Shown');
  const other = await h.store.createProject('Elsewhere');
  const make = (projectId: string, title: string, intentId?: string) => h.store.createTask({ projectId, title,
    workflow: 'just-do', workflowVersion: '1.0.0', params: {} as any, ...(intentId ? { intentId } : {}) });
  const open = await make(project.id, 'Open');
  const listed = await make(project.id, 'Listed');
  const attempt = await make(project.id, 'Second attempt', open.intentId);
  const foreign = await make(other.id, 'Foreign');
  const minted = await h.tokens.mintPrincipal('user:viewer', ['task:event:read'], undefined, 60 * 60 * 1000, project.organizationId);
  vi.spyOn(h.gateway as any, 'socketAuth').mockResolvedValue({ apiToken: minted.token });
  const connect = async () => {
    const ws = Object.assign(new EventEmitter(), { readyState: 1, send: vi.fn(), close: vi.fn(), bufferedAmount: 0 });
    await (h.gateway as any).eventStream(ws, { headers: {}, url: '/ws' });
    return {
      ws,
      watch: (body: unknown) => ws.emit('message', Buffer.from(JSON.stringify({ type: 'watch', ...body as object }))),
      received: () => ws.send.mock.calls.map(([data]) => JSON.parse(String(data))).filter((ev) => ev.type !== 'timing.setting')
        .map((ev) => `${ev.type} ${ev.taskId === open.id ? 'open' : ev.taskId === listed.id ? 'listed' : ev.taskId === attempt.id ? 'attempt' : 'foreign'}`),
      close: () => { ws.readyState = 3; ws.emit('close'); },
    };
  };
  const publish = async (events: Array<[string, string]>) => {
    for (const [taskId, type] of events) {
      const event = { taskId, type, ts: Date.now(), payload: type === 'agent.output' ? { source: 'assistant', text: 'chunk' } : { status: 'active' } };
      const seq = await h.store.appendEvent(event);
      (h.gateway as any).deps.bus.emit({ ...event, seq });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  return { h, project, open, listed, attempt, foreign, connect, publish };
}

it('marks live events from a non-principal attempt', async () => {
  const f = await fixture();
  const socket = await f.connect();
  try {
    await f.publish([[f.open.id, 'view.updated'], [f.attempt.id, 'view.updated']]);
    const sent = socket.ws.send.mock.calls.map(([data]) => JSON.parse(String(data))).filter((ev) => ev.type === 'view.updated');
    expect(sent.map((ev) => [ev.taskId, ev.siblingAttempt])).toEqual([[f.open.id, undefined], [f.attempt.id, true]]);
  } finally { socket.close(); await f.h.close(); }
});

it('streams detail only for watched tasks and lifecycle only from other projects', async () => {
  const f = await fixture();
  const watching = await f.connect();
  const legacy = await f.connect();
  try {
    watching.watch({ projectId: f.project.id, taskId: f.open.id });
    const burst: Array<[string, string]> = [];
    for (const task of [f.open.id, f.listed.id, f.foreign.id]) for (const type of ['agent.output', 'agent.activity', 'view.updated']) burst.push([task, type]);
    await f.publish(burst);
    expect(watching.received()).toEqual([
      'agent.output open', 'agent.activity open', 'view.updated open',
      'agent.activity listed', 'view.updated listed',
      'view.updated foreign',
    ]);
    // A tab that never says what it shows (an older console) still gets everything.
    expect(legacy.received()).toHaveLength(burst.length);
    // Leaving the task page narrows the stream again; clearing the project widens it.
    watching.ws.send.mockClear();
    watching.watch({ projectId: f.project.id, taskId: null });
    await f.publish([[f.open.id, 'agent.output'], [f.open.id, 'view.updated']]);
    expect(watching.received()).toEqual(['view.updated open']);
    watching.ws.send.mockClear();
    watching.watch({ projectId: null, taskId: null });
    await f.publish([[f.foreign.id, 'agent.activity'], [f.foreign.id, 'agent.output']]);
    expect(watching.received()).toEqual([]);
  } finally { watching.close(); legacy.close(); await f.h.close(); }
});

it('ignores malformed and oversized watch messages', async () => {
  const f = await fixture();
  const socket = await f.connect();
  try {
    socket.ws.emit('message', Buffer.from('{"type":"watch","projectId":5,"taskId":["x"]}'));
    socket.watch({ projectId: f.project.id.repeat(80), taskId: null });
    await f.publish([[f.listed.id, 'agent.output']]);
    expect(socket.received()).toEqual(['agent.output listed']);
  } finally { socket.close(); await f.h.close(); }
});
