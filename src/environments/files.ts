/**
 * Where an environment lives locally: `src/Environments/<Name>/`, its definition's parts as
 * files (see `definition.ts`) and its properties in `<Name>.yaml`. Identified by name, as
 * notebooks are (no Fabric ID is stored).
 */
import * as vscode from 'vscode';
import { readItemProperties, SOURCE_DIR } from '../notebooks/files';
import type { LocalItems } from '../workspace/metadata';
import { assertSafeWritePath, exists } from '../util/localState';
import { folderNameProblem } from '../util/folderNames';
import { ActionNeededError } from '../util/errorFix';
import { contentFiles, type EnvironmentFile, PART_FOLDERS } from './definition';

export const ENVIRONMENTS_DIR = 'Environments';

/** Contents of a new `<Name>.yaml` for an environment; the placeholder keeps the comment next to its value. */
export const NEW_ENVIRONMENT_PROPERTIES_FILE = `# Fabric environment properties. The environment's name is its folder name.
# Each is optional: without it, upload leaves that property as it is in Fabric.
# folder: "Shared" puts the environment in that workspace folder (created if
# missing); folder: "" puts it in the workspace root.
# Upload sets the environment's description in Fabric to this; description: "" clears it.
description: ""
`;

export interface EnvironmentFiles {
  /** The environment's name in Fabric, which is also its folder name. */
  readonly name: string;
  /** The project folder; files are always written inside it. */
  readonly root: vscode.Uri;
  /** `src/Environments/<Name>/`: the definition's parts below it. */
  readonly folder: vscode.Uri;
  /** `<Name>.yaml` in the folder; may not exist. */
  readonly properties: vscode.Uri;
}

export function environmentFiles(root: vscode.Uri, name: string): EnvironmentFiles {
  const folder = vscode.Uri.joinPath(root, SOURCE_DIR, ENVIRONMENTS_DIR, name);
  return { name, root, folder, properties: vscode.Uri.joinPath(folder, `${name}.yaml`) };
}

/** Throws if an environment name can't be used as a folder name on every OS (it's never changed to fit). */
export function checkEnvironmentName(name: string): void {
  const problem = folderNameProblem(name);
  if (problem) {
    throw new ActionNeededError(`The environment name "${name}" ${problem}, so it can't be saved as a folder. Rename it in Fabric.`);
  }
}

/** The environments in a project: every folder in `src/Environments`, by name, sorted. */
export async function listLocalEnvironments(root: vscode.Uri): Promise<EnvironmentFiles[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, SOURCE_DIR, ENVIRONMENTS_DIR));
  } catch {
    return [];
  }
  return entries
    .filter(([, type]) => type === vscode.FileType.Directory)
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => environmentFiles(root, name));
}

/**
 * An environment's files: every file below its folder except its `<Name>.yaml`, by path.
 * Symbolic links aren't followed.
 */
export async function readEnvironmentFiles(files: EnvironmentFiles): Promise<EnvironmentFile[]> {
  const result: EnvironmentFile[] = [];
  const walk = async (dir: vscode.Uri, prefix: string): Promise<void> => {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      const path = prefix ? `${prefix}/${name}` : name;
      const uri = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.Directory) {
        await walk(uri, path);
      } else if (type === vscode.FileType.File && !(prefix === '' && name === `${files.name}.yaml`)) {
        result.push({ path, bytes: await vscode.workspace.fs.readFile(uri) });
      }
    }
  };
  await walk(files.folder, '');
  return result;
}

/**
 * Writes an environment's files (its definition's parts), byte for byte, and deletes files
 * in its part folders (`Libraries/`, `Setting/`) that aren't among them, e.g. a custom
 * library removed in Fabric, so the folder matches the definition. Other files and the
 * `<Name>.yaml` are left alone. Refuses paths through symbolic links. Returns the paths deleted.
 */
export async function writeEnvironmentFiles(files: EnvironmentFiles, parts: readonly EnvironmentFile[]): Promise<string[]> {
  for (const part of parts) {
    const uri = vscode.Uri.joinPath(files.folder, ...part.path.split('/'));
    await assertSafeWritePath(files.root, uri);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, part.bytes);
  }
  const keep = new Set(parts.map((p) => p.path));
  const deleted: string[] = [];
  for (const existing of await readEnvironmentFiles(files)) {
    if (!keep.has(existing.path) && PART_FOLDERS.includes(existing.path.split('/')[0])) {
      const uri = vscode.Uri.joinPath(files.folder, ...existing.path.split('/'));
      await assertSafeWritePath(files.root, uri);
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: true });
      } catch {
        if (await exists(uri)) {
          await vscode.workspace.fs.delete(uri, { useTrash: false });
        }
      }
      deleted.push(existing.path);
    }
  }
  return deleted;
}

/** The project's local environments, for comparing with the workspace. */
export interface LocalEnvironments extends LocalItems {
  /** A local environment's content files (see `contentFiles`), or `undefined` if it has no folder. */
  readFiles(name: string): Promise<EnvironmentFile[] | undefined>;
}

/** The project's environments in `src/Environments`, for comparing with the workspace (as `localNotebooks` does for notebooks). */
export async function localEnvironments(root: vscode.Uri): Promise<LocalEnvironments> {
  const names = (await listLocalEnvironments(root)).map((e) => e.name);
  return {
    names,
    readFiles: async (name) => {
      const files = environmentFiles(root, name);
      return (await exists(files.folder)) ? contentFiles(await readEnvironmentFiles(files)) : undefined;
    },
    readProperties: (name) => readItemProperties(environmentFiles(root, name)),
  };
}

/** If `uri` is in an environment's folder (`src/Environments/<Name>/…`) in `root`, that environment's files. */
export function environmentFilesFor(root: vscode.Uri, uri: vscode.Uri): EnvironmentFiles | undefined {
  const prefix = `${root.path.replace(/\/$/, '')}/${SOURCE_DIR}/${ENVIRONMENTS_DIR}/`;
  if (uri.scheme !== root.scheme || uri.authority !== root.authority || !uri.path.startsWith(prefix)) {
    return undefined;
  }
  const name = uri.path.slice(prefix.length).split('/')[0];
  return name ? environmentFiles(root, name) : undefined;
}
