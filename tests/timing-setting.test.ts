import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TimingTrace, timingEnabled, installationTiming, withTiming, currentTiming } from '../src/timing/index.js';
it('defaults off, explicitly opts in, stops active traces and preserves history', async () => {
 const store = (await Store.create(':memory:')); const rows: any[] = [];
 expect((await timingEnabled(store))).toBe(false);
 const off = (await installationTiming(store, {taskId:'t'}, r => rows.push(r)));
 await withTiming(off, () => off.measure('work', async () => { expect((await currentTiming())).toBeUndefined(); return 42; }));
 expect(rows).toHaveLength(0);
 (await store.setSettings('global','timing',{enabled:true}));
 const on = (await installationTiming(store, {taskId:'t'}, r => rows.push(r)));
 const end = (await on.start('work')); expect(rows).toHaveLength(1);
 (await store.setSettings('global','timing',{enabled:false})); (await end()); (await on.mark('late'));
 expect(rows).toHaveLength(1);
 (await store.setSettings('global','timing',{enabled:true})); (await on.mark('still stopped')); (await off.mark('still off'));
 expect(rows).toHaveLength(1);
 const next = (await installationTiming(store,{taskId:'t'},r => rows.push(r))); (await next.mark('next'));
 expect(rows).toHaveLength(2); (await store.close());
});
it('fails closed when settings cannot be read and never changes work outcomes', async () => {
 const trace = (await installationTiming({getSettings(){throw Error('unavailable');}}, {taskId:'t'}, () => {throw Error('sink');}));
 expect(await trace.measure('work',async()=>42)).toBe(42);
});

it('persists opt-in and propagates between independently opened stores', async () => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(),'timing-setting-'));
 const file = path.join(home,'state.db');
 const gateway = (await Store.create(file)); const worker = (await Store.create(file));
 try {
   expect((await timingEnabled(worker))).toBe(false);
   (await gateway.setSettings('global','timing',{enabled:true}));
   expect((await timingEnabled(worker))).toBe(true);
   const reopened = (await Store.create(file)); expect((await timingEnabled(reopened))).toBe(true); (await reopened.close());
   (await gateway.setSettings('global','timing',{enabled:false}));
   expect((await timingEnabled(worker))).toBe(false);
 } finally {(await gateway.close());(await worker.close());fs.rmSync(home,{recursive:true,force:true});}
});

it('filters hidden timing rows before applying bounded event windows', async () => {
 const store=(await Store.create(':memory:'));
 try {
   (await store.appendEvent({taskId:'t',type:'fixture',ts:0,payload:{}}));
   (await store.appendEvent({taskId:'t',type:'timing',ts:1,payload:{}}));
   expect((await store.eventsSince('t',0,1,true)).map(e=>e.type)).toEqual(['fixture']);
   expect((await store.allEventsSince(0,1,true)).map(e=>e.type)).toEqual(['fixture']);
   expect((await store.eventsOfType('t','timing'))).toHaveLength(1);
 } finally {(await store.close());}
});

it('does not retry or fail work when enabled recording or its clock fails', async () => {
 const trace=new TimingTrace({taskId:'t'},()=>{throw Error('sink failed');});
 expect(await trace.measure('work',async()=>42)).toBe(42);
 const clock=new TimingTrace({taskId:'t'},()=>{},()=>{throw Error('clock failed');});
 expect(await clock.measure('work',async()=>43)).toBe(43);
});

it('does not inherit an enabled outer context into disabled work', async () => {
 const outer = new TimingTrace({taskId:'outer'},()=>{});
 const off = (await installationTiming(undefined,{taskId:'off'},()=>{}));
 (await withTiming(outer,async ()=>(await withTiming(off,async ()=>expect((await currentTiming())).toBeUndefined()))));
});

it('invalidates active spans even when off/on happens between observations', async () => {
 const store=(await Store.create(':memory:'));const rows:any[]=[];
 (await store.setSettings('global','timing',{enabled:true}));
 const trace=(await installationTiming(store,{taskId:'t'},row=>rows.push(row)));const end=(await trace.start('work'));
 (await store.setSettings('global','timing',{enabled:false}));
 (await store.setSettings('global','timing',{enabled:true}));
 (await end());expect(rows).toHaveLength(1);expect((await trace.enabled())).toBe(false);(await store.close());
});
