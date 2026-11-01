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
