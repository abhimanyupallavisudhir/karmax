/**
 * Process-wide feature flags. Keep these pure constants: workflow code must not
 * read environment variables or other mutable process state during replay.
 *
 * The Resolve agent is deliberately off. Scripted auto-resolution and direct
 * escalation remain part of the software-development workflow.
 */
export const RESOLVE_AGENT_ENABLED = false;
