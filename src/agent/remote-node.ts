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

/** sha512 (hex) of the npm registry tarballs a world without the baked pair
 * installs Node and npm from: the registry is on every world's allowlist, and a
 * pin trusts neither the image nor the registry's word. Add a version's three
 * digests when bumping {@link PINNED_REMOTE_NODE_VERSION} or its npm
 * (`curl -s https://registry.npmjs.org/<package>/<version>` → `dist.integrity`,
 * base64 → hex); a version without them installs through the image's npm. */
export const REMOTE_NODE_TARBALL_SHA512: Readonly<Record<string, string>> = {
  'node-linux-x64@22.16.0': '08f6bdcea1d1e4bdc86b7aaa8487210dc9b524f5fbf4906fc1813213cba701c5d5d0202e605453bb8d93a3f3c36a18e0779cfb7ad07287a1409320f81ef775d3',
  'node-linux-arm64@22.16.0': '2d5d939f21e53730c3c20eaa09904b3eaf53388d53009d8d0150d7486d56e39fb0a7dc31e698535ef3e89cd9e8cb1bc346bbe50761f13745c3b022dd5fac32b6',
  'npm@10.9.2': '8ab88f10f224a0c614cb717a7f7c30499014f77134120e9c1f0211ea3cf3397592cbe483feb38e0c4b3be1c54e347292c76a1b5edb94a3289d5448484ab8ac81',
};

export interface RemoteNodeSources {
  /** The pair baked into karmax's own templates. */
  bakedRoot?: string;
  /** Where the tarballs come from; default the image's `npm_config_registry`,
   * else registry.npmjs.org. A mirror is safe: the pins check every byte. */
  registry?: string;
  sha512?: Readonly<Record<string, string>>;
}

/** Make `<root>/node_modules/{node,npm}` the exact pair, in this order:
 * 1. link the template's baked pair when it is exactly that pair;
 * 2. else download both packages' tarballs from the npm registry with curl,
 *    wget or python3, check them against their pinned sha512 and unpack them.
 *    This needs no Node, npm or karmax template at all: an E2B desktop world
 *    (E2B's own `desktop` template) has none, and an organization's template
 *    or a Daytona snapshot need not either;
 * 3. else (a version without pins) `npm install` with the image's npm.
 * Never trust ambient node/npm otherwise: task commands may have replaced their
 * symlinks (task 201). */
export function installRemoteNodeCommand(root: string, nodeVersion: string, npmVersion: string,
  sources: RemoteNodeSources = {}): string {
  const bakedRoot = sources.bakedRoot ?? `/opt/karmax/node-${nodeVersion}`;
  const pins = sources.sha512 ?? REMOTE_NODE_TARBALL_SHA512;
  const node = `${root}/bin/node`;
  const bakedNode = `${bakedRoot}/bin/node`;
  const check = `process.exit(process.versions.node === ${JSON.stringify(nodeVersion)} && require(${JSON.stringify(`${bakedRoot}/node_modules/npm/package.json`)}).version === ${JSON.stringify(npmVersion)} ? 0 : 1)`;
  const linkBaked = `mkdir -p ${quote(`${root}/node_modules`)} && `
    + ['node', 'npm'].map(name => `ln -sfnT ${quote(`${bakedRoot}/node_modules/${name}`)} ${quote(`${root}/node_modules/${name}`)}`).join(' && ');
  const npmInstall = `${noAuditNpmrcCommand(root)} && npm install --prefix ${quote(root)} --no-audit --no-fund --omit=dev ${quote(`node@${nodeVersion}`)} ${quote(`npm@${npmVersion}`)}`;
  return `if ! test -x ${quote(node)}; then `
    + `if test ! -e ${quote(`${root}/node_modules/node`)} && test ! -e ${quote(`${root}/node_modules/npm`)} `
    + `&& test -x ${quote(bakedNode)} && ${quote(bakedNode)} -e ${quote(check)}; then ${linkBaked}; `
    + `else ${downloadRemoteNodeCommand(root, nodeVersion, npmVersion, sources.registry, pins) ?? npmInstall}; fi; fi`;
}

