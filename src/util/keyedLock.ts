/**
 * Runs tasks with the same key one at a time, in the order they were asked for; tasks with
 * different keys run at once. No `vscode` dependency.
 *
 * A task asked for with `share` while one with `share` is already waiting (not yet started)
 * for the same key doesn't queue again: it gets that waiting task's result. So repeated
 * requests for the same thing (e.g. clicking Save and Upload three times) run at most twice:
 * the one running, and one more after it with whatever has changed since.
 */
export class KeyedLock {
  private readonly keys = new Map<string, { tail: Promise<void>; waiting?: { promise: Promise<unknown>; share: boolean } }>();

  /**
   * Runs `task` once no earlier task for `key` is running or waiting. `task` is told whether
   * it had to wait (so it can check again anything it read before).
   */
  run<T>(key: string, task: (waited: boolean) => Promise<T>, options: { share?: boolean } = {}): Promise<T> {
    const share = options.share ?? false;
    const entry = this.keys.get(key);
    if (share && entry?.waiting?.share) {
      return entry.waiting.promise as Promise<T>;
    }
    const waited = entry !== undefined;
    const current = entry ?? { tail: Promise.resolve() };
    const waiting: { promise: Promise<unknown>; share: boolean } = { promise: Promise.resolve(), share };
    const promise = current.tail.then(() => {
      if (current.waiting === waiting) {
        current.waiting = undefined;
      }
      return task(waited);
    });
    waiting.promise = promise;
    current.waiting = waited ? waiting : undefined;
    const tail = promise.then(
      () => undefined,
      () => undefined,
    );
    current.tail = tail;
    this.keys.set(key, current);
    void tail.then(() => {
      if (this.keys.get(key)?.tail === tail) {
        this.keys.delete(key);
      }
    });
    return promise;
  }

  /** Whether a task for `key` is running or waiting. */
  busy(key: string): boolean {
    return this.keys.has(key);
  }
}
