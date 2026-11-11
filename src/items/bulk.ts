/** Running a command over many items (notebooks, environments…) at once, and what it did. No `vscode` dependency. */
import { mapLimit } from '../util/concurrency';
import { isWarning } from '../util/errorFix';

/** What a bulk command did, item by item. */
export interface BulkResult {
  done: string[];
  /**
   * Not done, for a reason the user sees to (logged as warnings): e.g. a local copy kept, not a
   * Fabric notebook, a notebook type that isn't supported, or a name that can't be a folder.
   */
  skipped: { name: string; reason: string }[];
  /** Attempted, but something unexpected went wrong: Fabric or the file system failed (logged as errors). */
  failed: { name: string; reason: string }[];
  /** Stopped early by the user; the rest weren't attempted. */
  cancelled: boolean;
}

export interface BulkOptions {
  /** Called as each item finishes: its name, how many have finished, and how many there are. */
  onProgress?: (name: string, done: number, total: number) => void;
  isCancelled?: () => boolean;
  /** How many items to work on at once (default 1). */
  concurrency?: number;
}

export type Outcome = { kind: 'done' } | { kind: 'skipped' | 'failed'; reason: string };

/** Runs `task` for each item, `options.concurrency` at a time, and collects a `BulkResult` in the items' order. */
export async function runBulk<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  options: BulkOptions,
  task: (item: T) => Promise<Outcome>,
): Promise<BulkResult> {
  let finished = 0;
  const outcomes = await mapLimit(
    items,
    options.concurrency ?? 1,
    async (item) => {
      let outcome: Outcome;
      try {
        outcome = await task(item);
      } catch (err) {
        // Something the user sees to (e.g. a notebook type that isn't supported) skips the item; anything else is a failure.
        outcome = { kind: isWarning(err) ? 'skipped' : 'failed', reason: message(err) };
      }
      options.onProgress?.(nameOf(item), ++finished, items.length);
      return outcome;
    },
    () => options.isCancelled?.() ?? false,
  );
  const result: BulkResult = { done: [], skipped: [], failed: [], cancelled: false };
  outcomes.forEach((outcome, index) => {
    const name = nameOf(items[index]);
    if (!outcome) {
      result.cancelled = true;
    } else if (outcome.kind === 'done') {
      result.done.push(name);
    } else {
      result[outcome.kind].push({ name, reason: outcome.reason });
    }
  });
  return result;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
