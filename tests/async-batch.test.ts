import { expect, it } from 'vitest';
import { mapBatches } from '../src/util/async-batch.js';

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
