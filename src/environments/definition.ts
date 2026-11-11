/**
 * An environment's definition as local files. No `vscode` dependency.
 *
 * Each part of Fabric's definition is kept as a file at its own path below the environment's
 * folder, byte for byte (as a notebook's `.py` is Fabric's `notebook-content.py`):
 *
 * ```
 * src/Environments/<Name>/
 *   <Name>.yaml                                the environment's description and folder (this extension's)
 *   Setting/Sparkcompute.yml                   Spark compute settings
 *   Libraries/PublicLibraries/environment.yml  public libraries (conda-style YAML)
 *   Libraries/CustomLibraries/<file>           custom libraries: .whl, .py, .jar, .tar.gz
 * ```
 *
 * Every part is optional. `.platform` (Fabric Git integration's metadata, with a `logicalId`)
 * isn't kept, as for notebooks.
 * ([Microsoft: Environment definition](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/environment-definition))
 */
import type { ItemDefinition } from '../fabric/client';
import { fromBase64, toBase64 } from '../util/base64';
import { hashText } from '../util/hash';
import { toLf } from '../util/text';

/** Fabric Git integration's metadata part, which isn't kept locally. */
export const PLATFORM_PART = '.platform';
export const SPARK_COMPUTE_PART = 'Setting/Sparkcompute.yml';
export const PUBLIC_LIBRARIES_PART = 'Libraries/PublicLibraries/environment.yml';
export const CUSTOM_LIBRARIES_FOLDER = 'Libraries/CustomLibraries';
/** Top-level folders of the parts Microsoft documents: re-downloading makes them match Fabric. */
export const PART_FOLDERS: readonly string[] = ['Libraries', 'Setting'];
/** Custom library file types Microsoft documents. */
export const CUSTOM_LIBRARY_EXTENSIONS: readonly string[] = ['.whl', '.py', '.jar', '.tar.gz'];

/** A file of an environment, by its `/`-separated path below the environment's folder (a definition part's path). */
export interface EnvironmentFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Why a part path can't be written below the environment's folder, or `undefined` if it can. */
export function partPathProblem(path: string, name: string): string | undefined {
  if (!path) {
    return 'is empty';
  }
  if (path.includes('\\')) {
    return 'contains a backslash';
  }
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) {
    return 'is absolute';
  }
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return 'has an empty, "." or ".." folder';
  }
  if (segments.length === 1 && segments[0].toLowerCase() === `${name}.yaml`.toLowerCase()) {
    return `would replace the environment's properties file (${name}.yaml)`;
  }
  return undefined;
}

/**
 * The files to write for an environment's definition: every part but `.platform`, byte for
 * byte. Throws if a part's path can't be written below the environment's folder, or two parts
 * would be the same file on a file system that ignores case.
 */
