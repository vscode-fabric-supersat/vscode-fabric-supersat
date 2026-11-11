/**
 * Runs `task` for each item, at most `limit` at a time, and returns the results in the
 * items' order (whatever order they finish in). Once `isCancelled` returns true, items not
 * yet started are skipped (their result is `undefined`). A task that throws rejects the
 * whole run, so tasks that should carry on past failures catch their own errors.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
  isCancelled: () => boolean = () => false,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !isCancelled()) {
      const index = next++;
      results[index] = await task(items[index], index);
    }
  };
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}
