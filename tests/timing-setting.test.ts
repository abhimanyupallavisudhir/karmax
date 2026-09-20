import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { TimingTrace, timingEnabled, installationTiming, withTiming, currentTiming } from '../src/timing/index.js';
it('defaults off, explicitly opts in, stops active traces and preserves history', async () => {
 const store = new Store(':memory:'); const rows: any[] = [];
 expect(timingEnabled(store)).toBe(false);
 const off = installationTiming(store, {taskId:'t'}, r => rows.push(r));
 await withTiming(off, () => off.measure('work', async () => { expect(currentTiming()).toBeUndefined(); return 42; }));
 expect(rows).toHaveLength(0);
 store.setSettings('global','timing',{enabled:true});
 const on = installationTiming(store, {taskId:'t'}, r => rows.push(r));
 const end = on.start('work'); expect(rows).toHaveLength(1);
 store.setSettings('global','timing',{enabled:false}); end(); on.mark('late');
 expect(rows).toHaveLength(1);
 store.setSettings('global','timing',{enabled:true}); on.mark('still stopped'); off.mark('still off');
 expect(rows).toHaveLength(1);
 const next = installationTiming(store,{taskId:'t'},r => rows.push(r)); next.mark('next');
 expect(rows).toHaveLength(2); store.close();
});
it('fails closed when settings cannot be read and never changes work outcomes', async () => {
 const trace = installationTiming({getSettings(){throw Error('unavailable');}}, {taskId:'t'}, () => {throw Error('sink');});
 expect(await trace.measure('work',async()=>42)).toBe(42);
});

it('persists opt-in and propagates between independently opened stores', () => {
 const home = fs.mkdtempSync(path.join(os.tmpdir(),'timing-setting-'));
 const file = path.join(home,'state.db');
 const gateway = new Store(file); const worker = new Store(file);
 try {
   expect(timingEnabled(worker)).toBe(false);
   gateway.setSettings('global','timing',{enabled:true});
   expect(timingEnabled(worker)).toBe(true);
   const reopened = new Store(file); expect(timingEnabled(reopened)).toBe(true); reopened.close();
   gateway.setSettings('global','timing',{enabled:false});
   expect(timingEnabled(worker)).toBe(false);
 } finally {gateway.close();worker.close();fs.rmSync(home,{recursive:true,force:true});}
});

it('filters hidden timing rows before applying bounded event windows', () => {
 const store=new Store(':memory:');
 try {
   store.appendEvent({taskId:'t',type:'fixture',ts:0,payload:{}});
   store.appendEvent({taskId:'t',type:'timing',ts:1,payload:{}});
   expect(store.eventsSince('t',0,1,true).map(e=>e.type)).toEqual(['fixture']);
   expect(store.allEventsSince(0,1,true).map(e=>e.type)).toEqual(['fixture']);
   expect(store.eventsOfType('t','timing')).toHaveLength(1);
 } finally {store.close();}
});

it('does not retry or fail work when enabled recording or its clock fails', async () => {
 const trace=new TimingTrace({taskId:'t'},()=>{throw Error('sink failed');});
 expect(await trace.measure('work',async()=>42)).toBe(42);
 const clock=new TimingTrace({taskId:'t'},()=>{},()=>{throw Error('clock failed');});
 expect(await clock.measure('work',async()=>43)).toBe(43);
});

it('does not inherit an enabled outer context into disabled work', () => {
 const outer = new TimingTrace({taskId:'outer'},()=>{});
 const off = installationTiming(undefined,{taskId:'off'},()=>{});
 withTiming(outer,()=>withTiming(off,()=>expect(currentTiming()).toBeUndefined()));
});

it('invalidates active spans even when off/on happens between observations', () => {
 const store=new Store(':memory:');const rows:any[]=[];
 store.setSettings('global','timing',{enabled:true});
 const trace=installationTiming(store,{taskId:'t'},row=>rows.push(row));const end=trace.start('work');
 store.setSettings('global','timing',{enabled:false});
 store.setSettings('global','timing',{enabled:true});
 end();expect(rows).toHaveLength(1);expect(trace.enabled()).toBe(false);store.close();
});
