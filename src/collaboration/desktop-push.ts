import type { PushMessage } from './push-delivery.js';

/**
 * Push to the desktop apps (wiki features/desktop-apps): Web Push needs a
 * service worker, which Electron does not run, so a desktop device is reached
 * over the console's own live connection (`/ws`) while the app runs. The
 * console in the app announces its device id on connect
 * (`{type: 'push-device', deviceId}`); the gateway checks the device is the
 * person's own and registers the socket here; `PushDeliveryAdapter` sends
 * `{type: 'push', deviceId, title, body, url, tag, urgency}` to every socket
 * that announced the device. None connected: the message is dropped, not
 * retried — the inbox keeps the item, and the app re-reads it when it opens.
 *
 * In-process, like change notices: a deployment with several gateways would
 * need to carry these between them (the delivery runs where the gateway does).
 */
export interface DesktopPushMessage extends PushMessage { type: 'push'; deviceId: string }

interface Sink { userId: string; send: (message: DesktopPushMessage) => boolean }

export class DesktopPushSockets {
  private byDevice = new Map<string, Set<Sink>>();

  /** A socket of `userId` that announced `deviceId`; the returned function forgets it. */
  announce(deviceId: string, userId: string, send: Sink['send']): () => void {
    const sink: Sink = { userId, send };
    let sinks = this.byDevice.get(deviceId);
    if (!sinks) this.byDevice.set(deviceId, sinks = new Set());
    sinks.add(sink);
    return () => {
      sinks!.delete(sink);
      if (!sinks!.size && this.byDevice.get(deviceId) === sinks) this.byDevice.delete(deviceId);
    };
  }

  /** How many sockets took the message (0: the app is not running). */
  send(userId: string, deviceId: string, message: PushMessage): number {
    let taken = 0;
    for (const sink of this.byDevice.get(deviceId) ?? []) {
      if (sink.userId !== userId) continue;
      try { if (sink.send({ type: 'push', deviceId, ...message })) taken++; } catch { /* closing */ }
    }
    return taken;
  }

  /** Sockets announcing a device (diagnostics, tests). */
  connected(deviceId: string): number { return this.byDevice.get(deviceId)?.size ?? 0; }
}
