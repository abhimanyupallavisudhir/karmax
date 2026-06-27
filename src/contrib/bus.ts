import { EventEmitter } from 'node:events';
import { KarmaxEvent } from '../domain/types.js';

/**
 * In-process event bus. Activities push typed events here; the gateway streams
 * them to the UI over WebSocket. This is the transport layer (SPEC §3.3) — a
 * router that sits underneath control flow, never the control flow itself.
 */
export class KarmaxBus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(0);
  }
  emit(ev: KarmaxEvent & { seq?: number }) {
    this.ee.emit('event', ev);
    this.ee.emit(`task:${ev.taskId}`, ev);
  }
  onAny(fn: (ev: KarmaxEvent & { seq?: number }) => void): () => void {
    this.ee.on('event', fn);
    return () => this.ee.off('event', fn);
  }
  onTask(taskId: string, fn: (ev: KarmaxEvent & { seq?: number }) => void): () => void {
    this.ee.on(`task:${taskId}`, fn);
    return () => this.ee.off(`task:${taskId}`, fn);
  }
}
