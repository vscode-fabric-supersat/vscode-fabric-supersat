import type * as vscode from 'vscode';

/** An in-memory `Memento` (like `context.globalState`) for tests. */
export function memoryMemento(initial: Record<string, unknown> = {}): Pick<vscode.Memento, 'get' | 'update'> {
  const values = new Map(Object.entries(initial));
  return {
    get: <T>(key: string, defaultValue?: T) => (values.has(key) ? (values.get(key) as T) : defaultValue),
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  } as Pick<vscode.Memento, 'get' | 'update'>;
}
