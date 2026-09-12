import type { TaskView } from './types.js';

export type ViewConversation = Pick<TaskView, 'messages' | 'transcripts'>;
export type PublishedView = Omit<TaskView, 'messages' | 'transcripts'> & Partial<ViewConversation>;

/** Keep immutable conversations out of repeated status activity arguments.
 * References are scoped to a workflow run and never depend on the mutable UI
 * projection. Replays rebuild this cache; only acknowledged writes are reused. */
export function conversationPublisher(
  runId: string,
  write: (view: PublishedView, reference: string) => Promise<void>,
): (view: TaskView) => Promise<void> {
  let previous: { json: string; reference: string } | undefined;
  let revision = 0;
  return async (view) => {
    const { messages, transcripts, ...status } = view;
    const json = JSON.stringify({ messages, transcripts });
    const cached = previous?.json === json ? previous : undefined;
    const reference = cached?.reference ?? `${runId}:${revision++}`;
    await write(cached ? status : { ...status, ...JSON.parse(json) }, reference);
    previous = { json, reference };
  };
}
