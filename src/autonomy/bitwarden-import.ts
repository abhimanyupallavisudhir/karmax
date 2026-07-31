import { VaultFieldName, VaultItemPolicy, VaultItems, VaultItemType } from './vault-items.js';
import { hostOf } from './pass-path.js';

export interface BitwardenImportItem {
  externalId: string;
  type: VaultItemType;
  label: string;
  username?: string;
  domains: string[];
  folder: string;
  secrets: Partial<Record<VaultFieldName, string>>;
}

export interface BitwardenImportResult {
  items: BitwardenImportItem[];
  skipped: Array<{ externalId?: string; label: string; reason: string }>;
}

export interface BitwardenVaultImportResult {
  count: number;
  created: number;
  updated: number;
  skipped: BitwardenImportResult['skipped'];
}

/**
 * Parse Bitwarden's plaintext JSON export without touching disk or invoking
 * `bw`. Password Manager exports use numeric cipher types: login=1,
 * secure-note=2, card=3, identity=4, SSH key=5.
 */
export function parseBitwardenExport(value: unknown): BitwardenImportResult {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('select a Bitwarden JSON export object');
  const data = value as any;
  if (data.encrypted === true || (!Array.isArray(data.items) && typeof data.data === 'string'))
    throw new Error('encrypted Bitwarden exports are not supported; export plaintext JSON for this one-time import');
  if (!Array.isArray(data.items)) throw new Error('the Bitwarden export has no items array');
  if (data.items.length > 100_000) throw new Error('the Bitwarden export contains too many items');

  const folders = new Map<string, string>((Array.isArray(data.folders) ? data.folders : [])
    .flatMap((folder: any) => typeof folder?.id === 'string'
      ? [[folder.id, typeof folder.name === 'string' ? folder.name : ''] as const]
      : []));
  const result: BitwardenImportResult = { items: [], skipped: [] };

  for (const raw of data.items) {
    const item = raw && typeof raw === 'object' ? raw as any : {};
    const externalId = typeof item.id === 'string' ? item.id.trim() : '';
    const label = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : 'Bitwarden item';
    const skip = (reason: string) => result.skipped.push({
      ...(externalId ? { externalId } : {}),
      label,
      reason,
    });
    if (!externalId) {
      skip('item has no stable Bitwarden id');
      continue;
    }

    let type: VaultItemType;
    const secrets: Partial<Record<VaultFieldName, string>> = {};
    let username: string | undefined;
    let domains: string[] = [];

    if (item.type === 1) {
      type = 'login';
      username = stringValue(item.login?.username);
      const password = stringValue(item.login?.password);
      const totp = stringValue(item.login?.totp);
      if (password) secrets.password = password;
      if (totp) secrets.totp = totp;
      domains = unique((Array.isArray(item.login?.uris) ? item.login.uris : [])
        .map((entry: any) => webHost(entry?.uri))
        .filter(Boolean));
    } else if (item.type === 2) {
      type = 'note';
      const note = stringValue(item.notes);
      if (note) secrets.note = note;
    } else if (item.type === 5) {
      type = 'ssh-key';
      const privateKey = stringValue(item.sshKey?.privateKey);
      if (privateKey) secrets.privateKey = privateKey;
    } else {
      skip(`unsupported Bitwarden item type ${String(item.type ?? 'unknown')}`);
      continue;
    }

    if (!Object.keys(secrets).length) {
      skip('item contains no supported secret');
      continue;
    }
    result.items.push({
      externalId,
      type,
      label,
      ...(username ? { username } : {}),
      domains,
      folder: folders.get(item.folderId) ?? '',
      secrets,
    });
  }
  return result;
}

/** Save a parsed export as an idempotent, one-way import into Krmax's vault. */
export function importBitwardenExport(
  vault: VaultItems,
  value: unknown,
  policy?: Partial<VaultItemPolicy>,
): BitwardenVaultImportResult {
  const parsed = parseBitwardenExport(value);
  let created = 0;
  let updated = 0;
  for (const item of parsed.items) {
    const existing = vault.findByExternal('import:bitwarden', item.externalId);
    vault.save({
      id: existing?.id,
      type: item.type,
      label: item.label,
      domains: item.domains,
      username: item.username ?? '',
      ...(!existing ? {
        tags: [item.folder ? `Bitwarden/${item.folder}` : 'Bitwarden'],
        policy,
      } : {}),
      secrets: item.secrets,
      provenance: { source: 'import:bitwarden', externalId: item.externalId },
    });
    if (existing) updated++;
    else created++;
  }
  return { count: created + updated, created, updated, skipped: parsed.skipped };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

/** Only web origins are safe autofill domains; androidapp:// etc. are not. */
function webHost(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? hostOf(url.href) : '';
  } catch {
    return '';
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
