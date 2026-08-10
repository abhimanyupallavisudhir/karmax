/** Default request sent to an agent configured as a task's Responder. */
export const RESPOND_PROMPT_DEFAULT = `The working agent paused this task for input.

Task: {{title}}
Original request:
{{prompt}}

Why the task is waiting:
{{question}}

Recent working-agent transcript:
{{transcript}}

Give the working agent a concise, decisive answer that unblocks the task. Do not perform the task or review the finished proposal yourself.`;

export function renderRespondPrompt(
  template: string | undefined,
  bindings: { title: string; prompt: string; question: string; transcript: string },
): string {
  const source = template?.trim() ? template : RESPOND_PROMPT_DEFAULT;
  return source.replace(/\{\{(title|prompt|question|transcript)\}\}/g, (_match, key: keyof typeof bindings) => bindings[key] ?? '');
}
