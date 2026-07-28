import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildSdkTools, jsonSchemaToZodShape } from '../src/agent/claude.js';
import {
  MAX_REVIEW_TEXT_LENGTH,
  SDK_CONTROL_TOOL_SCHEMAS,
  TOOL_SCHEMAS,
  SDK_NATIVE_TOOLS,
  platformToolHandlers,
} from '../src/agent/tools.js';

/**
 * Cheap unit test (no Temporal). Guards the drift that hid `respond_to_sub_task` (and
 * `raise_to_parent` / `wait_for_subtasks`) from Claude-Code agents: the Agent-SDK path
 * used a hand-maintained tool list that fell out of sync with TOOL_SCHEMAS, so a parent
 * literally had no tool to confirm a child that raised to it. The SDK tool defs are now
 * derived from the shared schemas. Gateway-backed tools intentionally live only on
 * the stdio server, avoiding duplicate `karmax` registration.
 */
describe('Claude Agent-SDK tool exposure (no drift)', () => {
  // Fake SDK `tool()` + handlers so we can build the defs without the real SDK/login.
  const fakeTool = (name: string, description: string, shape: Record<string, any>, run: any) => ({ name, description, shape, run });
  const allHandlers = Object.fromEntries(TOOL_SCHEMAS.map((t) => [t.name, async () => 'ok']));

  it('exposes every turn-local control and no gateway-backed platform tools', () => {
    const defs = buildSdkTools(fakeTool as any, z, allHandlers as any);
    const names = defs.map((d: any) => d.name).sort();
    expect(names).toEqual(SDK_CONTROL_TOOL_SCHEMAS.map((t) => t.name).sort());
    // The specific tools whose absence caused the bug:
    expect(names).toEqual(expect.arrayContaining(['respond_to_sub_task', 'raise_to_parent', 'wait_for_subtasks']));
    expect(names).not.toEqual(expect.arrayContaining(['find_task', 'platform_request', 'save_skill']));
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

  it('describes review info as optional verification-only affordances', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'create_review_info')!;
    expect(schema.description).toMatch(/^Optional\./);
    expect(schema.description).toMatch(/human-readable outputs/i);
    expect(schema.description).toMatch(/Source code is not/i);
    expect(schema.parameters.properties.caption).toMatchObject({
      type: 'string',
      maxLength: MAX_REVIEW_TEXT_LENGTH,
    });
    // Free-form legacy payloads remain readable internally, but are no longer
    // advertised to agents as valid review-info content.
    expect(schema.parameters.properties).not.toHaveProperty('summary');
    expect(schema.parameters.properties).not.toHaveProperty('diff');
    expect(schema.parameters.properties).not.toHaveProperty('html');
  });

  it('enforces the review caption limit in the Agent-SDK input shape', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'create_review_info')!;
    const obj = z.object(jsonSchemaToZodShape(z, schema.parameters));
    expect(obj.safeParse({ caption: 'x'.repeat(MAX_REVIEW_TEXT_LENGTH) }).success).toBe(true);
    expect(obj.safeParse({ caption: 'x'.repeat(MAX_REVIEW_TEXT_LENGTH + 1) }).success).toBe(false);
    // Astral characters are one Unicode character each even though JS stores
    // each as two UTF-16 code units.
    expect(obj.safeParse({ caption: '😀'.repeat(MAX_REVIEW_TEXT_LENGTH) }).success).toBe(true);
  });

  /**
   * Regression: `jsonPropToZod` collapsed nested `items`/`properties` to `any`, so the
   * schema the model is shown advertised `actions: { items: {} }` — no member field
   * names at all — even though the source schema fully specifies them. Agents then
   * guessed the shape (e.g. `{ label, run }` instead of `{ kind, label, command }`)
   * and their review actions were silently discarded.
   */
  it('preserves nested array item schemas (create_review_info.actions)', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'create_review_info')!;
    const obj = z.object(jsonSchemaToZodShape(z, schema.parameters));
    // Well-formed actions validate…
    expect(obj.safeParse({ actions: [{ kind: 'run', label: 'Tests', command: 'npm test' }] }).success).toBe(true);
    expect(obj.safeParse({ actions: [{ kind: 'open', label: 'Report', target: 'out/report.html' }] }).success).toBe(true);
    // …and the item contract is enforced rather than rubber-stamped.
    expect(obj.safeParse({ actions: [{ kind: 'bogus', label: 'x' }] }).success).toBe(false); // enum
    expect(obj.safeParse({ actions: [{ label: 'no kind' }] }).success).toBe(false); // required member
    expect(obj.safeParse({ actions: [{ kind: 'run', label: 'x', server: 'yes' }] }).success).toBe(false); // boolean
    expect(obj.safeParse({ actions: [{ kind: 'run', label: 'x', openUrls: [1] }] }).success).toBe(false); // nested array
  });

  it('treats an untyped property as free-form instead of coercing it to a string', () => {
    const obj = z.object(jsonSchemaToZodShape(z, { type: 'object', properties: { body: {} } }));
    // An empty JSON Schema means "anything goes"; `string()` rejected structured values.
    expect(obj.safeParse({ body: { name: 'x' } }).success).toBe(true);
    expect(obj.safeParse({ body: [1, 2] }).success).toBe(true);
    expect(obj.safeParse({ body: 'raw' }).success).toBe(true);
  });

  it('rejects overlong review text without recording it and tells the agent why', async () => {
    let recorded: any;
    const handlers = platformToolHandlers({} as any, {
      createReviewInfo: (info: any) => { recorded = info; },
    } as any);

    await expect(handlers.create_review_info!({ caption: 'x'.repeat(MAX_REVIEW_TEXT_LENGTH) }))
      .resolves.toBe('review info recorded');
    expect(recorded.caption).toHaveLength(MAX_REVIEW_TEXT_LENGTH);

    await expect(handlers.create_review_info!({ caption: '😀'.repeat(MAX_REVIEW_TEXT_LENGTH) }))
      .resolves.toBe('review info recorded');

    recorded = undefined;
    const rejected = await handlers.create_review_info!({ caption: 'x'.repeat(MAX_REVIEW_TEXT_LENGTH + 1) });
    expect(rejected).toMatch(/rejected.*281 characters.*maximum is 280/i);
    expect(recorded).toBeUndefined();

    // A resumed session may still use the old free-form field; it must not bypass
    // the limit merely because that field is no longer in the advertised schema.
    const legacy = await handlers.create_review_info!({ summary: 'x'.repeat(MAX_REVIEW_TEXT_LENGTH + 1) });
    expect(legacy).toMatch(/rejected.*summary/i);
    expect(recorded).toBeUndefined();
  });
});
