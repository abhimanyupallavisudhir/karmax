/** Remote sandboxes only: login shells discard the agent's injected PATH.
 * Keep Node, npm and npx together at a location on the image's default PATH.
 * The destination parameter also lets tests exercise this without changing the
 * machine running the test suite. */
export function exposeRemoteNodeCommand(runtimeBin: string, destination = '/usr/local/bin'): string {
  const commands = ['node', 'npm', 'npx'].map((name) =>
    `ln -sfnT ${quote(`${runtimeBin}/${name}`)} ${quote(`${destination}/${name}`)}`);
  const install = `mkdir -p ${quote(destination)} && ${commands.join(' && ')}`;
  return [
    ...['node', 'npm', 'npx'].map((name) => `test -x ${quote(`${runtimeBin}/${name}`)}`),
    `if [ -w ${quote(destination)} ]; then ${install}; else sudo -n sh -c ${quote(install)}; fi`,
  ].join(' && ');
}

/** Link an exact, paired template runtime into the task-owned injection tree.
 * A missing or stale template retains the normal npm installation path. Never
 * trust ambient node/npm: task commands may have replaced their symlinks. */
export function installRemoteNodeCommand(root: string, nodeVersion: string, npmVersion: string,
  bakedRoot = `/opt/karmax/node-${nodeVersion}`): string {
  const node = `${root}/bin/node`;
  const bakedNode = `${bakedRoot}/bin/node`;
  const check = `process.exit(process.versions.node === ${JSON.stringify(nodeVersion)} && require(${JSON.stringify(`${bakedRoot}/node_modules/npm/package.json`)}).version === ${JSON.stringify(npmVersion)} ? 0 : 1)`;
  return `if ! test -x ${quote(node)}; then `
    + `if test ! -e ${quote(`${root}/node_modules/node`)} && test ! -e ${quote(`${root}/node_modules/npm`)} `
    + `&& test -x ${quote(bakedNode)} && ${quote(bakedNode)} -e ${quote(check)}; then `
    + `mkdir -p ${quote(`${root}/node_modules`)} && `
    + ['node', 'npm'].map(name => `ln -sfnT ${quote(`${bakedRoot}/node_modules/${name}`)} ${quote(`${root}/node_modules/${name}`)}`).join(' && ') + `; else `
    + `npm install --prefix ${quote(root)} --no-audit --no-fund --omit=dev ${quote(`node@${nodeVersion}`)} ${quote(`npm@${npmVersion}`)}; fi; fi`;
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
export const PINNED_REMOTE_NODE_VERSION = '22.16.0';
export const PINNED_REMOTE_NPM_VERSION = '10.9.2';
