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

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
