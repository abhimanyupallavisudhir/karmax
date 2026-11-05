// Creates the cloned projects (names, folders, repos) in the demo tavya.
const { chromium } = require('playwright');
const fs = require('node:fs');
const APP = 'http://127.0.0.1:48950';
const prod = JSON.parse(fs.readFileSync('/tmp/demo/prod/projects.json', 'utf8'));
const REPOS = { tavya: ['/tmp/demo/repos/karmax.git', '/tmp/demo/repos/panagent.git'], 'personal-website': ['/tmp/demo/repos/cv.git'] };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ storageState: '/tmp/demo/state.json' });
  const req = async (method, path, body) => {
    const r = await context.request.fetch(`${APP}${path}`, { method, data: body, headers: { origin: APP } });
    if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${await r.text()}`);
    return r.json();
  };
  const out = {};
  for (const p of prod) {
    const name = p.folder ? `${p.folder}/${p.name}` : p.name;
    const config = p.config.defaultBase ? { defaultBase: p.config.defaultBase, defaultTarget: p.config.defaultTarget } : {};
    const project = await req('POST', '/api/projects', { name, repos: REPOS[p.name] ?? [], config });
    out[p.name] = project.id;
    console.log(name, project.id);
  }
  fs.writeFileSync('/tmp/demo/projects.json', JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
