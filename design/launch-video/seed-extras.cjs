// What the clone needs beyond the imported tasks: the organization's task defaults
// (as on tavya.io), and stand-in vault items and a card. The real vault is personal,
// so these are work-type entries with made-up values; nothing secret is copied.
// Usage: APP=http://127.0.0.1:48950 STATE=/home/user/demo/state.json node design/launch-video/seed-extras.cjs
const { chromium } = require('playwright');
const APP = process.env.APP || 'http://127.0.0.1:48950';
const STATE = process.env.STATE || '/home/user/demo/state.json';
const ORG = 'org_personal';
const AGENT = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high', mcpConnections: ['browser:chrome-devtools'] };
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ storageState: STATE });
  const req = async (method, path, body) => {
    const session = await (await context.request.get(`${APP}/api/session`)).json();
    const r = await context.request.fetch(`${APP}${path}`, { method, data: body,
      headers: { origin: APP, ...(session.token ? { authorization: `Bearer ${session.token}` } : {}) } });
    const text = await r.text();
    if (!r.ok()) console.error(`${method} ${path}: ${r.status()} ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  await req('PUT', `/api/organizations/${ORG}/settings/software-dev`, { values: {
    'agent:do': AGENT,
    responder: { kind: 'human', audience: ['@creator'], agentDefault: { ...AGENT, effort: 'low' } },
    confirm: { layers: [{ kind: 'human' }], agentDefault: { ...AGENT, effort: 'low' } },
    multiPr: true, landingAuthority: 'auto',
  } });
  const existing = await req('GET', `/api/vault/items?organizationId=${ORG}`);
  const have = new Set((Array.isArray(existing) ? existing : existing.items || []).map((i) => i.label));
  const items = [
    { type: 'login', label: 'GitHub', domains: ['github.com'], username: 'abhimanyupallavisudhir', secrets: { password: 'demo-not-a-real-password', totp: 'JBSWY3DPEHPK3PXP' } },
    { type: 'login', label: 'Google Search Console', domains: ['search.google.com'], username: 'abhimanyu@example.com', secrets: { password: 'demo-not-a-real-password' } },
    { type: 'login', label: 'Bing Webmaster Tools', domains: ['bing.com'], username: 'abhimanyu@example.com', secrets: { password: 'demo-not-a-real-password' } },
    { type: 'api-key', label: 'Modal', envVar: 'MODAL_TOKEN', secrets: { value: 'demo-modal-token' } },
    { type: 'api-key', label: 'Hetzner Cloud', envVar: 'HCLOUD_TOKEN', secrets: { value: 'demo-hcloud-token' } },
    { type: 'api-key', label: 'OpenRouter', envVar: 'OPENROUTER_API_KEY', secrets: { value: 'demo-openrouter-key' } },
    { type: 'env', label: 'S3 integration bucket', secrets: { value: 'AWS_ACCESS_KEY_ID=demo\nAWS_SECRET_ACCESS_KEY=demo' } },
    { type: 'note', label: 'Signup contact details', secrets: { value: 'Abhimanyu Pallavi Sudhir, Coventry, UK' } },
  ];
  for (const item of items) if (!have.has(item.label)) await req('POST', `/api/vault/items?organizationId=${ORG}`, item);
  const cards = await req('GET', `/api/cards?organizationId=${ORG}`);
  if (!(Array.isArray(cards) ? cards : cards.cards || []).some((c) => c.label === 'abhimanyu'))
    console.log(JSON.stringify(await req('POST', `/api/cards?organizationId=${ORG}`, { label: 'abhimanyu', provider: 'vault-card', cap: 20000, currency: 'usd',
      details: { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2029 } })).slice(0, 300));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
