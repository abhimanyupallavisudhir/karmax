import type http from 'node:http';

/** The HTTP status an error is answered with. Most name their own
 * (CapabilityError → 403, NotFoundError → 404, ValidationError → 400). An
 * error carrying another service's status (`upstream`, e.g. GitHub's API) may
 * not pass on its 401: the console signs out on one, and GitHub refusing
 * tavya's token is GitHub failing this request (502), not the person being
 * signed out. A malformed %-escape in the address is the caller's (400). */
export function errorStatus(e: unknown, fallback: number): number {
  if (e instanceof URIError) return 400;
  const status = (e as { status?: unknown })?.status;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) return fallback;
  return status === 401 && (e as { upstream?: unknown }).upstream === true ? 502 : status;
}

/** Errors a request's own streams fail with when its connection is gone: Node
 * destroys the body of a request whose socket closed before it was answered
 * with ECONNRESET "aborted", and a stream piped from or to it ends with a
 * premature close, EPIPE or "write after destroy". */
const CONNECTION_LOST = new Set(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNABORTED']);

/** Whether a request failed only because its client went away (a closed tab,
 * a reload, a phone out of signal): nobody is left to answer, and nothing in
 * tavya failed. Both must hold: the connection is closed, and the error is one
 * a lost connection causes. The same code from a service tavya called while the
 * client still waits is tavya's failure to report, and a bug that merely runs
 * after the client left is still a bug. */
export function clientWentAway(e: unknown, req: http.IncomingMessage | undefined): boolean {
  if (req?.socket?.destroyed !== true) return false;
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && CONNECTION_LOST.has(code);
}
