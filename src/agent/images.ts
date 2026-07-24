import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Message, ImageRef } from '../domain/types.js';
import { AttachmentStore, ALLOWED_IMAGE_TYPES } from '../store/attachments.js';
import type { ContentBlock } from '@agentclientprotocol/sdk';

/**
 * Adapter-side re-hydration of image attachments (image prompts;
 * PLAN_IMAGE_PROMPTS.md). Messages carry only {@link ImageRef} handles through
 * the workflow/Temporal boundary; here — inside an activity, where filesystem
 * side effects are allowed — we resolve those handles back into whatever shape
 * each provider wants:
 *   • Claude Messages API & Agent SDK → base64 `image` content blocks
 *   • OpenAI/Codex Responses API     → `input_image` data-URL blocks
 *   • Codex CLI                      → real files, passed via `-i <path>`
 */

// Resolve against KARMAX_HOME on each call (constructing is cheap — just an
// idempotent mkdir). NOT cached: the store's dir is fixed at construction, so a
// long-lived cache would pin a stale home if KARMAX_HOME ever changes (e.g. across
// isolated test runs). Adapters run inside activities where this is called rarely.
function attachments(): AttachmentStore {
  return new AttachmentStore();
}

/** Does any non-system message carry images? Cheap gate before building blocks. */
export function hasImages(messages: Message[]): boolean {
  return messages.some((m) => m.role !== 'system' && m.images?.length);
}

/** Anthropic-style image content block from a stored reference (base64). */
function anthropicImageBlock(ref: ImageRef): any | undefined {
  const got = attachments().readBase64(ref.id);
  if (!got) return undefined;
  return { type: 'image', source: { type: 'base64', media_type: got.mediaType, data: got.base64 } };
}

/**
 * Build the `content` for one user message in the Anthropic Messages API / Agent
 * SDK shape. Returns a plain string when there are no (resolvable) images, so the
 * text-only path is byte-for-byte unchanged.
 */
export function anthropicUserContent(m: Message): string | any[] {
  if (!m.images?.length) return m.text;
  const blocks: any[] = [];
  if (m.text) blocks.push({ type: 'text', text: m.text });
  for (const ref of m.images) {
    const b = anthropicImageBlock(ref);
    if (b) blocks.push(b);
  }
  if (!blocks.length) return m.text; // all refs missing → degrade to text
  if (blocks.length === 1 && blocks[0].type === 'text') return m.text;
  return blocks;
}

/**
 * Collect Anthropic image content blocks across all user messages — for the
 * Agent SDK's single streamed prompt, where the whole conversation collapses to
 * one user turn (text is concatenated separately by the caller).
 */
export function collectAnthropicImageBlocks(messages: Message[]): any[] {
  const blocks: any[] = [];
  for (const m of messages) {
    if (m.role === 'system' || !m.images?.length) continue;
    for (const ref of m.images) {
      const b = anthropicImageBlock(ref);
      if (b) blocks.push(b);
    }
  }
  return blocks;
}

/** ACP v1 image content blocks for agents that advertise prompt image support. */
export function collectAcpImageBlocks(messages: Message[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const m of messages) {
    if (m.role === 'system' || !m.images?.length) continue;
    for (const ref of m.images) {
      const got = attachments().readBase64(ref.id);
      if (got) blocks.push({ type: 'image', data: got.base64, mimeType: got.mediaType });
    }
  }
  return blocks;
}

/** OpenAI/Codex Responses API `input_image` block (data URL). */
function openaiImageBlock(ref: ImageRef): any | undefined {
  const got = attachments().readBase64(ref.id);
  if (!got) return undefined;
  return { type: 'input_image', image_url: `data:${got.mediaType};base64,${got.base64}` };
}

/**
 * Build the `content` array for one user message in the OpenAI/Codex Responses
 * API shape. Returns a plain string when there are no images (unchanged path).
 */
export function openaiUserContent(m: Message): string | any[] {
  if (!m.images?.length) return m.text;
  const blocks: any[] = [];
  if (m.text) blocks.push({ type: 'input_text', text: m.text });
  for (const ref of m.images) {
    const b = openaiImageBlock(ref);
    if (b) blocks.push(b);
  }
  if (!blocks.length) return m.text;
  return blocks;
}

/**
 * Materialize the images of the given messages as real files under a temp dir
 * (for the Codex CLI `-i` flag, which takes paths, not base64). Returns the file
 * paths plus a `cleanup()` to remove them after the turn. Empty + no-op cleanup
 * when there are no images.
 */
export function materializeImageFiles(messages: Message[]): { files: string[]; cleanup: () => void } {
  const refs: ImageRef[] = [];
  for (const m of messages) if (m.role !== 'system' && m.images?.length) refs.push(...m.images);
  if (!refs.length) return { files: [], cleanup: () => {} };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-img-'));
  const files: string[] = [];
  for (const ref of refs) {
    const got = attachments().read(ref.id);
    if (!got) continue;
    const ext = ALLOWED_IMAGE_TYPES[got.mediaType] ?? 'png';
    const file = path.join(dir, `${ref.id}.${ext}`);
    fs.writeFileSync(file, got.buf);
    files.push(file);
  }
  return {
    files,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}
