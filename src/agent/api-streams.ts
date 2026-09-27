import { providerErrorFromMessage } from './limits.js';

/**
 * Streaming readers for the metered API rails (LT-5). Each one reassembles the
 * exact object the non-streaming endpoint returns, so usage accounting, tool
 * calls, stop reasons and error classification downstream are unchanged; text
 * is reported as it arrives. A response that is not an event stream (a proxy
 * or stub that ignores `stream`) is read as the plain JSON body it is.
 */

type TextListener = (text: string) => void;

const isEventStream = (res: Response) => /\btext\/event-stream\b/i.test(res.headers.get('content-type') ?? '');

/** Server-sent events (the subset providers use: `event`/`data` fields, LF or CRLF). */
export async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read().catch((error: unknown) => {
        // A connection cut mid-body is a transport interruption the retry
        // recovers from; cancellation keeps its own AbortError.
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new Error(`turn interrupted before completion: the provider stream was cut (${error instanceof Error ? error.message : String(error)})`, { cause: error });
      });
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const fieldValue = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') data.push(fieldValue);
        else if (field === 'event') event = fieldValue;
      }
      // An event without its terminating blank line is incomplete and is dropped.
      if (done) { finished = true; return; }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** HTTP status the Messages API uses for each error type, so a mid-stream
 * error reads exactly like the same error returned before the stream began. */
const ANTHROPIC_ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400, authentication_error: 401, billing_error: 402, permission_error: 403,
  not_found_error: 404, request_too_large: 413, rate_limit_error: 429, api_error: 500,
  timeout_error: 504, overloaded_error: 529,
};

/** Anthropic Messages API: `stream: true` → the same message object as `res.json()`. */
export async function readAnthropicMessage(res: Response, onText: TextListener): Promise<any> {
  if (!isEventStream(res) || !res.body) return res.json();
  let message: any = {};
  const content: any[] = [];
  const inputJson = new Map<number, string>();
  const text = () => content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
  for await (const { data } of serverSentEvents(res.body)) {
    const event = JSON.parse(data);
    switch (event.type) {
      case 'message_start':
        message = event.message ?? {};
        break;
      case 'content_block_start':
        content[event.index] = { ...event.content_block };
        break;
      case 'content_block_delta': {
        const block = content[event.index];
        const delta = event.delta ?? {};
        if (!block) break;
        if (delta.type === 'text_delta') {
          block.text = (block.text ?? '') + delta.text;
          onText(text());
        } else if (delta.type === 'input_json_delta') {
          inputJson.set(event.index, (inputJson.get(event.index) ?? '') + delta.partial_json);
        } else if (delta.type === 'thinking_delta') {
          block.thinking = (block.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta') {
          block.signature = delta.signature;
        } else if (delta.type === 'citations_delta') {
          (block.citations ??= []).push(delta.citation);
        }
        break;
      }
      case 'content_block_stop': {
        const json = inputJson.get(event.index);
        if (json !== undefined && content[event.index]) content[event.index].input = json ? JSON.parse(json) : {};
        inputJson.delete(event.index);
        break;
      }
      case 'message_delta': {
        const usage = Object.fromEntries(Object.entries(event.usage ?? {}).filter(([, value]) => value != null));
        message = { ...message, ...event.delta, usage: { ...message.usage, ...usage } };
        break;
      }
      case 'message_stop':
        return { ...message, content };
      case 'error': {
        const status = ANTHROPIC_ERROR_STATUS[event.error?.type] ?? 'stream error';
        throw providerErrorFromMessage('claude', `Anthropic API ${status}: ${data.slice(0, 500)}`, 'structured');
      }
      default:
        break; // ping and future event types
    }
  }
  throw new Error('turn interrupted before completion: the Anthropic stream ended before message_stop');
}

/** HTTP status OpenAI returns for the error codes a Responses stream can carry. */
const OPENAI_ERROR_STATUS: Record<string, number> = {
  invalid_api_key: 401, rate_limit_exceeded: 429, insufficient_quota: 429, server_error: 500, invalid_prompt: 400,
};

/** A stream `error` event, or a response that failed mid-generation, reads
 * exactly like the same error returned as an HTTP status before the stream
 * began, so a transient outage is still retried (#396 review item 4). */
const openAiStreamFailure = (error: Record<string, unknown>) => providerErrorFromMessage('codex',
  `OpenAI Responses API ${OPENAI_ERROR_STATUS[String(error.code)] ?? 'stream error'}: ${JSON.stringify({ error }).slice(0, 500)}`, 'structured');

/** OpenAI Responses API: `stream: true` → its terminal event's response object,
 * which is the same object `res.json()` returns (status, output, usage). */
export async function readOpenAiResponse(res: Response, onText: TextListener): Promise<any> {
  if (!isEventStream(res) || !res.body) return res.json();
  const parts = new Map<string, string>();
  for await (const { data } of serverSentEvents(res.body)) {
    if (data === '[DONE]') continue;
    const event = JSON.parse(data);
    switch (event.type) {
      case 'response.output_text.delta': {
        const key = `${event.item_id ?? event.output_index}:${event.content_index ?? 0}`;
        parts.set(key, (parts.get(key) ?? '') + event.delta);
        onText([...parts.values()].join('\n'));
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
        return event.response;
      case 'response.failed':
        throw openAiStreamFailure(event.response?.error ?? {});
      case 'error': {
        const { type: _type, sequence_number: _sequence, ...error } = event;
        throw openAiStreamFailure(error);
      }
      default:
        break;
    }
  }
  throw new Error('turn interrupted before completion: the OpenAI Responses stream ended before its terminal event');
}
