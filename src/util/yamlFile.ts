/**
 * Reading and updating the YAML files this extension keeps for people to read and edit
 * (local settings now, item metadata later). All of them go through these helpers so
 * they behave the same way:
 *
 * - Updates change only the values given and keep everything else as the person left
 *   it: comments, key order, blank lines and quoting.
 * - Strings are written double-quoted, so IDs and names are never read back as numbers,
 *   booleans or dates.
 * - A file with YAML errors is never overwritten; the error names the file and line.
 */
import * as vscode from 'vscode';
import { type Document, isScalar, LineCounter, parseDocument, Scalar } from 'yaml';

export type YamlPath = readonly (string | number)[];

export class YamlFileError extends Error {
  constructor(
    readonly uri: vscode.Uri,
    detail: string,
  ) {
    super(`${uri.toString(true)}: ${detail}`);
    this.name = 'YamlFileError';
  }
}

/** A parsed YAML file, with typed accessors for reading values. */
export class YamlFile {
  constructor(
    readonly uri: vscode.Uri,
    readonly document: Document,
  ) {}

  /**
   * The value at `path` as a trimmed string, or `undefined` if missing or empty.
   * Numbers and booleans are accepted (an unquoted `name: 2024` is still a name);
   * a map or list is reported as an error.
   */
  getString(path: YamlPath): string | undefined {
    const value: unknown = this.document.getIn(path);
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value).trim() || undefined;
    }
    throw new YamlFileError(this.uri, `"${path.join('.')}" should be a single value, not a list or map.`);
  }
}

/** Reads and parses a YAML file. `undefined` if it doesn't exist; throws `YamlFileError` if it isn't valid YAML. */
export async function readYamlFile(uri: vscode.Uri): Promise<YamlFile | undefined> {
  const text = await readText(uri);
  return text === undefined ? undefined : new YamlFile(uri, parse(uri, text));
}

/**
 * Sets values in a YAML file, keeping its comments and layout. `undefined` removes a value.
 * If the file doesn't exist it is created from `newFileText`: a template whose comments
 * explain the file, and whose placeholder keys (e.g. `id: ""`) keep each comment next to
 * the value it describes.
 */
export async function updateYamlFile(
  uri: vscode.Uri,
  values: readonly (readonly [YamlPath, string | number | boolean | undefined])[],
  newFileText: string,
): Promise<void> {
  const text = (await readText(uri)) ?? newFileText;
  const document = parse(uri, text);
  try {
    for (const [path, value] of values) {
      if (value === undefined) {
        document.deleteIn(path);
      } else {
        const existing: unknown = document.getIn(path, true);
        if (isScalar(existing)) {
          // Change the value in place: replacing the node would drop its end-of-line comment.
          existing.value = value;
          existing.type = typeof value === 'string' ? Scalar.QUOTE_DOUBLE : undefined;
        } else {
          document.setIn(path, toNode(value));
        }
      }
    }
  } catch (err) {
    // e.g. the file's top level is a list, so there is no map to put the key in.
    throw new YamlFileError(uri, `can't update it: ${err instanceof Error ? err.message : String(err)}`);
  }
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(document.toString()));
}

function toNode(value: string | number | boolean): Scalar {
  const node = new Scalar(value);
  if (typeof value === 'string') {
    node.type = Scalar.QUOTE_DOUBLE;
  }
  return node;
}

function parse(uri: vscode.Uri, text: string): Document {
  // YAML 1.2 (the default): `no`, `on` and the like stay strings.
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { lineCounter, prettyErrors: false });
  const [error] = document.errors;
  if (error) {
    const { line } = lineCounter.linePos(error.pos[0]);
    throw new YamlFileError(uri, `line ${line}: ${error.message.split('\n')[0]}`);
  }
  return document;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      return undefined;
    }
    throw err;
  }
}
