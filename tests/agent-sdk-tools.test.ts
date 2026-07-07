import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildSdkTools, jsonSchemaToZodShape } from '../src/agent/claude.js';
import { PLATFORM_TOOL_SCHEMAS, TOOL_SCHEMAS, SDK_NATIVE_TOOLS } from '../src/agent/tools.js';

/**
 * Cheap unit test (no Temporal). Guards the drift that hid `respond_to_sub_task` (and
 * `raise_to_parent` / `wait_for_subtasks`) from Claude-Code agents: the Agent-SDK path
 * used a hand-maintained tool list that fell out of sync with TOOL_SCHEMAS, so a parent
 * literally had no tool to confirm a child that raised to it. The SDK tool defs are now
 * DERIVED from PLATFORM_TOOL_SCHEMAS — this test asserts they cover the full platform set.
 */
describe('Claude Agent-SDK tool exposure (no drift)', () => {
  // Fake SDK `tool()` + handlers so we can build the defs without the real SDK/login.
  const fakeTool = (name: string, description: string, shape: Record<string, any>, run: any) => ({ name, description, shape, run });
  const allHandlers = Object.fromEntries(TOOL_SCHEMAS.map((t) => [t.name, async () => 'ok']));

  it('exposes EVERY platform tool (incl. the ones that were missing)', () => {
    const defs = buildSdkTools(fakeTool as any, z, allHandlers as any);
    const names = defs.map((d: any) => d.name).sort();
    expect(names).toEqual(PLATFORM_TOOL_SCHEMAS.map((t) => t.name).sort());
    // The specific tools whose absence caused the bug:
    expect(names).toEqual(expect.arrayContaining(['respond_to_sub_task', 'raise_to_parent', 'wait_for_subtasks']));
    // Read/Write/Bash are provided natively by the SDK and must NOT be re-registered:
    for (const native of SDK_NATIVE_TOOLS) expect(names).not.toContain(native);
  });

  it('drops a tool only when its handler is missing (defensive)', () => {
    const partial = { ...allHandlers } as any;
    delete partial.respond_to_sub_task;
    const names = buildSdkTools(fakeTool as any, z, partial).map((d: any) => d.name);
    expect(names).not.toContain('respond_to_sub_task');
    expect(names).toContain('create_sub_task');
  });

  it('generates a working zod shape for respond_to_sub_task (enum + required)', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'respond_to_sub_task')!;
    const shape = jsonSchemaToZodShape(z, schema.parameters);
    const obj = z.object(shape);
    expect(obj.safeParse({ action: 'confirm' }).success).toBe(true); // required enum ok
    expect(obj.safeParse({ action: 'confirm', child_task_id: 't1', text: 'hi' }).success).toBe(true);
    expect(obj.safeParse({ action: 'not-an-action' }).success).toBe(false); // enum enforced
    expect(obj.safeParse({}).success).toBe(false); // action is required
  });
});
