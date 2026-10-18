import { expect, it } from 'vitest';
import { agentPlatformResponse, agentTaskView, boundedJson, compactTaskView, selectFields } from '../src/platform/platform-request.js';
import { TOOL_SCHEMAS } from '../src/agent/tools.js';

// get_task, search and a PATCH reply through platform_request returned 100–350k
// characters, mostly the prompt repeated (messages, then each transcript), and
// overflowed the asking agent's context.
const prompt = 'p'.repeat(120_000);
const view = {
  taskId: 't1', title: 'Big', stage: 'do', status: 'waiting', waitingFor: { kind: 'job', detail: 'Waiting for render', until: 1 },
  messages: [{ id: 'm0', role: 'user', text: prompt, ts: 1 }, { id: 'm1', role: 'agent', author: 'agent:do', text: 'Done with the first pass.', ts: 2 }],
  transcripts: [{ role: 'do', messages: [{ id: 'm0', role: 'user', text: prompt, ts: 1 }] }],
  reviewInfo: { caption: 'Check it', html: '<p>'.repeat(10_000) },
  subTasks: [{ taskId: 'c1', title: 'Child', stage: 'review' }],
};

it('get_task leaves out the conversation unless asked, and keeps every other field', () => {
  const compact = JSON.parse(agentTaskView(view));
  expect(JSON.stringify(compact).length).toBeLessThan(2_000);
  expect(compact).toMatchObject({ taskId: 't1', stage: 'do', status: 'waiting', waitingFor: { kind: 'job' }, subTasks: [{ taskId: 'c1' }],
    messageCount: 2, lastMessage: { role: 'agent', author: 'agent:do', text: 'Done with the first pass.' }, transcriptRoles: ['do'],
    reviewInfo: { caption: 'Check it' } });
  expect(compact.messages).toBeUndefined();
  expect(compact.reviewInfo.html).toBeUndefined();
  expect(JSON.parse(agentTaskView(view, ['stage', 'waitingFor.detail', 'subTasks.title'])))
    .toEqual({ stage: 'do', waitingFor: { detail: 'Waiting for render' }, subTasks: [{ title: 'Child' }] });
  // The conversation itself on request, within the limit or described.
  const asked = JSON.parse(agentTaskView(view, ['messages']));
  expect(asked).toMatchObject({ truncated: true, fieldSizes: { messages: expect.any(Number) } });
});

it('a long last message is shortened in the compact view', () => {
  const long = compactTaskView({ ...view, messages: [{ id: 'm', role: 'agent', text: 'x'.repeat(10_000), ts: 3 }] }) as any;
  expect(long.lastMessage.text.length).toBeLessThan(2_200);
  expect(long.lastMessage.text).toMatch(/10000 characters; fields: \["messages"\] for all/);
});

it('platform_request describes a response too large to return, and returns the fields asked for', () => {
  const described = JSON.parse(agentPlatformResponse(view));
  expect(described).toMatchObject({ truncated: true, characters: expect.any(Number), fieldSizes: { messages: expect.any(Number), stage: 4 } });
  expect(described.note).toMatch(/Ask again with fields/);
  expect(JSON.parse(agentPlatformResponse({ applied: ['computer'], view }, ['applied', 'view.stage'])))
    .toEqual({ applied: ['computer'], view: { stage: 'do' } });
  const list = Array.from({ length: 2_000 }, (_, i) => ({ id: `t${i}`, title: 'x'.repeat(40), params: { prompt: 'y'.repeat(100) } }));
  expect(JSON.parse(boundedJson(list))).toMatchObject({ truncated: true, items: 2_000, itemFields: { id: expect.any(Number), params: expect.any(Number) } });
  expect((selectFields(list, ['id']) as unknown[]).slice(0, 2)).toEqual([{ id: 't0' }, { id: 't1' }]);
  expect(JSON.parse(agentPlatformResponse({ small: true }))).toEqual({ small: true });
});

it('both tools advertise fields', () => {
  for (const name of ['get_task', 'platform_request'])
    expect(TOOL_SCHEMAS.find((tool) => tool.name === name)!.parameters.properties.fields).toMatchObject({ type: 'array' });
});