/** Download, verify and unpack the pair (step 2 above) into a staging
 * directory, then replace whatever partial pair `root` held. Undefined when a
 * package lacks a pin. The caller holds the runtime's install lock. */
function downloadRemoteNodeCommand(root: string, nodeVersion: string, npmVersion: string, registry: string | undefined,
  pins: Readonly<Record<string, string>>): string | undefined {
  const arches = [['x86_64|amd64', 'node-linux-x64'], ['aarch64|arm64', 'node-linux-arm64']] as const;
  const npmPin = pins[`npm@${npmVersion}`];
  if (!npmPin || arches.some(([, name]) => !pins[`${name}@${nodeVersion}`])) return undefined;
  const tarball = (name: string, version: string) => `"$registry"${quote(`/${name}/-/${name}-${version}.tgz`)}`;
  const stage = `${root}/.download`;
  const modules = `${root}/node_modules`;
  return [
    '{',
    registry ? `registry=${quote(registry)}` : 'registry=${npm_config_registry:-https://registry.npmjs.org}',
    'registry=${registry%/}',
    `case "$(uname -m)" in ${arches.map(([machine, name]) =>
      `${machine}) node_url=${tarball(name, nodeVersion)} node_sum=${pins[`${name}@${nodeVersion}`]};;`).join(' ')}`,
    `  *) echo "no Node ${nodeVersion} build for $(uname -m)" >&2; false;; esac &&`,
    '{ fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 30 -o "$2" "$1";',
    '  elif command -v wget >/dev/null 2>&1; then wget -q -T 60 -t 3 -O "$2" "$1";',
    `  elif command -v python3 >/dev/null 2>&1; then python3 -c ${quote('import shutil,sys,urllib.request; shutil.copyfileobj(urllib.request.urlopen(sys.argv[1], timeout=60), open(sys.argv[2], "wb"))')} "$1" "$2";`,
    '  else echo "cannot download Node: the image has neither curl, wget nor python3" >&2; return 1; fi; };',
    '  sha512() { { sha512sum "$1" || shasum -a 512 "$1" || openssl dgst -sha512 -r "$1"; } 2>/dev/null | cut -d" " -f1; };',
    `  unpack() { fetch "$1" ${quote(`${stage}/package.tgz`)} || { echo "could not download $1" >&2; return 1; };`,
    `    [ "$(sha512 ${quote(`${stage}/package.tgz`)})" = "$2" ] || { echo "$1 does not match its pinned sha512" >&2; return 1; };`,
    `    mkdir -p ${quote(stage)}/"$3" && tar -xzf ${quote(`${stage}/package.tgz`)} -C ${quote(stage)}/"$3" --strip-components=1 && rm -f ${quote(`${stage}/package.tgz`)}; }; } &&`,
    `rm -rf ${quote(stage)} && mkdir -p ${quote(stage)} ${quote(modules)} &&`,
    `unpack "$node_url" "$node_sum" node && unpack ${tarball('npm', npmVersion)} ${npmPin} npm &&`,
    `rm -rf ${quote(`${modules}/node`)} ${quote(`${modules}/npm`)} &&`,
    `mv ${quote(`${stage}/node`)} ${quote(`${modules}/node`)} && mv ${quote(`${stage}/npm`)} ${quote(`${modules}/npm`)};`,
    `status=$?; rm -rf ${quote(stage)}; [ $status = 0 ]`,
    '}',
  ].join('\n');
}

/** The node package's preinstall runs a nested `npm install`, handed
 * `--no-audit` as an empty npm_config_audit, which it reads as unset, so it
 * audits; with the registry's audit endpoint down that install hangs (CI
 * #2267). It does read <prefix>/etc/npmrc as its global config. */
export function noAuditNpmrcCommand(root: string): string {
  return `mkdir -p ${quote(`${root}/etc`)} && printf 'audit=false\nfund=false\n' > ${quote(`${root}/etc/npmrc`)}`;
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
export const PINNED_REMOTE_NODE_VERSION = '22.16.0';
export const PINNED_REMOTE_NPM_VERSION = '10.9.2';
