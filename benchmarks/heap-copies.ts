/**
 * Counts the copies of each benchmark message a heap snapshot holds
 * (benchmarks/workflow-memory.ts marks every message with ‹task:turn:kind›),
 * so retained conversation bytes can be attributed: one copy is the live
 * conversation; more are caches, publications or buffers holding it again.
 *
 *   node --max-old-space-size=1500 --import tsx benchmarks/heap-copies.ts x.heapsnapshot
 */
import fs from 'node:fs';

const snapshot = JSON.parse(fs.readFileSync(process.argv[2]!, 'utf8'));
const meta = snapshot.snapshot.meta;
const fields: string[] = meta.node_fields;
const types: string[] = meta.node_types[0];
const width = fields.length;
const [typeAt, nameAt, sizeAt] = ['type', 'name', 'self_size'].map((f) => fields.indexOf(f));
const nodes: number[] = snapshot.nodes;
const strings: string[] = snapshot.strings;
const copies = new Map<string, { count: number; bytes: number }>();
let markedBytes = 0, stringBytes = 0;
for (let i = 0; i < nodes.length; i += width) {
  const type = types[nodes[i + typeAt!]!];
  if (type !== 'string' && type !== 'concatenated string' && type !== 'sliced string') continue;
  const size = nodes[i + sizeAt!]!;
  stringBytes += size;
  const name = strings[nodes[i + nameAt!]!] ?? '';
  const match = /‹([^›]+)›/.exec(name);
  if (!match) continue;
  // Group by message kind: prompt, reply, follow-up or tool activity.
  const id = match[1]!;
  const kind = id.includes(':activity:') ? 'activity' : id.endsWith(':reply') ? 'reply'
    : id.includes(':followup:') ? 'followup' : id.startsWith('prompt-') ? 'prompt' : 'other';
  const multi = (name.match(/‹/g) ?? []).length > 1 ? `${kind}+json` : kind;
  const entry = copies.get(multi) ?? { count: 0, bytes: 0 };
  entry.count++; entry.bytes += size; markedBytes += size;
  copies.set(multi, entry);
}
console.log(JSON.stringify({ stringBytes, markedBytes, byKind: Object.fromEntries(copies) }, null, 1));
