import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaytonaWorldProvider } from '../src/world/daytona.js';
import { buildEnvironment } from '../src/world/environment-build.js';

const sdk = vi.hoisted(() => ({ constructors: [] as unknown[], list: vi.fn(), create: vi.fn(), dispose: vi.fn() }));
vi.mock('@daytona/sdk', () => ({
  DaytonaAuthorizationError: class extends Error {},
  Daytona: class {
    constructor(options: unknown) { sdk.constructors.push(options); }
    list = sdk.list;
    snapshot = { create: sdk.create };
    [Symbol.asyncDispose] = sdk.dispose;
  },
  Image: { base: (base: string) => ({ base, runCommands: (...commands: string[]) => ({ base, commands }) }) },
}));
afterEach(() => { vi.clearAllMocks(); sdk.constructors.length = 0; });

describe('Daytona SDK boundary', () => {
  it('explains missing snapshot permissions and disposes the build client', async () => {
    const { DaytonaAuthorizationError } = await import('@daytona/sdk');
    sdk.create.mockRejectedValueOnce(new DaytonaAuthorizationError('Access denied'));
    await expect(buildEnvironment({ provider: 'daytona', projectId: 'project', digest: 'denied', spec: {} }))
      .rejects.toThrow('write:snapshots');
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });

  it('consumes the paginated iterator and passes labels in the query object', async () => {
    const deleted: string[] = [];
    sdk.list.mockImplementation(async function* (query) {
      expect(query.labels).toHaveProperty('karmaxHome');
      for (const id of ['page-one', 'page-two']) yield {
        id, labels: { ...query.labels, karmaxTaskId: id }, delete: async () => { deleted.push(id); },
      };
      yield { id: 'foreign', labels: { karmaxHome: 'another-installation' } };
    });
    const provider = new DaytonaWorldProvider(undefined, undefined, undefined, undefined,
      () => ({ apiKey: 'secret', config: {}, provider: 'daytona' }));
    const found = await provider.listSandboxes('org');
    expect(found.map((s) => s.taskId)).toEqual(['page-one', 'page-two']);
    await found[0]!.destroy();
    expect(deleted).toEqual(['page-one']);
  });

  it('replaces clients when endpoint or keys change, including equal key suffixes', async () => {
    sdk.list.mockImplementation(async function* () {});
    const connection = { apiKey: 'one-same-suffix', config: { apiUrl: 'https://first.invalid' }, provider: 'daytona' };
    const provider = new DaytonaWorldProvider(undefined, undefined, undefined, undefined, () => connection);
    await provider.listSandboxes('org');
    connection.apiKey = 'two-same-suffix';
    await provider.listSandboxes('org');
    connection.config.apiUrl = 'https://second.invalid';
    await provider.listSandboxes('org');
    expect(sdk.constructors).toHaveLength(3);
  });

  it('bounds snapshot builds in seconds and disposes the build client on failure', async () => {
    sdk.create.mockRejectedValueOnce(new Error('build failed'));
    sdk.dispose.mockResolvedValue(undefined);
    await expect(buildEnvironment({ provider: 'daytona', projectId: 'project', digest: 'abc',
      spec: { image: 'ubuntu:24.04', setup: ['echo built'] } as any,
      connection: { apiKey: 'secret' },
    })).rejects.toThrow('build failed');
    expect(sdk.create).toHaveBeenCalledWith({ name: 'karmax-env-project-abc',
      image: { base: 'ubuntu:24.04', commands: ['echo built'] } }, { timeout: 2700 });
    expect(sdk.dispose).toHaveBeenCalledOnce();
  });
});
