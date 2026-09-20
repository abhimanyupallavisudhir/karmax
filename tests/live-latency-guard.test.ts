import {afterEach, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {liveBenchmark, liveLimits} from '../benchmarks/live-adapter.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-guard-'));
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(home,{recursive:true,force:true});});
it('caps output, allows only fixture tools, accounts usage and rejects oversized context before sending', async()=>{
 fs.mkdirSync(home,{recursive:true});
 vi.stubEnv('OPENAI_API_KEY','test-only');vi.stubEnv('ANTHROPIC_API_KEY','test-only');
 const fetch = vi.fn(async()=>new Response(JSON.stringify({id:'r1',model:'gpt-5.5',usage:{input_tokens:20,output_tokens:3},output:[]})));
 vi.stubGlobal('fetch',fetch);
 const run=liveBenchmark(path.join(home,'report'));
 try {
   await globalThis.fetch('https://api.openai.com/v1/responses',{body:JSON.stringify({model:'gpt-5.5',tools:[{name:'exec_command'},{name:'execute_connection_tool'}]})});
   const body=JSON.parse((fetch.mock.calls as any)[0][1].body);
   expect(body.max_output_tokens).toBe(liveLimits.maxOutputTokens);
   expect(body.tools.map((t:any)=>t.name)).toEqual(['execute_connection_tool']);
   expect(run.requests[0].estimatedDollars).toBeCloseTo(.00019);
   await expect(globalThis.fetch('https://api.openai.com/v1/responses',{body:JSON.stringify({model:'gpt-5.5',tools:[],input:'x'.repeat(32_001)})})).rejects.toThrow('limit');
   expect(fetch).toHaveBeenCalledTimes(1);
 } finally {run.close();}
});
it('rejects unexpected returned tools before production handlers can execute them', async()=>{
 fs.mkdirSync(home,{recursive:true});
 vi.stubEnv('OPENAI_API_KEY','test-only');vi.stubEnv('ANTHROPIC_API_KEY','test-only');
 const fetch=vi.fn(async()=>new Response(JSON.stringify({usage:{input_tokens:20,output_tokens:3},output:[{type:'function_call',name:'exec_command'}]})));
 vi.stubGlobal('fetch',fetch); const run=liveBenchmark(path.join(home,'report'));
 try {
   const request=()=>globalThis.fetch('https://api.openai.com/v1/responses',{body:JSON.stringify({model:'gpt-5.5',tools:[]})});
   await expect(request()).rejects.toThrow('halted');
   await expect(request()).rejects.toThrow('limit');
   expect(fetch).toHaveBeenCalledTimes(1);
 } finally {run.close();}
});
