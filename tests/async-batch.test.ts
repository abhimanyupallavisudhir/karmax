import { expect, it } from 'vitest';
import { mapBatches, forEachConcurrent } from '../src/util/async-batch.js';

it('bounds concurrent requests and preserves file bytes and order', async () => {
 let active=0, peak=0;
 const files=Array.from({length:21},(_,i)=>`file-${i}`);
 const result=await mapBatches(files, async file=>{
  peak=Math.max(peak,++active);
  await new Promise(resolve=>setTimeout(resolve,1));active--;
  return Buffer.from(file);
 });
 expect(peak).toBe(8);expect(active).toBe(0);
 expect(result).toEqual(files.map(file => Buffer.from(file)));
});

it('settles in-flight reads before failure and does not start later batches', async () => {
 const calls:string[]=[];let release!:()=>void;let finished=false;
 const pending=new Promise<void>(resolve=>{release=resolve;});
 const error=new Error('read unavailable');
 const result=mapBatches(['bad','slow','never'],async file=>{
  calls.push(file);if(file==='bad')throw error;
  await pending;finished=true;return Buffer.from(file);
 },2);
 let settled=false;const checked=expect(result).rejects.toBe(error).then(()=>{settled=true;});
 await Promise.resolve();await Promise.resolve();expect(settled).toBe(false);
 release();await checked;expect(finished).toBe(true);expect(calls).toEqual(['bad','slow']);
});


it('uses available transfer slots while a large file is still running', async () => {
  let release!: () => void;
  const large = new Promise<void>(resolve => { release = resolve; });
  let active = 0, maximum = 0;
  const finished: number[] = [];
  try {
    await forEachConcurrent([0, 1, 2, 3, 4, 5, 6, 7], async i => {
      active++; maximum = Math.max(maximum, active);
      if (i === 0) await large;
      else await Promise.resolve();
      if (i === 7) { expect(finished).not.toContain(0); release(); }
      finished.push(i); active--;
    }, 4);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(finished).toHaveLength(8);
  } finally { release(); }
});

it('stops scheduling after failure and waits for active writes before rejecting', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [], settled: number[] = [];
  let returned = false;
  const result = forEachConcurrent([0, 1, 2, 3, 4, 5], async i => {
    started.push(i);
    if (i === 0) throw new Error('bad data');
    await pending; settled.push(i);
  }, 4).catch(e => { returned = true; return e; });
  await Promise.resolve(); await Promise.resolve();
  expect(returned).toBe(false);
  expect(started).toEqual([0, 1, 2, 3]);
  release();
  expect((await result).message).toBe('bad data');
  expect(settled).toEqual([1, 2, 3]);
  expect(started).toHaveLength(4);
});
