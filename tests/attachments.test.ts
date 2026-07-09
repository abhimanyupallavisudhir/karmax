import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { AttachmentStore, AttachmentError, sniffImageType } from '../src/store/attachments.js';
import {
  anthropicUserContent,
  openaiUserContent,
  collectAnthropicImageBlocks,
  materializeImageFiles,
  hasImages,
} from '../src/agent/images.js';
import { Message } from '../src/domain/types.js';

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
