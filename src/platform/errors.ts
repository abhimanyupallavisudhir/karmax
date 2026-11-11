/** Platform errors that declare their own HTTP status, so the gateway and the
 * MCP servers answer every route alike (see `Gateway.fail`). */

export class CapabilityError extends Error {
  code = 'capability_denied';
  /** HTTP status the gateway answers with. Kept on the class so one mapping in
   *  `Gateway.fail` covers every route instead of each handler wrapping locally. */
  status = 403;
}

/**
 * A named identifier did not resolve. An agent has to be able to tell this from
 * a denial (escalate) and from a server fault (back off) — `no such task <id>`
 * used to reach the client as a 500, which reads as "karmax is broken" rather
 * than "you passed the wrong id".
 */
export class NotFoundError extends Error {
  code = 'not_found';
  status = 404;
}

/** Caller-supplied input was rejected. A 400, never a 500. */
export class ValidationError extends Error {
  code = 'invalid_request';
  status = 400;
}

/** The request contradicts the current state of what it names (an update
 * that would change a vault item's type, a decision already taken). A 409:
 * the caller's to resolve, never a server fault. */
export class ConflictError extends Error {
  code = 'conflict';
  status = 409;
}

/**
 * A whole-form save meant for a draft or an armed task reached it after it
 * started (its trigger fired meanwhile): its params are now the workflow's,
 * which takes in-flight edits only. A 409 the console answers by showing the
 * running task.
 */
export class TaskStartedError extends Error {
  code = 'task_started';
  status = 409;
}
