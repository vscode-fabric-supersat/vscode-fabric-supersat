/** Matching Fabric item names. No `vscode` dependency. */

/**
 * The item named `name`. Fabric names are unique per workspace (and item type) ignoring
 * case; an exact match is preferred anyway.
 */
export function findByName<T extends { displayName: string }>(items: readonly T[], name: string): T | undefined {
  const key = name.toLowerCase();
  return items.find((i) => i.displayName === name) ?? items.find((i) => i.displayName.toLowerCase() === key);
}
