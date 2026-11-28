// The shared message-form policy (src/domain/message-forms.ts): what a form
// is, where it may save, and what an agent is told when it may not.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  FORM_SAVE_TARGETS, assertMessageForms, checkForm, compileFormRoute, fillFormTemplate, formFences, formSaveTarget,
  formValues, messageFormPolicy, messageFormProblems, parseForm, refusedFormsNotice, withRefusedForms,
} from '../src/domain/message-forms.js';

const fence = (spec: unknown) => `\`\`\`form\n${typeof spec === 'string' ? spec : JSON.stringify(spec, null, 2)}\n\`\`\``;
const secretForm = (save: unknown) => JSON.stringify({ fields: [{ name: 'key', label: 'API key', type: 'secret' }], save });

describe('message forms: the shared validator', () => {
  it('accepts every documented settings save, and says where it goes', () => {
    const ok = [
      secretForm({ method: 'POST', path: '/api/projects/p/secrets', body: { name: 'OPENAI_API_KEY', value: '{{key}}' } }),
      secretForm({ method: 'PUT', path: '/api/settings/included-model', body: { managementKey: '{{key}}' } }),
      secretForm({ method: 'PUT', path: '/api/settings/oauth-apps/accounts.google.com', body: { clientId: 'x', clientSecret: '{{key}}' } }),
      secretForm({ method: 'PUT', path: '/api/organizations/o/world-providers/e2b', body: { apiKey: '{{key}}' } }),
      JSON.stringify({ fields: [{ name: 'region' }], save: { method: 'PUT', path: '/api/settings/installation', body: { region: '{{region}}' } } }),
      JSON.stringify({ fields: [{ name: 'name' }], save: { method: 'patch', path: '/api/projects/p', body: { name: '{{name}}' } } }),
    ];
    for (const source of ok) expect(checkForm(source), source).toMatchObject({ ok: true });
    const verdict = checkForm(ok[0]!);
    expect(verdict.ok && verdict.target).toEqual({ target: FORM_SAVE_TARGETS[0], params: { project: 'p' } });
    // Specific rows win over the catch-all: the included model's key is a secret store, installation settings are not.
    expect(formSaveTarget({ method: 'PUT', path: '/api/settings/included-model' })?.target.secret).toBe(true);
    expect(formSaveTarget({ method: 'PUT', path: '/api/settings/installation' })?.target.secret).toBeUndefined();
  });

  it('refuses a save outside settings, naming the path and the allowed routes', () => {
    const verdict = checkForm(JSON.stringify({ fields: [{ name: 'who' }], save: { method: 'POST', path: '/api/organizations/o/members', body: { userId: '{{who}}' } } }));
    expect(verdict).toMatchObject({ ok: false, outside: true, problem: "save POST /api/organizations/o/members isn't an allowed settings route" });
    const [problem] = messageFormProblems(`Add them?\n\n${fence(JSON.stringify({ fields: [{ name: 'who' }], save: { method: 'POST', path: '/api/organizations/o/members' } }))}`);
    expect(problem).toMatch(/^the form: save POST \/api\/organizations\/o\/members isn't an allowed settings route; allowed: POST \/api\/projects\/:project\/secrets, /);
    // A route's method is part of it; a query string or an extra segment is another route.
    for (const [method, p] of <Array<[string, string]>>[['PUT', '/api/projects/p/secrets'], ['PATCH', '/api/projects/p?x=1'], ['POST', '/api/projects/p/secrets/extra'],
      ['PUT', '/api/settings/project/p/software-dev?scope=global']])
      expect(formSaveTarget({ method, path: p }), `${method} ${p}`).toBeUndefined();
  });

  it('refuses a secret saved where it can be read back', () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ method: 'PATCH', path: '/api/projects/p', body: { name: '{{key}}' } }, /not a secret store, so it could be read back/],
      [{ method: 'PUT', path: '/api/settings/installation', body: { siteName: '{{key}}' } }, /not a secret store/],
      [{ method: 'POST', path: '/api/projects/p/secrets', body: { name: '{{key}}', value: 'x' } }, /saved under "name", which can be read back; use a write-only key \(value, /],
      [{ method: 'POST', path: '/api/projects/p/secrets', body: { name: 'K', value: 'Bearer {{key}}' } }, /whole value/],
      [{ method: 'POST', path: '/api/vault/items', body: { label: 'x', fields: [{ note: '{{key}}' }] } }, /saved under "note"/],
    ];
    for (const [save, reason] of cases) {
      const verdict = checkForm(secretForm(save));
      expect(verdict.ok, JSON.stringify(save)).toBe(false);
      expect(!verdict.ok && verdict.problem).toMatch(reason);
    }
    // A secret field needs a save at all.
    expect(checkForm('{"fields":[{"name":"key","type":"password"}]}')).toMatchObject({ ok: false, problem: expect.stringMatching(/no "save"/) });
  });

  it('says what is wrong with an unreadable form', () => {
    expect(checkForm('{nope')).toMatchObject({ ok: false, problem: expect.stringMatching(/^its JSON could not be read \(/) });
    expect(checkForm('{"fields": []}')).toMatchObject({ ok: false, problem: expect.stringMatching(/no fields/) });
    expect(checkForm('{"fields":[{"name":"a"}],"save":{"method":"DELETE","path":"/api/projects/p"}}')).toMatchObject({ ok: false, problem: expect.stringMatching(/POST, PUT or PATCH/) });
  });

  it('finds forms as the console does, and refuses a message for any bad one', () => {
    const text = `One:\n\n${fence({ options: ['A', 'B'] })}\n\nTwo:\n\n\`\`\`FORM extra\n{"fields":[{"name":"x"}],"save":{"path":"/api/user/delete"}}\n\`\`\`\n\n\`\`\`json\n{"fields":[]}\n\`\`\``;
    expect(formFences(text).map((f) => f.source.slice(0, 12))).toEqual(['{\n  "options', '{"fields":[{']);
    expect(messageFormProblems(text)).toEqual([expect.stringMatching(/^form 2: save POST \/api\/user\/delete isn't an allowed settings route; allowed: /)]);
    expect(() => assertMessageForms(text)).toThrow(/form 2: save POST \/api\/user\/delete isn't .* Nothing was sent: fix the form and try again\./);
    try { assertMessageForms(text); } catch (error) { expect((error as { status?: number }).status).toBe(400); }
    expect(() => assertMessageForms(`No form here, just \`code\`.\n\n${fence({ options: ['Yes', 'No'] })}`)).not.toThrow();
  });

  it('marks a refused form in a message it cannot refuse, once, keeping its source', () => {
    const bad = JSON.stringify({ fields: [{ name: 'key', type: 'secret' }], save: { method: 'PATCH', path: '/api/projects/p', body: { name: '{{key}}' } } });
    const good = fence({ options: ['Yes', 'No'] });
    const said = `Paste it:\r\n\r\n${fence(bad)}\r\n\r\nOr:\r\n\r\n${good}`;
    const { text, problems } = withRefusedForms(said);
    expect(problems).toEqual([expect.stringMatching(/^form 1: it saves a secret field to PATCH \/api\/projects\/p, which is not a secret store/)]);
    expect(text).toBe(`Paste it:\n\n\`\`\`form-refused\nForm not shown: it saves a secret field to PATCH /api/projects/p, which is not a secret store, so it could be read back.\n${bad}\n\`\`\`\n\nOr:\n\n${good}`);
    expect(formFences(text)).toHaveLength(1);
    expect(withRefusedForms(text)).toEqual({ text, problems: [] });
    expect(withRefusedForms('Nothing to see.')).toEqual({ text: 'Nothing to see.', problems: [] });
    expect(refusedFormsNotice(problems)).toMatch(/^Your last message's form was not shown to anyone \(form 1: .*\)\. Ask again with a corrected form\.$/);
  });

  it('fills a save with the submitted values of the form\'s own fields only', () => {
    const { form } = parseForm(JSON.stringify({ fields: [{ name: 'key', type: 'secret' }, { name: 'n', type: 'number' }, { name: 'tags', multiple: true, options: ['a', 'b'] }],
      save: { method: 'POST', path: '/api/vault/items', body: { label: 'K {{n}}', value: '{{key}}', count: '{{n}}', tags: '{{tags}}', other: '{{nope}}' } } }));
    const values = formValues(form!, { key: 'sk-1', n: 3, tags: ['a'], nope: 'injected', extra: { deep: 1 } });
    expect(values).toEqual({ key: 'sk-1', n: 3, tags: ['a'] });
    expect(fillFormTemplate(form!.save!.body, values)).toEqual({ label: 'K 3', value: 'sk-1', count: 3, tags: ['a'], other: '' });
  });

  it('serves the console a policy it can compile', () => {
    const policy = JSON.parse(JSON.stringify(messageFormPolicy()));
    expect(policy.targets).toEqual(FORM_SAVE_TARGETS);
    expect(policy.secretKeys).toContain('clientSecret');
    expect(compileFormRoute('PUT /api/settings/*').pattern.test('/api/settings/a/b-c')).toBe(true);
    expect(compileFormRoute('PATCH /api/organizations/:organization').pattern.exec('/api/organizations/o')?.groups).toEqual({ organization: 'o' });
  });

  it('reads every form exactly as the console draws it (web/markdown.js parseForm)', () => {
    const file = path.join(__dirname, '..', 'web', 'markdown.js');
    const context = vm.createContext({});
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    const webParse = (context as { KarmaxMarkdown: { parseForm: (s: string) => unknown } }).KarmaxMarkdown.parseForm;
    const corpus = [
      '{"label": "Which database?", "options": ["Postgres", {"value": "sqlite", "label": "SQLite", "hint": "One file"}]}',
      JSON.stringify({ title: 'Deploy', fields: [{ name: 'region', options: ['eu', 'us'], default: 'eu' }, { name: 'customDomain', optional: true },
        { name: 'budget', type: 'number', min: 0, max: '9' }, { name: 'f', type: 'choice', multiple: true, options: ['A'] }, { name: 'notes', type: 'textarea' },
        { name: 'go', type: 'boolean', label: 'Go now' }, { name: 'go' }, 'not a field', { name: 'n m<x>', type: 'checkbox' }, { type: 'choice' }, { name: 'q', required: false }] }),
      secretForm({ method: 'post', path: '/api/projects/p/secrets', body: { name: 'K', value: '{{key}}' } }),
      JSON.stringify({ fields: [{ name: 'pw', type: 'password', default: 'x' }], save: { path: '/api/vault/items' }, submit: 'Keep it' }),
      '[{"name": "a"}]', '{nope', '7', 'null', '{"fields": []}', '{"options": []}',
      '{"fields":[{"name":"k","type":"secret"}]}',
      ...['DELETE', 'GET'].map((method) => JSON.stringify({ fields: [{ name: 'a' }], save: { method, path: '/api/x' } })),
      ...['https://evil.example/api/x', '/api/../x', '/login', '/api/a b'].map((p) => JSON.stringify({ fields: [{ name: 'a' }], save: { path: p } })),
      JSON.stringify({ title: 'x'.repeat(300), fields: Array.from({ length: 25 }, (_, i) => ({ name: `f${i}`, options: Array.from({ length: 60 }, (_, j) => `o${j}`) })) }),
    ];
    for (const source of corpus) expect(JSON.parse(JSON.stringify(parseForm(source))), source.slice(0, 80)).toEqual(JSON.parse(JSON.stringify(webParse(source))));
  });
});
