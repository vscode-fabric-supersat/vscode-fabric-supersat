/**
 * Where a notebook lives locally. Each notebook is identified by its name (no Fabric ID
 * is stored), and has two files that are kept in sync:
 *
 * - `src/Notebooks/<Name>/<Name>.py`: Fabric's Git format, for source control.
 *   This is what gets uploaded.
 * - `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`: Jupyter, with outputs.
 *   Local to you (git ignores `.fabric-supersat`).
 *
 * Optionally, `src/Notebooks/<Name>/notebook.yaml` holds the notebook's properties
 * (its description), for source control next to the `.py`.
 */
import * as vscode from 'vscode';
import {
  assertSafeWritePath,
  ensureLocalStateDir,
  type EnsureLocalStateDirOptions,
  exists,
  LOCAL_DIR_NAME,
  localStateDir,
} from '../util/localState';
import { readYamlFile, updateYamlFile, YamlFileError } from '../util/yamlFile';
import {
  type FabricNotebook,
  fabricToIpynb,
  formatFabricPy,
  ipynbToFabric,
  isFabricIpynb,
  isFabricPy,
  parseFabricPy,
  withKeyOrderOf,
} from './format';

export const NOTEBOOKS_DIR = 'Notebooks';
export const SOURCE_DIR = 'src';
/** Fabric's name for the Git-format file in a notebook definition (not the local file name). */
export const FABRIC_PY_PART = 'notebook-content.py';
/** The notebook's properties, next to its `.py`. Optional. */
export const PROPERTIES_FILE = 'notebook.yaml';
/** Fabric's limit for item descriptions. */
export const MAX_DESCRIPTION_LENGTH = 256;
const DESCRIPTION = ['description'] as const;

/** Contents of a new `notebook.yaml`; the placeholder keeps the comment next to its value. */
export const NEW_PROPERTIES_FILE = `# Fabric notebook properties. The notebook's name is its folder name.
# Upload sets the notebook's description in Fabric to this. Without a description
# here, upload leaves it as it is in Fabric; description: "" clears it.
description: ""
`;

export interface NotebookFiles {
  /** The notebook's name in Fabric, which is also its folder name. */
  readonly name: string;
  /** The project folder; both files are always written inside it. */
  readonly root: vscode.Uri;
  readonly py: vscode.Uri;
  readonly ipynb: vscode.Uri;
  /** `notebook.yaml` next to the `.py`; may not exist. */
  readonly properties: vscode.Uri;
  /** The project's `.fabric-supersat` folder. */
  readonly localDir: vscode.Uri;
}

export type NotebookFileKind = 'py' | 'ipynb';

export function notebookFiles(root: vscode.Uri, name: string): NotebookFiles {
  const localDir = localStateDir(root);
  return {
    name,
    root,
    py: vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOKS_DIR, name, `${name}.py`),
    properties: vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOKS_DIR, name, PROPERTIES_FILE),
    ipynb: vscode.Uri.joinPath(localDir, NOTEBOOKS_DIR, name, `${name}.ipynb`),
    localDir,
  };
}

/** If `uri` is one of a notebook's two files in `root`, that notebook and which file it is. */
export function notebookFilesFor(
  root: vscode.Uri,
  uri: vscode.Uri,
): { files: NotebookFiles; kind: NotebookFileKind } | undefined {
  const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`;
  if (uri.scheme !== root.scheme || uri.authority !== root.authority || !uri.path.startsWith(prefix)) {
    return undefined;
  }
  const [top, notebooks, name, file, ...rest] = uri.path.slice(prefix.length).split('/');
  if (rest.length || notebooks !== NOTEBOOKS_DIR || !name) {
    return undefined;
  }
  // `Uri.path` is already decoded, so `name` is the notebook name as-is.
  if (top === SOURCE_DIR && file === `${name}.py`) {
    return { files: notebookFiles(root, name), kind: 'py' };
  }
  if (top === LOCAL_DIR_NAME && file === `${name}.ipynb`) {
    return { files: notebookFiles(root, name), kind: 'ipynb' };
  }
  return undefined;
}

/**
 * Throws if a notebook name can't be used as a folder name on every OS. Names are never
 * changed to fit, since the folder name is how the notebook is found again on upload.
 */
export function checkNotebookName(name: string): void {
  const problem =
    /[\\/:*?"<>|\u0000-\u001f]/.test(name)
      ? 'contains a character that isn\'t allowed in folder names (\\ / : * ? " < > |)'
      : name !== name.trim() || name.endsWith('.')
        ? 'starts or ends with a space, or ends with a dot'
        : name === '' || name === '.' || name === '..'
          ? 'is empty'
          : undefined;
  if (problem) {
    throw new Error(`The notebook name "${name}" ${problem}, so it can't be saved as a folder. Rename it in Fabric.`);
  }
}

