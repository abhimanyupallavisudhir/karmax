/** Trivial activities used to smoke-test the durable substrate. */
export const pingActivities = {
  async now(): Promise<number> {
    return Date.now();
  },
  async echo(s: string): Promise<string> {
    return `echo:${s}`;
  },
};
