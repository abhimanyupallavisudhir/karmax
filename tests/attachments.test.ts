import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AttachmentStore, AttachmentError, sanitizeAttachmentName, sniffImageType } from '../src/store/attachments.js';
import {
  anthropicUserContent,
  openaiUserContent,
  collectAnthropicImageBlocks,
  materializeImageFiles,
  hasImages,
} from '../src/agent/images.js';
import { Message } from '../src/domain/types.js';
import { fileAttachmentText, materializeFileAttachments, worldAttachmentRelative } from '../src/agent/files.js';
import { MemoryWorldProvider } from '../src/world/memory.js';

// A real 1x1 PNG (valid magic bytes + minimal chunks).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('rest-of-jpeg')]);

describe('AttachmentStore', () => {
  let home: string;
  let store: AttachmentStore;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-att-'));
    store = new AttachmentStore({ home });
  });

  it('stores a valid PNG and round-trips it content-addressed', () => {
    const ref = store.put(PNG, 'image/png');
    expect(ref.mediaType).toBe('image/png');
    expect(ref.bytes).toBe(PNG.length);
    expect(ref.id).toMatch(/^[a-f0-9]{64}$/);
    const got = store.read(ref.id);
    expect(got?.buf.equals(PNG)).toBe(true);
    const b64 = store.readBase64(ref.id);
    expect(b64?.base64).toBe(PNG.toString('base64'));
  });

  it('is content-addressed: identical bytes → same id, single file', () => {
    const a = store.put(PNG);
    const b = store.put(PNG);
    expect(a.id).toBe(b.id);
    const files = fs.readdirSync(path.join(home, 'attachments'));
    expect(files.length).toBe(1);
  });

  it('deletes content idempotently', () => {
    const ref = store.put(PNG);
    expect(store.delete(ref.id)).toBe(true);
    expect(store.read(ref.id)).toBeUndefined();
    expect(store.delete(ref.id)).toBe(false);
  });

  it('accepts a base64 data URL', () => {
    const ref = store.putDataUrl(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(ref.mediaType).toBe('image/png');
    expect(store.read(ref.id)?.buf.equals(PNG)).toBe(true);
  });

  it('sniffs the real type over a lying declared type', () => {
    // declares jpeg but bytes are png → trusts png (both allowed)
    const ref = store.put(PNG, 'image/jpeg');
    expect(ref.mediaType).toBe('image/png');
  });

  it('rejects non-image bytes', () => {
    expect(() => store.put(Buffer.from('not an image at all'))).toThrow(AttachmentError);
  });

  it('rejects empty and oversized uploads', () => {
    expect(() => store.put(Buffer.alloc(0))).toThrow(AttachmentError);
    const small = new AttachmentStore({ home, maxBytes: 4 });
    expect(() => small.put(PNG)).toThrow(/too large/);
  });

  it('rejects a disallowed declared media type', () => {
    expect(() => store.put(PNG, 'image/tiff')).toThrow(/unsupported media type/);
  });

  it('guards resolve against path traversal / bad ids', () => {
    expect(store.resolve('../../etc/passwd')).toBeUndefined();
    expect(store.resolve('nope')).toBeUndefined();
  });

  it('sniffImageType recognizes png/jpeg and rejects junk', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(Buffer.from('hello'))).toBeUndefined();
  });

  it('stores arbitrary files content-addressed with a portable basename', () => {
    const data = Buffer.from('%PDF-1.7\nexample');
    const ref = store.putFile(data, '../reports\\quarterly?.pdf', 'application/pdf; charset=binary');
    expect(ref.name).toBe('quarterly_.pdf');
    expect(ref.mediaType).toBe('application/pdf');
    expect(store.read(ref.id)?.buf.equals(data)).toBe(true);
    expect(store.putFile(data, 'renamed.pdf').id).toBe(ref.id);
    expect(fs.readdirSync(path.join(home, 'attachments'))).toEqual([`${ref.id}.file`]);
  });

  it('sanitizes empty, traversal, control, and shell-active file names', () => {
    expect(sanitizeAttachmentName('../')).toBe('attachment');
    expect(sanitizeAttachmentName('a\u0000b`$?.txt')).toBe('ab___.txt');
  });
});

