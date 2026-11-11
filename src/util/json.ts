/** Helpers for reading untyped JSON (Fabric responses, notebook metadata). No `vscode` dependency. */

export type JsonObject = Record<string, unknown>;

/** Whether `value` is a JSON object (not `null`, not a list). */
export function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** `value` if it is a JSON object, else `undefined`. */
export function asObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

/** `value` if it is a non-empty string, else `undefined`. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
