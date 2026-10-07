import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { KarmaxApi } from '../src/platform/api.js';
import { WorkflowManager } from '../src/packages/manager.js';

const source = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const fn = (name: string) => source.match(new RegExp(`function ${name}\\([^]*?\\n}`))![0];

describe('existing hidden workflow forms', () => {
  for (const managed of [false, true]) {
    it(`renders the saved prompt with ${managed ? 'managed' : 'bundled'} schemas`, () => {
      const workflows = managed ? new WorkflowManager(undefined as any, undefined as any) : undefined;
      const api = new KarmaxApi({ workflows } as any);
      const schemas = api.workflowSchemas();
      expect(schemas.find((s) => s.name === 'just-do')?.params).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'prompt', bind: 'prompt', type: 'text' }),
      ]));
      expect(schemas.find((s) => s.name === 'script-exec')?.params).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'command', type: 'text' }),
      ]));
      const context = vm.createContext({ S: { schema: schemas } });
      vm.runInContext([
        source.slice(source.indexOf('const WORKFLOWS ='), source.indexOf('const NODES =')),
        "const esc = (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;');",
        source.slice(source.indexOf('const eff ='), source.indexOf('function renderField(')),
        fn('schemaFor'), fn('consumingField'), fn('renderField'),
      ].join('\n'), context);
      // The editor uses this exact schema → consuming field → renderer path.
      const html = vm.runInContext("renderField(consumingField(schemaFor('just-do')), 'Wake #219 after #232 succeeds.', undefined, true)", context);
      expect(html).toContain('data-field="prompt"');
      expect(html).toContain('>Wake #219 after #232 succeeds.</textarea>');
      const choices = (existing: boolean) => vm.runInContext(`taskFormWorkflows('just-do', ${existing}).map(w => w.id)`, context);
      expect(choices(true)).toContain('just-do');
      expect(choices(false)).not.toContain('just-do');
      expect(choices(false)).not.toContain('script-exec');
    });
  }
});
