import fs from 'node:fs';
import path from 'node:path';
import { vmProvisionScript, vmProvisionVersion } from '../../src/world/vm/provision.js';

/**
 * Writes the Docker build context of karmax's VM image (wiki features/vm-worlds)
 * to the directory given (default `environments/vm/out`) and prints the image
 * tag: the provisioning version, so a Fly world booted from it skips
 * provisioning (its stamp is already there). The image is stock Debian plus
 * `vmProvisionScript()`, the same script a stock machine runs at its first boot.
 */
const out = path.resolve(process.argv[2] ?? 'environments/vm/out');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'provision.sh'), vmProvisionScript(), { mode: 0o755 });
fs.writeFileSync(path.join(out, 'Dockerfile'), [
  'FROM debian:bookworm',
  'COPY provision.sh /tmp/provision.sh',
  'RUN bash /tmp/provision.sh && rm -f /tmp/provision.sh && apt-get clean && rm -rf /var/lib/apt/lists/*',
  '',
].join('\n'));
console.log(vmProvisionVersion());