/** The notebook types that use Fabric's `.py` Git format, so can be created and uploaded. */
export type NewNotebookType = 'pyspark' | 'python';

/**
 * What a new notebook starts with: one empty Python cell. The kernel and language group are
 * the ones Fabric writes for each type (PySpark: Fabric's docs and samples; Python: a
 * notebook downloaded from Fabric in 2026-11, see the test fixtures).
 */
export const NEW_NOTEBOOKS: Readonly<Record<NewNotebookType, FabricNotebook>> = {
  pyspark: {
    meta: { kernel_info: { name: 'synapse_pyspark' }, dependencies: {} },
    cells: [{ kind: 'code', source: '', meta: { language: 'python', language_group: 'synapse_pyspark' } }],
  },
  python: {
    meta: { kernel_info: { name: 'jupyter', jupyter_kernel_name: 'python3.12' }, dependencies: {} },
    cells: [{ kind: 'code', source: '', meta: { language: 'python', language_group: 'jupyter_python' } }],
  },
};

/**
 * Creates a new notebook's files (`.py` and `.ipynb`) of the given type. Throws if the name can't be a
 * folder name, or if either file already exists.
 */
export async function createNotebookFiles(files: NotebookFiles, type: NewNotebookType = 'pyspark'): Promise<void> {
  checkNotebookName(files.name);
  for (const uri of [files.py, files.ipynb]) {
    if (await exists(uri)) {
      throw new Error(`Notebook "${files.name}" already exists: ${uri.path.split('/').slice(-3).join('/')}`);
    }
  }
  const notebook = NEW_NOTEBOOKS[type];
  await writeNotebookFiles(files, formatFabricPy(notebook), fabricToIpynb(notebook));
}

/**
 * The notebooks in a project: every `src/Notebooks/<Name>/<Name>.py` and
 * `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`, by name, sorted.
 */
export async function listLocalNotebooks(root: vscode.Uri): Promise<NotebookFiles[]> {
  const names = new Set<string>();
  const places: [vscode.Uri, string][] = [
    [vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOKS_DIR), '.py'],
    [vscode.Uri.joinPath(localStateDir(root), NOTEBOOKS_DIR), '.ipynb'],
  ];
  for (const [dir, extension] of places) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      continue; // No notebooks folder yet.
    }
    for (const [name, type] of entries) {
      if (type & vscode.FileType.Directory && (await exists(vscode.Uri.joinPath(dir, name, `${name}${extension}`)))) {
        names.add(name);
      }
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => notebookFiles(root, name));
}

/** Whether either of a notebook's files exists locally. */
export async function hasLocalCopy(files: NotebookFiles): Promise<boolean> {
  return (await exists(files.py)) || (await exists(files.ipynb));
}

/** Writes both files of a downloaded notebook. */
export async function writeNotebookFiles(files: NotebookFiles, pyText: string, ipynbText: string): Promise<void> {
  await ensureLocalStateDir(files.localDir);
  await writeText(files.root, files.py, pyText);
  await writeText(files.root, files.ipynb, ipynbText);
}

/**
 * The description in the notebook's `notebook.yaml`: `undefined` when there is no file or
 * no `description` in it (so Fabric's is left alone), `''` to clear it. Throws
 * `YamlFileError` if the file is invalid or the description is too long for Fabric.
 */
export async function readNotebookDescription(files: NotebookFiles): Promise<string | undefined> {
  const file = await readYamlFile(files.properties);
  const value: unknown = file?.document.getIn(DESCRIPTION);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new YamlFileError(files.properties, '"description" should be text, not a list or map.');
  }
  const description = String(value);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new YamlFileError(
      files.properties,
      `the description is ${description.length} characters; Fabric allows at most ${MAX_DESCRIPTION_LENGTH}.`,
    );
  }
  return description;
}

/**
 * Saves a description from Fabric in the notebook's `notebook.yaml`, keeping the file's
 * comments and anything else in it. With no description, no file is created, and an
 * existing file gets `description: ""` to match Fabric (so upload has nothing to change).
 */
export async function writeNotebookDescription(files: NotebookFiles, description: string | undefined): Promise<void> {
  if (!description && !(await exists(files.properties))) {
    return;
  }
  await assertSafeWritePath(files.root, files.properties);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(files.properties, '..'));
  await updateYamlFile(files.properties, [[DESCRIPTION, description ?? '']], NEW_PROPERTIES_FILE);
}

