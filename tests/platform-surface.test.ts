import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  PLATFORM_REQUEST_BODY_SCHEMA, PLATFORM_REQUEST_EXCLUDED_PATHS, PRIORITY_NAMES,
  normalizePlatformPath, platformRequestPathError,
} from '../src/platform/platform-request.js';
import { TOOL_SCHEMAS } from '../src/agent/tools.js';

/**
 * karmax gives agents the SAME platform surface twice: as MCP tools
 * (`src/platform/mcp.ts`, what Claude sees) and as provider-neutral JSON-Schema
 * tool definitions (`src/agent/tools.ts`, what Codex and remote-world agents
 * see). They drifted — the in-agent copy of the `platform_request` deny-list
 * knew only `/api/login` and `/api/setup` while the MCP copy knew nine more, so
 * which surface an agent happened to be running on decided whether it could
 * `POST /api/auth/sign-up/email` and mint itself a human login.
 *
 * `src/platform/platform-request.ts` is the single definition both import. These
 * tests pin that they really are one definition and cannot silently fork again.
 */
describe('the two agent-facing platform surfaces share one definition', () => {
  const tool = (name: string) => TOOL_SCHEMAS.find((candidate) => candidate.name === name)!;

  it('advertises the same concrete platform_request body schema on both surfaces', () => {
    // Declared `z.unknown()`, `body` serialized to an EMPTY JSON Schema (`{}`),
    // and clients dropped the argument before it left the caller — every write
    // silently reached the gateway with `{}`.
    expect(Object.keys(PLATFORM_REQUEST_BODY_SCHEMA)).not.toHaveLength(0);
    expect(tool('platform_request').parameters.properties!.body).toBe(PLATFORM_REQUEST_BODY_SCHEMA);

    // The zod union registered on the MCP surface must accept exactly what the
    // JSON-Schema arm advertises: object, array, or (parsed) string.
    const zodBody = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]);
    for (const value of [{ name: 'bug' }, [1, 2], '{"a":1}', 'plain']) {
      expect(zodBody.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
    expect(PLATFORM_REQUEST_BODY_SCHEMA.anyOf.map((arm) => arm.type).slice().sort())
      .toEqual(['array', 'object', 'string']);
  });

  it('refuses every pre-session-gate route, and says why', () => {
    for (const excluded of PLATFORM_REQUEST_EXCLUDED_PATHS) {
      const probe = excluded.endsWith('/') ? `${excluded}thing` : excluded;
      expect(platformRequestPathError(probe), probe).toMatch(/excluded from platform_request/);
    }
    // The live escalation this closes: Better Auth sign-up is forwarded ahead of
    // the capability gate, so it needed no `user:write` at all.
    expect(platformRequestPathError('/api/auth/sign-up/email')).toMatch(/authenticated authorization\/user administration routes with user:write/);
    // Query strings and sub-paths do not evade the list.
    expect(platformRequestPathError('/api/signup?x=1')).toBeDefined();
    expect(platformRequestPathError('/api/github/webhook/extra')).toBeDefined();
    // A route that only *starts* like an excluded one is still allowed.
    expect(platformRequestPathError('/api/setup-guides')).toBeUndefined();
    expect(platformRequestPathError('/api/projects/p1/tasks')).toBeUndefined();
    expect(platformRequestPathError('/etc/passwd')).toMatch(/must start with \/api\//);
  });

  /**
   * The deny-list screened the RAW path while both dispatchers reach the gateway
   * by concatenation — `fetch(`${base}${path}`)` — and the gateway re-parses the
   * result with `new URL(req.url, …)`. Every hop runs the WHATWG URL parser,
   * which resolves `.`/`..`, so `/api/tasks/../auth/sign-up/email` was screened
   * as a task route and *arrived* as `/api/auth/sign-up/email`: a complete
   * bypass of the escalation fix above, reachable from both agent surfaces.
   *
   * The invariant: the string that is screened is the string that is sent.
   */
  it('resolves dot-segments before screening, so traversal cannot reach a pre-gate route', () => {
    for (const probe of [
      '/api/tasks/../auth/sign-up/email',
      '/api/x/../../api/auth/sign-up/email',
      '/api/./auth/sign-up/email',
      '/api/projects/p1/../../signup',
      '/api//auth/sign-up/email', // duplicate slashes collapse too
    ]) {
      // Each of these really does resolve onto an excluded route…
      expect(normalizePlatformPath(probe).split('?')[0], probe)
        .toMatch(/^\/api\/(auth\/sign-up\/email|signup)$/);
      // …so each must be refused.
      expect(platformRequestPathError(probe), probe).toMatch(/excluded from platform_request/);
    }

    // `..` can also climb clean out of the API surface entirely.
    expect(platformRequestPathError('/api/../admin')).toMatch(/must start with \/api\//);

    // Legitimate paths are untouched, including a genuine `..`-free query string.
    expect(platformRequestPathError('/api/projects/p1/tasks?q=is%3Aopen')).toBeUndefined();
    expect(normalizePlatformPath('/api/projects/p1/tasks?q=a%2Fb')).toBe('/api/projects/p1/tasks?q=a%2Fb');
    // An encoded `..` is NOT a traversal — the gateway receives it as a literal
    // segment — so it must not be over-eagerly refused.
    expect(platformRequestPathError('/api/tasks/..%2fauth/sign-up')).toBeUndefined();
  });

  /**
   * `create_task` used to expose only project/title/prompt/workflow, which
   * forced an agent to the undocumented `platform_request` body shape for the
   * single most routine operation on the system (a draft, a priority, a tag, or
   * a trigger). Both surfaces must offer the full set.
   */
  it('lets create_task express drafts, priority, tags and full form params on both surfaces', () => {
    const properties = tool('create_task').parameters.properties!;
    for (const field of ['draft', 'priority', 'tags', 'params']) {
      expect(Object.keys(properties), `create_task.${field}`).toContain(field);
    }
    expect((properties.priority as { enum: string[] }).enum).toEqual([...PRIORITY_NAMES]);
  });
});
