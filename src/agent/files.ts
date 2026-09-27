import path from 'node:path';
import type { FileRef, Message } from '../domain/types.js';
import { AttachmentStore, sanitizeAttachmentName } from '../store/attachments.js';
import type { World } from '../world/types.js';

/**
 * Provider-neutral file prompts.
 *
 * Ordinary uploads are not sent through a model vendor's attachment API. Before
 * every turn they are copied from Karmax's durable, content-addressed store into
 * a checkpoint-excluded directory in the task world. The delivered user message
 * names the absolute paths, so any agent can inspect them with its normal tools.
 * Re-materializing every turn repairs a recreated/remote world and makes provider
 * session forks independent of a vendor's file-retention semantics.
 */
export const WORLD_ATTACHMENT_DIR = '.karmax-injection/attachments';

export function worldAttachmentRelative(ref: FileRef): string {
  return path.posix.join(WORLD_ATTACHMENT_DIR, `${ref.id}-${sanitizeAttachmentName(ref.name)}`);
}

export function fileAttachmentText(files: FileRef[], worldRoot: string): string {
  if (!files.length) return '';
  const lines = files.map((ref) => {
    const absolute = path.posix.join(worldRoot, worldAttachmentRelative(ref));
    return `- ${ref.name}: ${absolute} (${ref.mediaType}, ${ref.bytes} bytes)`;
  });
  return `Attached files (durable copies in the task world; inspect with normal tools):\n${lines.join('\n')}`;
}

/** Materialize and annotate copies of messages without mutating workflow state. */
export async function materializeFileAttachments(world: World, messages: Message[]): Promise<Message[]> {
  const refs = uniqueFiles(messages.flatMap((message) => message.files ?? []));
  if (!refs.length) return messages;
  if (!world.writeFileBuffer) throw new Error('this world cannot receive file attachments');

  // A single-repository world is itself a Git checkout. Keep the injection
  // surface out of broad `git add -A` commands without changing tracked files.
  await world.exec('bash', ['-lc', "exclude=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p \"$(dirname \"$exclude\")\" && { grep -qxF '.karmax-injection/' \"$exclude\" 2>/dev/null || printf '%s\\n' '.karmax-injection/' >> \"$exclude\"; } || true"]);

  const store = new AttachmentStore();
  const checksums = new Map<string, string>();
  // Bound argv size while sharing one remote round trip across ordinary uploads.
  for (let offset = 0; offset < refs.length; offset += 100) {
    const files = refs.slice(offset, offset + 100).map(ref => path.posix.join(world.handle.root, worldAttachmentRelative(ref)));
    const result = await world.exec('sha256sum', ['--zero', '--', ...files]);
    for (const record of result.stdout.split('\0')) {
      if (/^[a-f0-9]{64}  /.test(record)) checksums.set(record.slice(66), record.slice(0, 64));
    }
  }
  for (const ref of refs) {
    const relative = worldAttachmentRelative(ref);
    const absolute = path.posix.join(world.handle.root, relative);
    if (checksums.get(absolute) === ref.id) continue;
    const stored = store.read(ref.id);
    if (!stored) throw new Error(`attached file is no longer available: ${ref.name}`);
    // A prior turn may have changed or chmod'd its materialized copy. The durable
    // content hash is authoritative; repair the copy before delivering the path.
    await world.exec('chmod', ['0644', absolute]);
    await world.writeFileBuffer(relative, stored.buf);
    await world.exec('chmod', ['0444', absolute]);
  }

  return messages.map((message) => {
    if (!message.files?.length) return message;
    const note = fileAttachmentText(message.files, world.handle.root);
    return { ...message, text: message.text ? `${message.text}\n\n${note}` : note };
  });
}

function uniqueFiles(files: FileRef[]): FileRef[] {
  const seen = new Set<string>();
  return files.filter((ref) => {
    const key = `${ref.id}\0${ref.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
