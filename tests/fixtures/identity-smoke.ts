import { IdentityService } from '../../src/auth/identity.js';
import { AuthorizationService } from '../../src/platform/authorization.js';
import { Gateway } from '../../src/gateway/server.js';
import { Store } from '../../src/store/db.js';
import { TokenAuthority } from '../../src/platform/tokens.js';
import { KarmaxBus } from '../../src/contrib/bus.js';
import { ContributionRegistry } from '../../src/contrib/registry.js';
import { Overlays } from '../../src/store/overlays.js';
import { findFreePortFrom } from '../../src/util/ports.js';
import { WorldRegistry } from '../../src/world/registry.js';

const identity = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4505' });
const verificationRecipients: string[] = [];
identity.mailer = {
  configured: () => true,
  send: async (message) => { verificationRecipients.push(message.to); },
};
const first = await identity.bootstrap({ name: 'Admin', email: 'admin@example.come', password: 'long-enough-password' });
const cookie = first.response.headers.get('set-cookie') ?? '';
if (!/HttpOnly/i.test(cookie)) throw new Error('session cookie is not HttpOnly');
const changed = await identity.changeEmail('admin@example.com', 'http://localhost:4505/?verified=1', new Headers({ cookie }));
const changedCookie = changed.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? cookie;
const session = await identity.session(new Headers({ cookie: changedCookie }));
await identity.createUser({ name: 'Dev', email: 'dev@example.com', password: 'another-long-password' });
let bootstrapBlocked = false;
try { await identity.bootstrap({ name: 'Again', email: 'again@example.com', password: 'another-long-password' }); }
catch { bootstrapBlocked = true; }

// Exercise the actual HTTP boundary natively too: setup cookie forwarding,
// multiple-account login, project-scoped grants/filtering, denial, and logout.
const port = await findFreePortFrom(47950);
const httpIdentity = await IdentityService.open(':memory:', { baseURL: `http://127.0.0.1:${port}` });
const store = new Store(':memory:');
const authorization = new AuthorizationService(store);
const project = store.createProject('Allowed', {});
store.createProject('Hidden', {});
const gateway = new Gateway({
  api: {} as any,
  store,
  bus: new KarmaxBus(),
  tokens: new TokenAuthority(),
  contributions: new ContributionRegistry(),
  overlays: new Overlays(),
  client: {} as any,
  taskQueue: 'test',
  staticDir: process.cwd(),
  agentInfo: { provider: 'mock', reason: 'identity smoke' },
  identity: httpIdentity,
  authorization,
  worlds: new WorldRegistry(),
});
const running = await gateway.listen(port);
const base = running.url;
const json = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
});
const setupBefore = await (await json('/api/session')).json() as any;
const setupResponse = await json('/api/setup', { method: 'POST', body: JSON.stringify({ name: 'Root', email: 'root@example.com', password: 'root-password-long' }) });
const rootCookie = setupResponse.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
if (!rootCookie) throw new Error('gateway did not forward the Better Auth session cookie');
const rootHeaders = { cookie: rootCookie };
const signupResponse = await json('/api/signup', {
  method: 'POST',
  body: JSON.stringify({ name: 'Waiting user', email: 'waiting@example.com', password: 'waiting-password-long' }),
});
const signupCookie = signupResponse.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
if (!signupResponse.ok || !signupCookie) throw new Error(`self signup failed: ${await signupResponse.text()}`);
// Self-signup now lands the user in their own personal-workspace organization —
// no "no access yet" waiting room. Projects is reachable (empty until they make
// one) and the user owns exactly one personal org.
const signupProjects = await json('/api/projects', { headers: { cookie: signupCookie } });
const signupProjectsList = signupProjects.ok ? (await signupProjects.json()) as any[] : null;
const signupEntersApp = signupProjects.status === 200 && Array.isArray(signupProjectsList) && signupProjectsList.length === 0;
const signupOrgs = await (await json('/api/organizations', { headers: { cookie: signupCookie } })).json() as any[];
const signupHasPersonalWorkspace = signupOrgs.length === 1 && signupOrgs[0].kind === 'personal';
// The org dashboard must be viewable by its own (non-operator) owner: it needs
// only organization:read, and host/diagnostic data is gated separately. This is
// the "missing capability diagnostic:read" landing bug.
const signupDashboard = signupOrgs[0]
  ? await json(`/api/dashboard?organizationId=${encodeURIComponent(signupOrgs[0].id)}`, { headers: { cookie: signupCookie } })
  : { status: 0 };
const signupDashboardOk = signupDashboard.status === 200;
const upload = await fetch(`${base}/api/attachments?projectId=${encodeURIComponent(project.id)}`, {
  method: 'POST', headers: { ...rootHeaders, 'content-type': 'image/png' },
  body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
});
const image = await upload.json() as any;
if (!upload.ok || !image.id) throw new Error('could not upload scoped attachment');
const imageAllowed = await fetch(`${base}/api/attachments/${image.id}?projectId=${encodeURIComponent(project.id)}`, { headers: rootHeaders });
const hiddenProject = store.listProjects().find((p) => p.name === 'Hidden')!;
const imageHidden = await fetch(`${base}/api/attachments/${image.id}?projectId=${encodeURIComponent(hiddenProject.id)}`, { headers: rootHeaders });
if (imageAllowed.status !== 200 || imageHidden.status !== 404) throw new Error('attachment project ACL failed');
const created = await json('/api/users', {
  method: 'POST', headers: rootHeaders,
  body: JSON.stringify({ name: 'Project dev', email: 'project@example.com', password: 'project-password-long', profileId: 'developer', projectId: project.id }),
});
if (!created.ok) throw new Error(`could not create second account: ${await created.text()}`);
const loginResponse = await json('/api/login', { method: 'POST', body: JSON.stringify({ email: 'project@example.com', password: 'project-password-long' }) });
const projectCookie = loginResponse.headers.get('set-cookie')?.match(/better-auth\.session_token=[^;]+/)?.[0] ?? '';
const devHeaders = { cookie: projectCookie };
const visibleProjects = await (await json('/api/projects', { headers: devHeaders })).json() as any[];
const usersDenied = (await json('/api/users', { headers: devHeaders })).status;
const rootUsers = await (await json('/api/users', { headers: rootHeaders })).json() as any[];
await json('/api/logout', { method: 'POST', headers: devHeaders, body: '{}' });
const loggedOut = await (await json('/api/session', { headers: devHeaders })).json() as any;
await running.close();

process.stdout.write(JSON.stringify({
  firstRole: first.user.role,
  sessionEmail: session?.user.email,
  emailChangeOk: changed.ok,
  verificationSentToCorrectedEmail: verificationRecipients.includes('admin@example.com'),
  users: identity.listUsers().length,
  bootstrapBlocked,
  setupRequired: setupBefore.setupRequired,
  visibleProjects: visibleProjects.map((p) => p.name),
  usersDenied,
  signupEntersApp,
  signupHasPersonalWorkspace,
  signupDashboardOk,
  signupAccountVisible: rootUsers.some((u) => u.email === 'waiting@example.com'),
  loggedOut: !loggedOut.authenticated,
}));
