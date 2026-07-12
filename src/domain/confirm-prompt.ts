/**
 * The Confirm agent's per-Review request message (SPEC §5.2). Each time a task
 * reaches the Review gate with an agent confirmer, one message rendered from this
 * template is appended to the Confirm transcript — the task prompt plus the Do
 * agent's latest response — so repeated Reviews read as ONE conversation:
 * request, verdict, request with the new response, ad recursum.
 *
 * The template is user-editable per task/project/global via the confirmer field
 * (`ConfirmConfig.prompt`); this constant is the pre-filled default. Pure module
 * (no Node imports) so the Temporal workflow sandbox, the manifests, and the
 * gateway can all share it.
 */

export const CONFIRM_PROMPT_DEFAULT = `Recap: the task the agent was asked to complete was:

-----
{{prompt}}
-----

The agent has worked on the task and produced the following response:

-----
{{response}}
-----

Please check whether the agent has completed the task as specified, then call confirm_decision exactly once: action:"confirm" to accept the work, or action:"revise" with follow-up feedback in \`text\` to send it back to the agent (action:"reject" cancels the task).`;

/** Bindings a confirm-prompt template may reference. Beyond the two in the
 *  default ({{prompt}}, {{response}}), custom templates may also use
 *  {{title}}, {{reviewInfo}}, {{changedFiles}} and {{transcript}}. */
export type ConfirmPromptValues = Record<string, string>;

/** Render a confirm-prompt template (the task's own, or the default when unset).
 *  Unknown {{placeholders}} render empty, mirroring assemblePrompt. */
export function renderConfirmPrompt(template: string | undefined, values: ConfirmPromptValues): string {
  const tpl = template?.trim() ? template : CONFIRM_PROMPT_DEFAULT;
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');
}
