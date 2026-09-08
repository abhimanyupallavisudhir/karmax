import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { World } from '../src/world/types.js';
import { CodexAppServerClient } from '../src/agent/codex-app-server-client.js';
import { localProviderCli } from '../src/agent/provider-cli.js';
import { codexDynamicTools } from '../src/agent/codex.js';
import { materializeRemoteSession, seedRemoteAgentHome, syncRemoteAgentHome,
  ensureRemoteCodexSessionTools, remoteAgentHomeRelative } from '../src/agent/remote-process.js';

// Real files, shell commands, and the pinned Codex app-server. Only the model's
// HTTP Responses endpoint is simulated: no credentials or paid inference.
function diskWorld(root: string): World {
  fs.mkdirSync(root, { recursive: true });
  const write = async (file: string, content: string | Buffer) => {
    const dest = path.join(root, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  };
  return {
    handle: { root },
    readFile: async (file: string) => fs.readFileSync(path.join(root, file), 'utf8'),
    readFileBuffer: async (file: string) => fs.readFileSync(path.join(root, file)),
    writeFile: write, writeFileBuffer: write,
    exec: async (command: string, args: string[]) => {
      const r = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
      if (r.error) throw r.error;
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    },
  } as unknown as World;
}

function rollouts(home: string): string[] {
  return fs.readdirSync(path.join(home, 'sessions'), { recursive: true })
    .map(String).filter((file) => file.endsWith('.jsonl')).map((file) => path.join(home, 'sessions', file));
}

async function appServer<T>(home: string, run: (client: CodexAppServerClient) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, [localProviderCli('codex'), 'app-server'], {
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const exited = once(child, 'exit');
  const client = new CodexAppServerClient(child.stdin, child.stdout);
  try {
    await client.request('initialize', { clientInfo: { name: 'karmax-test', version: '1' },
      capabilities: { experimentalApi: true } });
    client.notify('initialized');
    return await run(client);
  } catch (error) { throw new Error(`${error}\n${stderr}`); }
  finally { client.close(); child.kill('SIGTERM'); await exited; }
}

async function turn(client: CodexAppServerClient, threadId: string, text: string): Promise<void> {
  const completed = new Promise<any>((resolve) => {
    client.onNotification((method, params) => {
      if (method === 'turn/completed') resolve(params.turn);
    });
  });
  await client.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  expect(await completed).toMatchObject({ status: 'completed' });
}

it.each(['live source', 'deleted source'])('forks and resumes nested lineage with a %s and stale host snapshots', async (scenario) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-lineage-e2e-'));
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(body);
    const item = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'lineage verified', annotations: [] }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: `resp_${requests.length}`, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `resp_${requests.length}`, status: 'completed', output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = (server.address() as { port: number }).port;
    const host = path.join(dir, 'host');
    fs.mkdirSync(host);
    fs.writeFileSync(path.join(host, 'config.toml'), `model = "gpt-5.4"\nmodel_provider = "fixture"\n` +
      `[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}"\nwire_api = "responses"\n`);
    const source = diskWorld(path.join(dir, 'source'));
    const sourceHome = await seedRemoteAgentHome(source, 'codex', host);
    let root = '';
    await appServer(sourceHome.absolute, async (client) => {
      root = (await client.request('thread/start', { cwd: source.handle.root, dynamicTools: codexDynamicTools(true),
        approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id;
      await turn(client, root, 'inherited-root-marker');
      // The host cache is now one completed turn behind the live source.
      await syncRemoteAgentHome(source, 'codex', sourceHome, host);
      await turn(client, root, 'newest-source-marker');
    });
    const stale = rollouts(host).find((file) => file.endsWith(`${root}.jsonl`))!;
    const staleBytes = fs.readFileSync(stale);
    let staleParent: Buffer | undefined;
    let parent = root;
    let from = source;
    for (let generation = 0; generation < 2; generation++) {
      const destination = diskWorld(path.join(dir, `destination-${generation}`));
      const relative = remoteAgentHomeRelative('codex', host);
      // Reproduce an already-failed world's stale dated copy as well as a new world.
      if (generation === 1) await destination.writeFileBuffer!(
        `${relative}/${path.relative(host, stale)}`, staleBytes);
      if (generation === 1 && scenario === 'deleted source') {
        // Keep both files and a real persisted Codex index from an earlier
        // attempt. The source task has now landed, so its sandbox is gone and
        // only host-cache preparation can repair these existing aliases.
        for (const file of rollouts(host)) await destination.writeFileBuffer!(
          `${relative}/${path.relative(host, file)}`, fs.readFileSync(file));
        const parentFile = rollouts(host).find((file) => file.endsWith(`${parent}.jsonl`))!;
        await destination.writeFileBuffer!(`${relative}/sessions/forked/${path.basename(parentFile)}`, fs.readFileSync(parentFile));
        await destination.writeFileBuffer!(`${relative}/${path.relative(host, parentFile)}`, staleParent!);
        await destination.writeFile(`${relative}/config.toml`, fs.readFileSync(path.join(host, 'config.toml'), 'utf8'));
        await appServer(path.join(destination.handle.root, relative), async (client) => {
          await client.request('thread/resume', { threadId: parent,
            path: path.join(destination.handle.root, relative, 'sessions/forked', path.basename(parentFile)),
            cwd: destination.handle.root, approvalPolicy: 'never', sandbox: 'danger-full-access' });
        });
        fs.rmSync(from.handle.root, { recursive: true, force: true });
      } else {
        expect(await materializeRemoteSession(from, destination, 'codex', parent, host)).toBe(true);
      }
      const home = await seedRemoteAgentHome(destination, 'codex', host, parent);
      expect(await ensureRemoteCodexSessionTools(destination, home, parent, codexDynamicTools(true))).toBe(true);
      let child = '';
      await appServer(home.absolute, async (client) => {
        child = (await client.request('thread/fork', { threadId: parent, cwd: destination.handle.root,
          developerInstructions: 'Continue the inherited conversation.', approvalPolicy: 'never', sandbox: 'danger-full-access' })).thread.id;
        await turn(client, child, `generation-${generation}-marker`);
        expect(requests.at(-1)).toContain('inherited-root-marker');
        expect(requests.at(-1)).toContain('newest-source-marker');
      });
      expect(rollouts(home.absolute).filter((file) => file.endsWith(`${root}.jsonl`))).toHaveLength(1);
      expect(rollouts(home.absolute).filter((file) => file.endsWith(`${parent}.jsonl`))).toHaveLength(1);
      staleParent = fs.readFileSync(rollouts(home.absolute).find((file) => file.endsWith(`${child}.jsonl`))!);
      // Restart the real process and resume the fork before exporting it.
      await appServer(home.absolute, async (client) => {
        await client.request('thread/resume', { threadId: child, cwd: destination.handle.root,
          approvalPolicy: 'never', sandbox: 'danger-full-access' });
        await turn(client, child, `resumed-${generation}-marker`);
      });
      await syncRemoteAgentHome(destination, 'codex', home, host);
      from = destination;
      parent = child;
    }
    expect(requests).toHaveLength(6);
    expect(requests.at(-1)).toContain('generation-0-marker');
    expect(requests.at(-1)).toContain('resumed-0-marker');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
