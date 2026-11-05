import { Context } from '@temporalio/activity';

/** Trivial activities used to smoke-test the durable substrate. */
export const pingActivities = {
  async now(): Promise<number> {
    return Date.now();
  },
  async echo(s: string): Promise<string> {
    return `echo:${s}`;
  },
  /** Outlasts a worker stop on its first attempt; answers which attempt finished. */
  async stallOnce(ms: number): Promise<number> {
    const { attempt } = Context.current().info;
    if (attempt === 1) await new Promise(resolve => setTimeout(resolve, ms));
    return attempt;
  },
};
