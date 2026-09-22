import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { bootHarness, type Harness } from './helpers/harness.js';
import { MockAdapter } from '../src/agent/mock.js';
import { connectWorldMcp } from '../src/mcp/connections/client.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { newId } from '../src/util/id.js';

/** Exercises real workflow history, activity preparation, subprocess tool use,
 * Review transition and cleanup. Only the model decision is deterministic. */
describe('MCP task workflow end to end', () => {
  let harness: Harness; const configFiles: string[] = []; const observed: any[] = [];
  beforeAll(async () => {
    const mock = new MockAdapter();
    harness = await bootHarness('mock', { provider: 'mock', async runTurn(input, ctx) {
      const server = input.agentMcp?.find((s) => s.name.startsWith('mcp_'));
      if (server) {
        configFiles.push(server.args![1]!);
        const client = await connectWorldMcp(input.world, server, ctx.signal);
        try {
          const result = await client.callTool({ name: 'echo', arguments: { text: 'workflow round trip' } }) as any;
          observed.push(JSON.parse(result.content[0].text));
          await input.world.writeFile('mcp-result.txt', 'workflow round trip\n');
        } finally { await client.close(); }
      }
      return mock.runTurn(input, ctx);
    } });
  }, 90_000);
  afterAll(async () => { await harness?.stop(); });
  it('selects a project connection, invokes it, enters Review, and keeps its secret out of history', async () => {
    const repo = await harness.makeRepo('mcp-workflow');
    const project = (await harness.store.createProject('MCP workflow', { repos: [repo] }));
    const service = new McpConnections(harness.store, harness.broker, project.organizationId ?? 'org_personal');
    const connection = (await service.save({ label: 'Workflow fixture', transport: { type: 'stdio', command: process.execPath, args: [path.resolve('tests/fixtures/mcp-hostile.mjs')] }, auth: 'secrets', secrets: { FIXTURE_SECRET: 'workflow-vault-only' } }, project.id));
    const taskId = newId('task');
    const handle = await harness.client.workflow.start('softwareDev', { taskQueue: TASK_QUEUE, workflowId: taskId, args: [{
      taskId, projectId: project.id, title: 'MCP workflow', prompt: '@review MCP complete', base: 'main', target: 'main',
      agents: { do: { provider: 'mock', mcpConnections: [connection.id] } },
      project: { repos: [repo], defaultBase: 'main', defaultTarget: 'main' },
    }] });
    try {
      await expect.poll(async () => (await handle.query<any>('view')).stage, { timeout: 30_000 }).toBe('review');
      expect(observed).toMatchObject([{ text: 'workflow round trip', secret: 'workflow-vault-only', platform: null }]);
      expect(configFiles).toHaveLength(1); expect(fs.existsSync(configFiles[0]!)).toBe(false);
      const history = JSON.stringify(await handle.fetchHistory());
      expect(history).not.toContain('workflow-vault-only');
      expect(history).not.toContain(Buffer.from('workflow-vault-only').toString('base64'));
    } finally { await handle.signal('cancel'); await handle.result().catch(() => {}); }
  }, 45_000);
});