describe('image adapter helpers', () => {
  let home: string;
  let store: AttachmentStore;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-imgh-'));
    // The helpers construct their own AttachmentStore off KARMAX_HOME.
    process.env.KARMAX_HOME = home;
    store = new AttachmentStore({ home });
  });

  const msgWith = (images: any[]): Message => ({ id: 'm', role: 'user', text: 'look at this', ts: 0, images });

  it('text-only messages are unchanged (string content, no image blocks)', () => {
    const m: Message = { id: 'm', role: 'user', text: 'hello', ts: 0 };
    expect(hasImages([m])).toBe(false);
    expect(anthropicUserContent(m)).toBe('hello');
    expect(openaiUserContent(m)).toBe('hello');
    expect(collectAnthropicImageBlocks([m])).toEqual([]);
  });

  it('builds Anthropic content blocks (text + base64 image)', () => {
    const ref = store.put(PNG, 'image/png');
    const content = anthropicUserContent(msgWith([ref])) as any[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'look at this' });
    expect(content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
  });

  it('builds OpenAI input_image blocks (data URL)', () => {
    const ref = store.put(PNG, 'image/png');
    const content = openaiUserContent(msgWith([ref])) as any[];
    expect(content[0]).toEqual({ type: 'input_text', text: 'look at this' });
    expect(content[1].type).toBe('input_image');
    expect(content[1].image_url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('degrades to text when the referenced bytes are missing', () => {
    const dangling = { id: 'f'.repeat(64), mediaType: 'image/png', bytes: 1 };
    expect(anthropicUserContent(msgWith([dangling]))).toBe('look at this');
  });

  it('materializes image files for the Codex CLI and cleans them up', () => {
    const ref = store.put(PNG, 'image/png');
    const { files, cleanup } = materializeImageFiles([msgWith([ref])]);
    expect(files.length).toBe(1);
    expect(fs.existsSync(files[0]!)).toBe(true);
    expect(fs.readFileSync(files[0]!).equals(PNG)).toBe(true);
    cleanup();
    expect(fs.existsSync(files[0]!)).toBe(false);
  });

  it('materialize is a no-op with no images', () => {
    const { files } = materializeImageFiles([{ id: 'm', role: 'user', text: 'x', ts: 0 }]);
    expect(files).toEqual([]);
  });
});

describe('ordinary file attachment materialization', () => {
  it('checks all attachment hashes in one world command', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-file-batch-'));
    process.env.KARMAX_HOME = home;
    const refs = ['one', 'two', 'three'].map(name => new AttachmentStore({ home }).putFile(Buffer.from(name), `${name}.txt`, 'text/plain'));
    const world = await new MemoryWorldProvider().create({ taskId: 'batch-files', base: 'main' });
    const exec = vi.spyOn(world, 'exec');
    try {
      const messages: Message[] = [{ id: 'm', role: 'user', text: '', ts: 0, files: refs }];
      await materializeFileAttachments(world, messages);
      exec.mockClear();
      await materializeFileAttachments(world, messages);
      expect(exec.mock.calls.filter(([command]) => command === 'sha256sum')).toHaveLength(1);
      expect(exec.mock.calls.filter(([command]) => command === 'chmod')).toHaveLength(0);
    } finally { await world.destroy(); fs.rmSync(home, { recursive: true, force: true }); }
  });
  it('copies durable bytes into the world and annotates only the delivered copy', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fileh-'));
    process.env.KARMAX_HOME = home;
    const data = Buffer.from('source,data\n1,2\n');
    const ref = new AttachmentStore({ home }).putFile(data, 'source data.csv', 'text/csv');
    const original: Message = { id: 'm', role: 'user', text: 'Summarize this.', ts: 0, files: [ref] };
    const world = await new MemoryWorldProvider().create({ taskId: 'files', base: 'main' });

    const delivered = await materializeFileAttachments(world, [original]);
    const relative = worldAttachmentRelative(ref);
    expect(await world.readFileBuffer(relative)).toEqual(data);
    expect(delivered[0]?.text).toContain(`Summarize this.\n\nAttached files`);
    expect(delivered[0]?.text).toContain(path.posix.join(world.handle.root, relative));
    expect(original.text).toBe('Summarize this.');
    expect(fileAttachmentText([ref], world.handle.root)).toContain('source data.csv');

    // A later turn repairs a modified world copy at the same stable path rather
    // than trusting mutable sandbox state or inventing a provider identity.
    fs.chmodSync(path.join(world.handle.root, relative), 0o644);
    fs.writeFileSync(path.join(world.handle.root, relative), 'modified by prior turn');
    const again = await materializeFileAttachments(world, [original]);
    expect(again[0]?.text).toBe(delivered[0]?.text);
    expect(await world.readFileBuffer(relative)).toEqual(data);
    await world.destroy();
  });

  it('fails loudly when a durable reference is dangling', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-file-missing-'));
    process.env.KARMAX_HOME = home;
    const world = await new MemoryWorldProvider().create({ taskId: 'missing-files', base: 'main' });
    const message: Message = { id: 'm', role: 'user', text: '', ts: 0, files: [{
      id: 'f'.repeat(64), name: 'gone.txt', mediaType: 'text/plain', bytes: 4,
    }] };
    await expect(materializeFileAttachments(world, [message])).rejects.toThrow('no longer available');
    await world.destroy();
  });
});
