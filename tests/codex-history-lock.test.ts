import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, it } from 'vitest';

it('serializes publishers and automatically releases a killed worker lock', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-history-lock-'));
  const children: ChildProcess[] = [];
  const start = (script: string, typescript = false) => {
    const child = spawn(process.execPath, [...(typescript ? ['--import', 'tsx', '--input-type=module'] : []), '-e', script, home],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    child.stdout!.on('data', (chunk) => { output += chunk; });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    return { child, exited, output: () => output,
      ready: () => new Promise<void>((resolve) => child.stdout!.once('data', () => resolve())) };
  };
  try {
    const holder = start(`const {DatabaseSync}=require('node:sqlite'); const path=require('node:path');
      const db=new DatabaseSync(path.join(process.argv[1],'.karmax-history-publish.sqlite'));
      db.exec('BEGIN IMMEDIATE'); process.stdout.write('held'); setInterval(()=>{},1000);`);
    await holder.ready();
    const module = new URL('../src/agent/codex-history-files.ts', import.meta.url).href;
    const publisher = start(`import {publishLocalCodexHistory} from ${JSON.stringify(module)};
      process.stdout.write('trying'); publishLocalCodexHistory(process.argv[1],
        {file:'rollout-2026-09-09T00-00-00-11111111-1111-4111-8111-111111111111.jsonl',content:Buffer.from('durable history\\n')},
        '11111111-1111-4111-8111-111111111111'); process.stdout.write('published');`, true);
    await publisher.ready();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(publisher.output()).toBe('trying');
    holder.child.kill('SIGKILL');
    await holder.exited;
    expect(await publisher.exited).toBe(0);
    expect(publisher.output()).toBe('tryingpublished');
    const files = fs.readdirSync(path.join(home, 'sessions', 'forked'));
    expect(fs.readFileSync(path.join(home, 'sessions', 'forked', files[0]!), 'utf8')).toBe('durable history\n');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 10_000);
