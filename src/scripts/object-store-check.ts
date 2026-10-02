import fs from 'node:fs';
import { hydrateEnvFile, hydrateSecretFiles } from '../config/deployment.js';
import { checkObjectStore } from '../ops/object-store-check.js';

// npm run object-store-check — deploy/karmax doctor runs it in the app container.
hydrateEnvFile(process.env, (filename) => fs.readFileSync(filename, 'utf8'));
try {
  hydrateSecretFiles(process.env, (filename) => fs.readFileSync(filename, 'utf8'),
    ['KARMAX_S3_ACCESS_KEY_ID', 'KARMAX_S3_SECRET_ACCESS_KEY', 'KARMAX_S3_SESSION_TOKEN']);
} catch (error) {
  console.log(`cannot read the object store's keys: ${(error as Error).message}`);
  process.exit(1);
}
const result = await checkObjectStore();
console.log(result.lines.join('\n'));
process.exit(result.ok ? 0 : 1);
