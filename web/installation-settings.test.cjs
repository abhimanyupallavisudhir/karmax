// Installation-wide controls live on one global, operator-only page. Tenant
// settings retain only organization/project-owned halves of shared services.
// Run: node web/installation-settings.test.cjs
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
let pass = 0, fail = 0;
function ok(condition, message) {
  if (condition) pass++;
  else { fail++; console.error('FAIL:', message); }
}
const slice = (from, to) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  if (start < 0 || end < 0) throw new Error(`missing slice ${from} → ${to}`);
  return src.slice(start, end);
};

const installation = slice('function installationView()', 'function organizationView()');
const organization = slice('function organizationView()', 'async function hydrateOrganizationView()');
const project = slice('function settingsView(proj)', 'function cloudEnvironmentCard(proj)');

for (const marker of [
  'installation-appearance', 'installation-health', 'installation-capacity', 'installation-github',
  'installation-paid-launch', 'installation-stripe', 'installation-email', 'installation-access',
]) ok(installation.includes(`id="${marker}"`), `Installation includes #${marker}`);

ok(!installation.includes('installation-recovery') && !src.includes('hydrateResilienceCard'), 'Installation omits the inert safe-mode control');

ok(src.includes("api('/api/settings/paid-launch')"), 'Paid launch loads persisted installation configuration');
ok(src.includes("method: 'PUT'"), 'Paid launch saves configuration through the installation API');
ok(src.includes('No paid-launch environment variables are required'), 'Paid launch explains that environment variables are unnecessary');
ok(src.includes('Real-world founder checklist'), 'Paid launch includes the founder checklist');
ok(src.includes('SaaS subscription billing, separate from Stripe Connect'), 'Paid launch distinguishes subscriptions from agent cards');
ok(src.includes('stripe.apiVersion'), 'Paid launch shows the supported Stripe API version');
ok(src.includes('stripe.webhookEvents'), 'Paid launch shows the exact Stripe webhook events');

for (const marker of ['appearance-card', 'resilience-card', 'outbound-email-card', 'phone-access-card'])
  ok(!organization.includes(`id="${marker}"`), `Organization omits #${marker}`);
ok(!organization.includes('pay-stripe-platform'), 'Organization omits shared Stripe platform setup');
ok(!project.includes('project-setup-github'), 'Project settings never bootstrap the shared GitHub App');
ok(src.includes("${S.installationAccess ? `<div class=\"label\">Installation</div><a class=\"nav-item"), 'rail renders Installation only after an authorized probe');
ok(src.includes("api('/api/settings/installation')"), 'boot probes an installation-scoped endpoint');
ok(src.includes("if (!S.installationAccess) return go(globalRoute('insights')"), 'a direct non-operator route is redirected');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
