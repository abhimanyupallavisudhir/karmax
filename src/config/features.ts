/**
 * Process-wide feature flags. Keep these pure constants: workflow code must not
 * read environment variables or other mutable process state during replay.
 *
 * The Resolve agent is deliberately off. Scripted auto-resolution and direct
 * escalation remain part of the software-development workflow.
 */
export const RESOLVE_AGENT_ENABLED = false;

/**
 * "Explain this with <model>" under agent messages is off: calling another agent
 * into the conversation does the same job. Off hides the button, the Explanation
 * model settings and the Explainer-only API-key mode, and refuses new
 * explanations; explanations already saved stay in their conversations.
 */
export const EXPLANATIONS_ENABLED = false;
