/** The files (parts) of a notebook's definition as Fabric returns it. No `vscode` dependency. */
import type { ItemDefinition } from '../fabric/client';
import { fromBase64 } from '../util/base64';

/** A notebook's Git-format file in a definition: `notebook-content.<ext>` (`.py`, `.sql`, `.scala`, `.r`). */
export const NOTEBOOK_CONTENT_PART = /^notebook-content\.[a-z]+$/i;

/** The definition's Git-format files (normally one). */
export function contentParts(definition: ItemDefinition): ItemDefinition['parts'] {
  return definition.parts.filter((p) => NOTEBOOK_CONTENT_PART.test(p.path));
}

/** A part's text (its payload is Base64 of UTF-8). */
export function partText(part: ItemDefinition['parts'][number]): string {
  return new TextDecoder().decode(fromBase64(part.payload));
}

/** The text of the first part whose path ends with `extension`, or `undefined` if there is none. */
export function findPartText(definition: ItemDefinition, extension: string): string | undefined {
  const part = definition.parts.find((p) => p.path.endsWith(extension));
  return part && partText(part);
}

/** The text of the first part whose path ends with `extension`; throws, naming the parts there are, if there is none. */
export function requirePartText(definition: ItemDefinition, extension: string): string {
  const text = findPartText(definition, extension);
  if (text === undefined) {
    const paths = definition.parts.map((p) => p.path).join(', ') || 'none';
    throw new Error(`Fabric returned no ${extension} file for the notebook (got: ${paths}).`);
  }
  return text;
}
