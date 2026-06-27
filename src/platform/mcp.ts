import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { KarmaxApi, CapabilityError } from './api.js';

/**
 * The platform MCP server (SPEC §3.4) — the single API agents use to act on the
 * system. One server given to every agent; integration is written once because
 * both Claude and Codex speak MCP. Every call carries the agent's scoped token
 * (injected into its config home env) and is permission-checked via KarmaxApi.
 */
export function createPlatformMcpServer(api: KarmaxApi, getToken: () => string): McpServer {
  const server = new McpServer({ name: 'karmax-platform', version: '1.0.0' });

  const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
  const wrap = async (fn: () => Promise<any>) => {
    try {
      const r = await fn();
      return ok(typeof r === 'string' ? r : JSON.stringify(r));
    } catch (e) {
      const msg = e instanceof CapabilityError ? `permission denied: ${e.message}` : `error: ${String((e as Error).message ?? e)}`;
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
  };

  server.registerTool(
    'create_task',
    {
      description: 'Create a new task on a project task list.',
      inputSchema: {
        projectId: z.string(),
        title: z.string(),
        prompt: z.string(),
        workflow: z.string().optional(),
      },
    },
    async (a) => wrap(async () => (await api.createTask(getToken(), a)).id),
  );

  server.registerTool(
    'get_task',
    { description: "Get a task's current view-model.", inputSchema: { taskId: z.string() } },
    async (a) => wrap(() => api.getTaskView(getToken(), a.taskId)),
  );

  server.registerTool(
    'list_tasks',
    { description: 'List tasks in a project.', inputSchema: { projectId: z.string() } },
    async (a) => wrap(async () => (await api.listTasks(getToken(), a.projectId)).map((t) => ({ id: t.id, title: t.title, workflow: t.workflow }))),
  );

  server.registerTool(
    'signal_task',
    {
      description: 'Send a signal to a task (confirm, cancel, retry, or followUp with text).',
      inputSchema: { taskId: z.string(), signal: z.enum(['confirm', 'cancel', 'retry', 'followUp']), text: z.string().optional() },
    },
    async (a) => wrap(async () => {
      await api.signalTask(getToken(), a.taskId, a.signal, a.text);
      return 'signalled';
    }),
  );

  server.registerTool(
    'reorder_queue',
    { description: 'Prioritize a task in a merge queue domain.', inputSchema: { domain: z.string(), taskId: z.string() } },
    async (a) => wrap(async () => {
      await api.reorderQueue(getToken(), a.domain, a.taskId);
      return 'reordered';
    }),
  );

  server.registerTool(
    'save_skill',
    { description: 'Save a reusable skill (markdown) for future tasks.', inputSchema: { name: z.string(), content: z.string() } },
    async (a) => wrap(() => api.saveSkill(getToken(), a)),
  );

  server.registerTool(
    'propose_workflow_edit',
    {
      description: 'Propose an edit to a workflow repo through the reviewed merge-only PR gate.',
      inputSchema: { projectId: z.string(), title: z.string(), repo: z.string(), branch: z.string(), target: z.string() },
    },
    async (a) => wrap(async () => (await api.proposeWorkflowEdit(getToken(), a)).id),
  );

  return server;
}
