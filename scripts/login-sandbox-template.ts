/**
 * Build the E2B template login sandboxes start from (wiki
 * features/computerless-tasks § Start latency): the base template plus the
 * pinned Claude Code and Codex already in the sandbox user's npx cache. tavya
 * builds it by itself on an account's first login sandbox (that sandbox starts
 * from the base meanwhile); run this to have it ready before then, e.g. after
 * upgrading the Agent SDK or Codex.
 *
 *   E2B_API_KEY=… npx tsx scripts/login-sandbox-template.ts [base template]
 */
import { buildWarmTemplate, e2bTemplate, e2bTemplateExists, warmTemplateName } from '../src/world/e2b-template.js';
import { loginCliPackages } from '../src/agent/remote-process.js';

const base = process.argv[2] ?? e2bTemplate();
const packages = loginCliPackages();
const name = warmTemplateName(base, packages);
const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error('E2B_API_KEY is required');
console.log(`${name} from ${base} with ${packages.join(', ')}`);
if (await e2bTemplateExists(name, { apiKey })) console.log('already built');
else {
  const started = Date.now();
  await buildWarmTemplate(base, name, packages, { apiKey });
  console.log(`built in ${Math.round((Date.now() - started) / 1000)} s`);
}
