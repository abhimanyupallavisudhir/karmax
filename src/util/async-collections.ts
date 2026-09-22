/** Sequential async collections: preserve callback order while allowing I/O to yield. */
export async function map<T, U>(items: readonly T[], fn: (value: T, index: number, items: readonly T[]) => U | Promise<U> | Promise<U | Promise<U>>): Promise<Awaited<U>[]> {
  const result: Awaited<U>[] = [];
  for (let i = 0; i < items.length; i++) if (i in items) result[i] = await fn(items[i]!, i, items);
  return result;
}
export async function flatMap<T, U>(items: readonly T[], fn: (value: T, index: number, items: readonly T[]) => U | readonly U[] | Promise<U | readonly U[]>): Promise<U[]> {
  return (await map(items, fn)).flat() as U[];
}
export async function filter<T>(items: readonly T[], fn: (value: T, index: number, items: readonly T[]) => unknown | Promise<unknown>): Promise<T[]> {
  const result: T[] = [];
  for (let i = 0; i < items.length; i++) if (i in items && await fn(items[i]!, i, items)) result.push(items[i]!);
  return result;
}
export async function find<T>(items: readonly T[], fn: (value: T, index: number, items: readonly T[]) => unknown | Promise<unknown>): Promise<T | undefined> {
  for (let i = 0; i < items.length; i++) if (await fn(items[i]!, i, items)) return items[i];
}
export async function some<T>(items: readonly T[], fn: (value: T, index: number, items: readonly T[]) => unknown | Promise<unknown>): Promise<boolean> {
  for (let i = 0; i < items.length; i++) if (i in items && await fn(items[i]!, i, items)) return true;
  return false;
}
export async function every<T>(items: readonly T[], fn: (value: T, index: number, items: readonly T[]) => unknown): Promise<boolean> {
  for (let i = 0; i < items.length; i++) if (i in items && !await fn(items[i]!, i, items)) return false;
  return true;
}
export async function forEach<T>(items: readonly T[], fn: (value: T, index: number, items: readonly T[]) => unknown | Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i++) if (i in items) await fn(items[i]!, i, items);
}
export async function reduce<T, U>(items: readonly T[], fn: (accumulator: U, value: T, index: number, items: readonly T[]) => U | Promise<U>, initial: U): Promise<U> {
  let result = initial;
  for (let i = 0; i < items.length; i++) if (i in items) result = await fn(result, items[i]!, i, items);
  return result;
}
export async function sort<T>(items: T[], compare: (a: T, b: T) => number | Promise<number>): Promise<T[]> {
  // Stable merge sort. Never pass an async comparator to Array.sort.
  async function sorted(input: T[]): Promise<T[]> {
    if (input.length < 2) return input;
    const mid = Math.floor(input.length / 2), left = await sorted(input.slice(0, mid)), right = await sorted(input.slice(mid));
    const out: T[] = [];
    let a = 0, b = 0;
    while (a < left.length && b < right.length) out.push(await compare(left[a]!, right[b]!) <= 0 ? left[a++]! : right[b++]!);
    return [...out, ...left.slice(a), ...right.slice(b)];
  }
  const ordered = await sorted(items.slice());
  for (let i = 0; i < ordered.length; i++) items[i] = ordered[i]!;
  return items;
}
export async function from<T, U>(items: Iterable<T> | ArrayLike<T>, fn: (value: T, index: number) => U | Promise<U>): Promise<Awaited<U>[]> {
  return map(Array.from(items), fn);
}