export function filesFromDefinition(name: string, definition: ItemDefinition): EnvironmentFile[] {
  const seen = new Set<string>();
  const files: EnvironmentFile[] = [];
  for (const part of definition.parts) {
    if (part.path === PLATFORM_PART) {
      continue;
    }
    const problem = partPathProblem(part.path, name);
    if (problem) {
      throw new Error(`Fabric returned a part of environment "${name}" whose path ${problem}: "${part.path}".`);
    }
    const key = part.path.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Fabric returned two parts of environment "${name}" that differ only in case: "${part.path}".`);
    }
    seen.add(key);
    files.push({ path: part.path, bytes: fromBase64(part.payload) });
  }
  return files.sort((a, b) => compare(a.path, b.path));
}

/** An environment's definition from its files (parts sorted by path). */
export function definitionFromFiles(files: readonly EnvironmentFile[]): ItemDefinition {
  return {
    parts: [...files]
      .sort((a, b) => compare(a.path, b.path))
      .map((f) => ({ path: f.path, payload: toBase64(f.bytes), payloadType: 'InlineBase64' as const })),
  };
}

/**
 * The part paths whose bytes differ between two definitions, or that only one has, sorted.
 * `.platform` is left out. Used to check that the local files give back Fabric's definition
 * exactly (and, later, which parts an upload changes).
 */
export function differentParts(a: ItemDefinition, b: ItemDefinition): string[] {
  const bytesOf = (d: ItemDefinition) =>
    new Map(d.parts.filter((p) => p.path !== PLATFORM_PART).map((p) => [p.path, toBase64(fromBase64(p.payload))]));
  const [left, right] = [bytesOf(a), bytesOf(b)];
  const paths = new Set([...left.keys(), ...right.keys()]);
  return [...paths].filter((p) => left.get(p) !== right.get(p)).sort(compare);
}

/** Part paths Microsoft doesn't document (kept anyway), for a warning: Fabric may have added a kind of part. */
export function undocumentedParts(definition: ItemDefinition): string[] {
  return definition.parts
    .map((p) => p.path)
    .filter((path) => {
      if (path === PLATFORM_PART || path === SPARK_COMPUTE_PART || path === PUBLIC_LIBRARIES_PART) {
        return false;
      }
      const prefix = `${CUSTOM_LIBRARIES_FOLDER}/`;
      const file = path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
      return !(file && !file.includes('/') && CUSTOM_LIBRARY_EXTENSIONS.some((e) => file.toLowerCase().endsWith(e)));
    });
}

/** Parts that are text: compared and hashed with LF line endings, as notebooks' `.py` are (git may give a file CRLF on Windows). */
const TEXT_PART = /\.(ya?ml|py)$/i;

/** Whether a part is text (YAML settings, or a custom `.py` library), so its line endings don't count when comparing. */
export function isTextPart(path: string): boolean {
  return TEXT_PART.test(path);
}

/** A file's bytes for comparing and hashing: text parts with LF line endings, other parts as they are. */
function comparableBytes(file: EnvironmentFile): string {
  return isTextPart(file.path) ? toLf(new TextDecoder().decode(file.bytes)) : toBase64(file.bytes);
}

/** The files that make up an environment's content: those in its part folders (`Libraries/`, `Setting/`). */
export function contentFiles(files: readonly EnvironmentFile[]): EnvironmentFile[] {
  return files.filter((f) => PART_FOLDERS.includes(f.path.split('/')[0])).sort((a, b) => compare(a.path, b.path));
}

/**
 * The paths of content files (see `contentFiles`) that differ between Fabric's and the local
 * files, or that only one side has, sorted. Line endings of text parts don't count.
 */
export function changedFiles(fabric: readonly EnvironmentFile[], local: readonly EnvironmentFile[]): string[] {
  const contents = (files: readonly EnvironmentFile[]) => new Map(contentFiles(files).map((f) => [f.path, comparableBytes(f)]));
  const [left, right] = [contents(fabric), contents(local)];
  return [...new Set([...left.keys(), ...right.keys()])].filter((p) => left.get(p) !== right.get(p)).sort(compare);
}

/**
 * An environment's content hash for the sync state: SHA-256 of its content files (see
 * `contentFiles`) with their paths, text parts with LF line endings. Equal for files
 * `changedFiles` finds no difference between.
 */
export function hashEnvironment(files: readonly EnvironmentFile[]): Promise<string> {
  return hashText(JSON.stringify(contentFiles(files).map((f) => [f.path, comparableBytes(f)])));
}

/** Paths in a stable order on every OS and locale (code points, not `localeCompare`). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The definition an upload sends: the environment's content files (see `contentFiles`), text
 * parts with LF line endings (a local file may have CRLF, e.g. from git on Windows), as
 * notebooks are uploaded. Nothing else: no `.platform`, and no files outside the part folders.
 */
export function uploadDefinition(files: readonly EnvironmentFile[]): ItemDefinition {
  return definitionFromFiles(
    contentFiles(files).map((f) => (isTextPart(f.path) ? { path: f.path, bytes: new TextEncoder().encode(toLf(new TextDecoder().decode(f.bytes))) } : f)),
  );
}

/**
 * The Spark pool `Setting/Sparkcompute.yml` names (`instance_pool_id`), or `undefined` for
 * none (the starter pool, per Microsoft's docs) or no settings file. Read as a plain line, as
 * Fabric writes it (a top-level key; quotes allowed).
 */
export function instancePoolId(files: readonly EnvironmentFile[]): string | undefined {
  const settings = files.find((f) => f.path === SPARK_COMPUTE_PART);
  const match = settings && /^instance_pool_id:[ \t]*["']?([^"'\s#]+)["']?[ \t]*(#.*)?$/m.exec(new TextDecoder().decode(settings.bytes));
  const id = match?.[1];
  return id && id !== 'null' && id !== '~' ? id : undefined;
}

/**
 * `Setting/Sparkcompute.yml` of a new environment: as Fabric made a default environment in
 * 2026-11 (fixture `DEFAULT_ENVIRONMENT_SPARK_COMPUTE`): the starter pool (no
 * `instance_pool_id`), runtime 2.0. Change it before uploading if your workspace needs otherwise.
 */
export const NEW_ENVIRONMENT_SPARK_COMPUTE = `enable_native_execution_engine: false
driver_cores: 8
driver_memory: 56g
executor_cores: 8
executor_memory: 56g
dynamic_executor_allocation:
  enabled: true
  min_executors: 1
  max_executors: 9
runtime_version: 2.0
`;