/** Thrown when a file at a notebook's path doesn't pass the content check. */
export class NotFabricNotebookError extends Error {
  constructor(
    readonly uri: vscode.Uri,
    kind: NotebookFileKind,
  ) {
    super(
      kind === 'py'
        ? `${uri.path.split('/').pop()} isn't a Fabric notebook (its first line isn't "# Fabric notebook source"). ` +
            'Only the notebook belongs at this path. To share code between notebooks, use %run in Python ' +
            'notebooks or an Environment in PySpark notebooks.'
        : `${uri.path.split('/').pop()} isn't a Fabric notebook (a Jupyter notebook with Fabric's "microsoft" metadata).`,
    );
    this.name = 'NotFabricNotebookError';
  }
}

/** Whether `text` passes the content check for that kind of notebook file. */
export function isNotebookContent(kind: NotebookFileKind, text: string): boolean {
  return kind === 'py' ? isFabricPy(text) : isFabricIpynb(text);
}

/**
 * After one file is saved, rewrites the other from it. Saving the `.ipynb` regenerates the
 * `.py`; saving the `.py` updates the `.ipynb`, keeping outputs of unchanged cells.
 *
 * Both files must pass the content check: a saved file that isn't a notebook isn't synced,
 * and an existing file that isn't one is never overwritten (`NotFabricNotebookError`).
 */
export async function syncNotebookFiles(
  files: NotebookFiles,
  saved: NotebookFileKind,
  options: EnsureLocalStateDirOptions = {},
): Promise<boolean> {
  const [source, target, targetKind] =
    saved === 'py' ? [files.py, files.ipynb, 'ipynb' as const] : [files.ipynb, files.py, 'py' as const];
  const text = await readText(source);
  if (!isNotebookContent(saved, text)) {
    throw new NotFabricNotebookError(source, saved);
  }
  const existing = await readTextIfExists(target);
  if (existing !== undefined && !isNotebookContent(targetKind, existing)) {
    throw new NotFabricNotebookError(target, targetKind);
  }
  const next =
    saved === 'ipynb'
      ? formatFabricPy(withKeyOrderOf(ipynbToFabric(text), existing === undefined ? undefined : parseFabricPy(existing)))
      : fabricToIpynb(parseFabricPy(text), existing);
  // Unchanged content isn't rewritten, so open editors don't reload and watchers don't fire.
  if (next === existing) {
    return false;
  }
  if (saved === 'py') {
    await ensureLocalStateDir(files.localDir, options);
  }
  await writeText(files.root, target, next);
  return true;
}

/**
 * Makes the `.ipynb` current with the `.py`, which is the source of truth: regenerates it
 * when the `.py` is newer (e.g. after a `git pull` while VS Code was closed), or creates it
 * when missing (e.g. a fresh clone). Returns whether the `.ipynb` was written.
 */
export async function refreshIpynbIfStale(files: NotebookFiles, options: EnsureLocalStateDirOptions = {}): Promise<boolean> {
  let py: vscode.FileStat;
  try {
    py = await vscode.workspace.fs.stat(files.py);
  } catch {
    return false; // No .py: nothing to refresh from.
  }
  try {
    if ((await vscode.workspace.fs.stat(files.ipynb)).mtime >= py.mtime) {
      return false;
    }
  } catch {
    // No .ipynb yet: create it.
  }
  return syncNotebookFiles(files, 'py', options);
}

/** Files this extension wrote recently, so its file watcher can ignore its own writes. */
const recentWrites = new Map<string, number>();
const OWN_WRITE_WINDOW_MS = 3000;

/** Whether `uri` was written by this extension in the last few seconds. */
export function wasWrittenByExtension(uri: vscode.Uri): boolean {
  const at = recentWrites.get(uri.toString());
  return at !== undefined && Date.now() - at < OWN_WRITE_WINDOW_MS;
}

export async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

export async function readTextIfExists(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return await readText(uri);
  } catch (err) {
    if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
      return undefined;
    }
    throw err;
  }
}

/** Replaces a notebook's `.py` and regenerates its `.ipynb` from it (keeping outputs). */
export async function writeNotebookPy(files: NotebookFiles, pyText: string): Promise<void> {
  await writeText(files.root, files.py, pyText);
  await syncNotebookFiles(files, 'py');
}

/** Writes a file inside `root`, refusing paths through symbolic links (see `assertSafeWritePath`). */
async function writeText(root: vscode.Uri, uri: vscode.Uri, text: string): Promise<void> {
  await assertSafeWritePath(root, uri);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  recentWrites.set(uri.toString(), Date.now());
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}
