import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

describe('karmax attach CLI', () => {
  it('relays terminal input, output, and resize frames', async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    let requested = '';
    const frames: any[] = [];
    server.on('connection', (socket, request) => {
      requested = request.url ?? '';
      socket.send(JSON.stringify({ type: 'data', data: 'REMOTE_OK\n' }));
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        if (frame.type === 'input') socket.close(1000);
      });
    });
    const child = spawn(process.execPath, [path.resolve('bin/karmax.js'), 'attach', 'task-7',
      '--url', `http://127.0.0.1:${address.port}`, '--ticket', 'once'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.write('echo hello\n');
    const [code] = await once(child, 'exit') as [number];
    server.close();
    expect(code, stderr).toBe(0);
    expect(requested).toContain('/ws/terminal?taskId=task-7&ticket=once');
    expect(stdout).toContain('REMOTE_OK');
    expect(frames).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'resize' }),
      { type: 'input', data: 'echo hello\n' },
    ]));
  });
});
