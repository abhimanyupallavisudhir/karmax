import {expect,it} from 'vitest';
import {benchmarkOutcome} from '../benchmarks/latency-validation.js';
import type {TimingRow} from '../src/timing/index.js';
it('excludes a successful resumed turn that skipped requested reads',()=>{
 expect(benchmarkOutcome('one-action',[])).toEqual({expectedActions:1,observedActions:0,valid:false});
 expect(benchmarkOutcome('conversation',[]).valid).toBe(true);
 const action={name:'service.execution',phase:'end',status:'ok'} as TimingRow;
 expect(benchmarkOutcome('sequential-actions',[action,action,action]).valid).toBe(true);
 expect(benchmarkOutcome('parallel-actions',[action,{...action,status:'failed'},action]).valid).toBe(false);
});
