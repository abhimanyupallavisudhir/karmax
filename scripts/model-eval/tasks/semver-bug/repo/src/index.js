// tiny-semver: parse versions and check them against npm-style ranges.

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function parse(version) {
  const m = VERSION.exec(String(version).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

export function compare(a, b) {
  const x = typeof a === 'string' ? parse(a) : a;
  const y = typeof b === 'string' ? parse(b) : b;
  if (!x || !y) throw new TypeError(`Invalid version: ${!x ? a : b}`);
  return Math.sign(x.major - y.major) || Math.sign(x.minor - y.minor) || Math.sign(x.patch - y.patch);
}

const fmt = (v) => `${v.major}.${v.minor}.${v.patch}`;

// A partial version like "1", "1.2", "1.x" or "*": the missing parts are wildcards.
function partial(text) {
  const parts = text.replace(/^v/, '').split('.');
  const nums = [];
  for (const p of parts) {
    if (p === '' || p === 'x' || p === 'X' || p === '*') break;
    if (!/^\d+$/.test(p)) return null;
    nums.push(+p);
  }
  return nums;
}

// Turn one range token into a list of [operator, version] comparators.
function comparators(token) {
  if (token === '' || token === '*' || token === 'x' || token === 'X') return [];
  const op = /^(\^|~|>=|<=|>|<|=)?(.*)$/.exec(token);
  const kind = op[1] ?? '';
  const nums = partial(op[2]);
  if (nums === null || nums.length > 3) throw new TypeError(`Invalid range: ${token}`);
  const [major = 0, minor = 0, patch = 0] = nums;
  const low = { major, minor, patch };

  if (kind === '^') {
    if (nums.length === 0) return [];
    return [['>=', low], ['<', { major: major + 1, minor: 0, patch: 0 }]];
  }
  if (kind === '~') {
    if (nums.length === 0) return [];
    if (nums.length === 1) return [['>=', low], ['<', { major: major + 1, minor: 0, patch: 0 }]];
    return [['>=', low], ['<', { major, minor: minor + 1, patch: 0 }]];
  }
  if (kind === '' || kind === '=') {
    if (nums.length === 0) return [];
    if (nums.length === 3) return [['=', low]];
    if (nums.length === 1) return [['>=', low], ['<', { major: major + 1, minor: 0, patch: 0 }]];
    return [['>=', low], ['<', { major, minor: minor + 1, patch: 0 }]];
  }
  if (nums.length < 3 && (kind === '>' || kind === '<=')) {
    // ">1.2" means ">=1.3.0"; "<=1.2" means "<1.3.0"
    const next = nums.length === 1 ? { major: major + 1, minor: 0, patch: 0 } : { major, minor: minor + 1, patch: 0 };
    return [[kind === '>' ? '>=' : '<', next]];
  }
  return [[kind, low]];
}

function test(version, [op, bound]) {
  const c = compare(version, bound);
  switch (op) {
    case '=': return c === 0;
    case '>': return c > 0;
    case '>=': return c >= 0;
    case '<': return c < 0;
    case '<=': return c <= 0;
  }
  throw new TypeError(`Unknown operator ${op}`);
}

// A hyphen range "1.2.3 - 2.3" is ">=1.2.3 <=2.3".
function expandHyphen(set) {
  return set.replace(/^\s*(\S+)\s+-\s+(\S+)\s*$/, '>=$1 <=$2');
}

export function satisfies(version, range) {
  const v = parse(version);
  if (!v) return false;
  return String(range).split('||').some((set) => {
    const tokens = expandHyphen(set).trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/);
    return tokens.flatMap(comparators).every((c) => test(v, c));
  });
}

export function maxSatisfying(versions, range) {
  return versions.filter((v) => satisfies(v, range)).sort(compare).at(-1) ?? null;
}

export { fmt as format };
