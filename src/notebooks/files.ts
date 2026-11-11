/**
 * Where a notebook lives locally. Each notebook is identified by its name (no Fabric ID
 * is stored), and has two files that are kept in sync:
 *
 * - `src/Notebooks/<Name>/<Name>.py`: Fabric's Git format, for source control.
 *   This is what gets uploaded.
 * - `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`: Jupyter, with outputs.
 *   Local to you (git ignores `.fabric-supersat`). While "Use Fabric Data Engineering" is on,
 *   a notebook with a copy in its work folder for the selected workspace uses that copy as
 *   its `.ipynb` instead (see `IpynbLocator`, set by `src/fde/copies.ts`).
 *
 * Optionally, `src/Notebooks/<Name>/<Name>.yaml` holds the notebook's properties
 * (its description and workspace folder), for source control next to the `.py`.
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
import { DEFAULT_PYTHON_VERSION } from '../util/config';
import { folderNameProblem } from '../util/folderNames';
import { lineEndingOf, toLf, withLineEnding } from '../util/text';
import { parseYamlText, readYamlFile, updatedYamlText, YamlFileError } from '../util/yamlFile';
import {
  describeCellTypes,
  type FabricNotebook,
  fabricToIpynb,
  formatFabricPy,
  ipynbToFabric,
  isFabricIpynb,
  isFabricPy,
  parseFabricPy,
  unknownCellTypes,
  withKeyOrderOf,
} from './format';
import { ActionNeededError, type WarningError } from '../util/errorFix';
import { formatFolderPath, parseFolderPath } from './folders';

export const NOTEBOOKS_DIR = 'Notebooks';
export const SOURCE_DIR = 'src';
/** Fabric's name for the Git-format file in a notebook definition (not the local file name). */
export const FABRIC_PY_PART = 'notebook-content.py';
/** The notebook's properties file is `<Name>.yaml`, next to its `.py`. Optional. */
export const PROPERTIES_EXTENSION = '.yaml';
/** Fabric's limit for item descriptions. */
export const MAX_DESCRIPTION_LENGTH = 256;
const DESCRIPTION = ['description'] as const;
const FOLDER = ['folder'] as const;

/** Contents of a new `<Name>.yaml`; the placeholder keeps the comment next to its value. */
export const NEW_PROPERTIES_FILE = `# Fabric notebook properties. The notebook's name is its folder name.
# Each is optional: without it, upload leaves that property as it is in Fabric.
# folder: "Bronze/Ingest" puts the notebook in that workspace folder (created if
# missing); folder: "" puts it in the workspace root.
# Upload sets the notebook's description in Fabric to this; description: "" clears it.
description: ""
`;

export interface NotebookFiles {
  /** The notebook's name in Fabric, which is also its folder name. */
  readonly name: string;
  /** The project folder; both files are always written inside it. */
  readonly root: vscode.Uri;
  readonly py: vscode.Uri;
  /**
   * The notebook's `.ipynb`, kept in sync with the `.py`: `localIpynb`, or a Fabric Data
   * Engineering copy while that is on (see `IpynbLocator`).
   */
  readonly ipynb: vscode.Uri;
  /** `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`, the `.ipynb` when there is no Fabric Data Engineering copy to use. */
  readonly localIpynb: vscode.Uri;
  /** `<Name>.yaml` next to the `.py`; may not exist. */
  readonly properties: vscode.Uri;
  /** The project's `.fabric-supersat` folder. */
  readonly localDir: vscode.Uri;
}

export type NotebookFileKind = 'py' | 'ipynb';

/**
 * Other places a notebook's `.ipynb` can be: Fabric Data Engineering's copies (see
 * `src/fde/copies.ts`, which sets it). Kept behind this interface so notebook code doesn't
 * depend on Fabric Data Engineering.
 */
export interface IpynbLocator {
  /** The `.ipynb` to use for a notebook in place of its `localIpynb`, if any. Synchronous: from what's already known. */
  ipynbFor(root: vscode.Uri, name: string): vscode.Uri | undefined;
  /** If `uri` is another `.ipynb` of a notebook in `root` (whether or not it's used now), that notebook's name. */
  nameFor(root: vscode.Uri, uri: vscode.Uri): string | undefined;
  /** Folders holding other `.ipynb` files of a notebook, deleted with its local files. */
  foldersFor(root: vscode.Uri, name: string): vscode.Uri[];
}

let locator: IpynbLocator | undefined;
const locationsChanged = new vscode.EventEmitter<void>();

/** Fires when which `.ipynb` a notebook uses may have changed (so stale ones are refreshed). */
export const onDidChangeIpynbLocations = locationsChanged.event;

/** Sets where else notebooks' `.ipynb` files can be; disposing it removes it again. */
export function setIpynbLocator(value: IpynbLocator): vscode.Disposable {
  locator = value;
  locationsChanged.fire();
  return {
    dispose: () => {
      if (locator === value) {
        locator = undefined;
        locationsChanged.fire();
      }
    },
  };
}

/** Says that which `.ipynb` notebooks use may have changed (see `onDidChangeIpynbLocations`). */
export function ipynbLocationsChanged(): void {
  locationsChanged.fire();
}

/**
 * A notebook's files, by name. Its `.ipynb` is `ipynb` if given, else the one in use now:
 * a Fabric Data Engineering copy while that is on (see `IpynbLocator`), else its `localIpynb`.
 */
export function notebookFiles(root: vscode.Uri, name: string, ipynb?: vscode.Uri): NotebookFiles {
  const localDir = localStateDir(root);
  const localIpynb = vscode.Uri.joinPath(localDir, NOTEBOOKS_DIR, name, `${name}.ipynb`);
  return {
    name,
    root,
    py: vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOKS_DIR, name, `${name}.py`),
    properties: vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOKS_DIR, name, `${name}${PROPERTIES_EXTENSION}`),
    ipynb: ipynb ?? locator?.ipynbFor(root, name) ?? localIpynb,
    localIpynb,
    localDir,
  };
}

/**
 * If `uri` is one of a notebook's files in `root`, that notebook and which file it is. For
 * an `.ipynb`, the files returned have that `.ipynb` (so a save syncs from the file saved),
 * whether it's the `localIpynb` or a Fabric Data Engineering copy.
 */
export function notebookFilesFor(
  root: vscode.Uri,
  uri: vscode.Uri,
): { files: NotebookFiles; kind: NotebookFileKind } | undefined {
  const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`;
  if (uri.scheme !== root.scheme || uri.authority !== root.authority || !uri.path.startsWith(prefix)) {
    return undefined;
  }
  const [top, notebooks, name, file, ...rest] = uri.path.slice(prefix.length).split('/');
  if (!rest.length && notebooks === NOTEBOOKS_DIR && name) {
    // `Uri.path` is already decoded, so `name` is the notebook name as-is.
    if (top === SOURCE_DIR && file === `${name}.py`) {
      return { files: notebookFiles(root, name), kind: 'py' };
    }
    if (top === LOCAL_DIR_NAME && file === `${name}.ipynb`) {
      return { files: notebookFiles(root, name, uri), kind: 'ipynb' };
    }
  }
  const other = uri.path.endsWith('.ipynb') ? locator?.nameFor(root, uri) : undefined;
  return other === undefined ? undefined : { files: notebookFiles(root, other, uri), kind: 'ipynb' };
}

/**
 * Throws if a notebook name can't be used as a folder name on every OS (see
 * `folderNameProblem`, the rules for every folder named after something in Fabric). Names
 * are never changed to fit, since the folder name is how the notebook is found again on upload.
 */
export function checkNotebookName(name: string): void {
  const problem = folderNameProblem(name);
  if (problem) {
    throw new ActionNeededError(`The notebook name "${name}" ${problem}, so it can't be saved as a folder. Rename it in Fabric.`);
  }
}

/** The notebook types that use Fabric's `.py` Git format, so can be created and uploaded. */
export type NewNotebookType = 'pyspark' | 'python';

/**
 * What a new notebook starts with: one empty Python cell. The kernel and language group are
 * the ones Fabric writes for each type (PySpark: Fabric's docs and samples; Python: a
 * notebook downloaded from Fabric in 2026-11, see the test fixtures). A Python notebook's
 * kernel names its Python version (`python3.12`); a PySpark notebook's comes from its Spark
 * runtime, so `pythonVersion` only applies to Python notebooks.
 */
export function newNotebook(type: NewNotebookType, pythonVersion = DEFAULT_PYTHON_VERSION): FabricNotebook {
  return type === 'python'
    ? {
        meta: { kernel_info: { name: 'jupyter', jupyter_kernel_name: `python${pythonVersion}` }, dependencies: {} },
        cells: [{ kind: 'code', source: '', meta: { language: 'python', language_group: 'jupyter_python' } }],
      }
    : {
        meta: { kernel_info: { name: 'synapse_pyspark' }, dependencies: {} },
        cells: [{ kind: 'code', source: '', meta: { language: 'python', language_group: 'synapse_pyspark' } }],
      };
}

/**
 * Creates a new notebook's files (`.py` and `.ipynb`) of the given type (and, for a Python
 * notebook, Python version, e.g. `3.12`). Throws if the name can't be a folder name, or if
 * either file already exists.
 */
export async function createNotebookFiles(
  files: NotebookFiles,
  type: NewNotebookType = 'pyspark',
  pythonVersion?: string,
): Promise<void> {
  checkNotebookName(files.name);
  for (const uri of [files.py, files.ipynb]) {
    if (await exists(uri)) {
      throw new ActionNeededError(`Notebook "${files.name}" already exists: ${uri.path.split('/').slice(-3).join('/')}`);
    }
  }
  const notebook = newNotebook(type, pythonVersion);
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

/** Whether any of a notebook's files exists locally. */
export async function hasLocalCopy(files: NotebookFiles): Promise<boolean> {
  return (await exists(files.py)) || (await exists(files.ipynb)) || (await exists(files.localIpynb));
}

/** Writes both files of a downloaded notebook. */
export async function writeNotebookFiles(files: NotebookFiles, pyText: string, ipynbText: string): Promise<void> {
  await ensureLocalStateDir(files.localDir);
  await writeText(files.root, files.py, pyText);
  await writeText(files.root, files.ipynb, ipynbText);
}

/**
 * The description in the notebook's `<Name>.yaml`: `undefined` when there is no file or
 * no `description` in it (so Fabric's is left alone), `''` to clear it. Throws
 * `YamlFileError` if the file is invalid or the description is too long for Fabric.
 */
export async function readNotebookDescription(files: ItemPropertiesFile): Promise<string | undefined> {
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
 * The workspace folder in the notebook's `<Name>.yaml`, as a path such as `Bronze/Ingest`:
 * `undefined` when there is no file or no `folder` in it (so the notebook stays where it is
 * in Fabric), `''` for the workspace root. Throws `YamlFileError` if the file is invalid or the
 * path can't be a Fabric folder.
 */
export async function readNotebookFolder(files: ItemPropertiesFile): Promise<string | undefined> {
  const file = await readYamlFile(files.properties);
  const value: unknown = file?.document.getIn(FOLDER);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new YamlFileError(files.properties, '"folder" should be text such as "Bronze/Ingest", not a list or map.');
  }
  try {
    return formatFolderPath(parseFolderPath(String(value)));
  } catch (err) {
    throw new YamlFileError(files.properties, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Saves a description from Fabric in the notebook's `<Name>.yaml`, keeping the file's
 * comments and anything else in it. With no description, no file is created, and an
 * existing file gets `description: ""` to match Fabric (so upload has nothing to change).
 */
export async function writeNotebookDescription(files: NotebookFiles, description: string | undefined): Promise<void> {
  await writeNotebookProperties(files, { description });
}

/**
 * Saves a notebook's properties from Fabric in its `<Name>.yaml`, keeping the file's comments
 * and anything else in it: its description (as `writeNotebookDescription`), and its folder
 * path (`''` for the workspace root). A folder is written only when the notebook is in one, or
 * the file already has a `folder` (so notebooks in the root don't gain one); `undefined` (not
 * known) leaves it as it is.
 */
export async function writeNotebookProperties(
  files: NotebookFiles,
  properties: { description: string | undefined; folder?: string },
): Promise<void> {
  await writePropertiesFile(files.root, files.properties, properties, NEW_PROPERTIES_FILE);
}

/**
 * Saves an item's properties from Fabric in its `<Name>.yaml` (`uri`), as
 * `writeNotebookProperties` does for a notebook; a new file starts from `template`.
 */
export async function writePropertiesFile(
  root: vscode.Uri,
  uri: vscode.Uri,
  properties: { description: string | undefined; folder?: string },
  template: string,
): Promise<void> {
  const existing = await readTextIfExists(uri);
  const text = propertiesText(uri, existing, properties, template);
  if (text === undefined || text === existing) {
    return;
  }
  await assertSafeWritePath(root, uri);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

/**
 * What `writeNotebookProperties` makes of a `<Name>.yaml` whose text is `existing`
 * (`undefined`: no file): the new text, or `undefined` if no file would be written. Used for
 * writing, and for showing Fabric's properties as downloading would write them. Throws
 * `YamlFileError` if `existing` isn't valid YAML.
 */
export function notebookPropertiesText(
  uri: vscode.Uri,
  existing: string | undefined,
  properties: { description: string | undefined; folder?: string },
): string | undefined {
  return propertiesText(uri, existing, properties, NEW_PROPERTIES_FILE);
}

/** `notebookPropertiesText` for any item's `<Name>.yaml`: a new file starts from `template`. */
export function propertiesText(
  uri: vscode.Uri,
  existing: string | undefined,
  { description, folder }: { description: string | undefined; folder?: string },
  template: string,
): string | undefined {
  const file = existing === undefined ? undefined : parseYamlText(uri, existing);
  const values: [typeof DESCRIPTION | typeof FOLDER, string][] = [];
  if (description || file) {
    values.push([DESCRIPTION, description ?? '']);
  }
  if (folder !== undefined && (folder !== '' || file?.document.hasIn(FOLDER))) {
    values.push([FOLDER, folder]);
  }
  return values.length ? updatedYamlText(uri, existing ?? template, values) : existing;
}

/** Any item's `<Name>.yaml`: the properties readers need only where it is. */
export interface ItemPropertiesFile {
  readonly properties: vscode.Uri;
}

/**
 * An item's description and folder as its `<Name>.yaml` sets them (see `readNotebookDescription`
 * and `readNotebookFolder`, which read any item's file the same way).
 */
export async function readItemProperties(files: ItemPropertiesFile): Promise<{ description?: string; folder?: string }> {
  return readNotebookProperties(files);
}

/** A notebook's description and folder as its `<Name>.yaml` sets them (see `readNotebookDescription` and `readNotebookFolder`). */
export async function readNotebookProperties(files: ItemPropertiesFile): Promise<{ description?: string; folder?: string }> {
  const [description, folder] = await Promise.all([readNotebookDescription(files), readNotebookFolder(files)]);
  return { description, folder };
}

/** Thrown when a file at a notebook's path doesn't pass the content check. */
export class NotFabricNotebookError extends Error implements WarningError {
  readonly warning = true;

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

/**
 * Thrown when a saved file has no cells but the file it would overwrite has some (e.g. a
 * `.py` emptied, or read while half-written): syncing would lose those cells and their outputs.
 */
export class EmptyNotebookError extends Error implements WarningError {
  readonly warning = true;

  constructor(
    readonly source: vscode.Uri,
    readonly target: vscode.Uri,
  ) {
    super(
      `${source.path.split('/').pop()} has no cells, so ${target.path.split('/').pop()} (which has some) wasn't updated from it. ` +
        'Fabric notebooks need at least one cell.',
    );
    this.name = 'EmptyNotebookError';
  }
}

/** Whether `text` passes the content check for that kind of notebook file. */
export function isNotebookContent(kind: NotebookFileKind, text: string): boolean {
  return kind === 'py' ? isFabricPy(text) : isFabricIpynb(text);
}

/** Cells of types Fabric notebooks don't have, removed from a notebook's `.ipynb` when it was rewritten from its `.py`. */
export interface DroppedCells {
  files: NotebookFiles;
  /** How many cells of each type, e.g. `{ raw: 1 }`. */
  cellTypes: Readonly<Record<string, number>>;
}

const droppedListeners = new Set<(dropped: DroppedCells) => void>();

/**
 * Runs `listener` whenever rewriting a notebook's `.ipynb` from its `.py` (the source of
 * truth) removes cells Fabric notebooks don't have, e.g. raw cells. Dispose to stop.
 */
export function onNonFabricCellsDropped(listener: (dropped: DroppedCells) => void): vscode.Disposable {
  droppedListeners.add(listener);
  return { dispose: () => droppedListeners.delete(listener) };
}

/** Tells the listeners if `previousIpynb` (about to be replaced from the `.py`) had cells Fabric notebooks don't have. */
export function reportDroppedCells(files: NotebookFiles, previousIpynb: string | undefined): void {
  if (previousIpynb === undefined || !isFabricIpynb(previousIpynb)) {
    return;
  }
  const cellTypes = unknownCellTypes(previousIpynb);
  if (Object.keys(cellTypes).length) {
    for (const listener of droppedListeners) {
      listener({ files, cellTypes });
    }
  }
}

/** A message for `DroppedCells`, naming the files and why. */
export function droppedCellsMessage({ files, cellTypes }: DroppedCells): string {
  const count = Object.values(cellTypes).reduce((a, b) => a + b, 0);
  return (
    `${files.name}.ipynb had ${describeCellTypes(cellTypes)}, which ${count === 1 ? 'was' : 'were'} removed when it was ` +
    `updated from ${files.name}.py: the .py is the source of truth, and Fabric notebooks only have code and markdown cells.`
  );
}

/** Syncs in progress, by notebook: syncs of one notebook run one at a time. */
const syncing = new Map<string, Promise<unknown>>();

/**
 * After one file is saved, rewrites the other from it. Saving the `.ipynb` regenerates the
 * `.py`; saving the `.py` updates the `.ipynb`, keeping outputs of unchanged cells. The
 * `.py` is the source of truth: cells in the `.ipynb` that Fabric notebooks don't have
 * (e.g. raw cells) stop the `.ipynb` being synced to the `.py` (`NonFabricCellsError`), and
 * are removed when the `.ipynb` is rewritten from the `.py` (see `onNonFabricCellsDropped`).
 *
 * Both files must pass the content check: a saved file that isn't a notebook isn't synced,
 * and an existing file that isn't one is never overwritten (`NotFabricNotebookError`).
 * Syncs of the same notebook (e.g. from a save and a command at once) run one at a time.
 */
export async function syncNotebookFiles(
  files: NotebookFiles,
  saved: NotebookFileKind,
  options: EnsureLocalStateDirOptions = {},
): Promise<boolean> {
  const key = files.py.toString();
  const run = (syncing.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => syncNow(files, saved, options));
  syncing.set(key, run);
  try {
    return await run;
  } finally {
    if (syncing.get(key) === run) {
      syncing.delete(key);
    }
  }
}

async function syncNow(files: NotebookFiles, saved: NotebookFileKind, options: EnsureLocalStateDirOptions): Promise<boolean> {
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
  const notebook = saved === 'ipynb' ? ipynbToFabric(text) : parseFabricPy(text);
  // A notebook with no cells never replaces one with cells.
  if (!notebook.cells.length && existing !== undefined && cellCount(targetKind, existing) > 0) {
    throw new EmptyNotebookError(source, target);
  }
  const next =
    saved === 'ipynb'
      ? formatFabricPy(withKeyOrderOf(notebook, existing === undefined ? undefined : parseFabricPy(existing)))
      : fabricToIpynb(notebook, existing);
  // Unchanged content (line endings aside) isn't rewritten, so open editors don't reload and watchers don't fire.
  if (existing !== undefined && toLf(next) === toLf(existing)) {
    return false;
  }
  if (saved === 'py') {
    await ensureLocalStateDir(files.localDir, options);
  }
  await writeText(files.root, target, next);
  if (saved === 'py') {
    reportDroppedCells(files, existing);
  }
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

/** How many cells a notebook file (that passed the content check) has. */
function cellCount(kind: NotebookFileKind, text: string): number {
  if (kind === 'py') {
    return parseFabricPy(text).cells.length;
  }
  const cells = (JSON.parse(text) as { cells?: unknown }).cells;
  return Array.isArray(cells) ? cells.length : 0;
}

/** Files this extension wrote recently, so its file watcher can ignore its own writes. */
const recentWrites = new Map<string, number>();
const OWN_WRITE_WINDOW_MS = 3000;

/** Whether `uri` was written by this extension in the last few seconds. */
export function wasWrittenByExtension(uri: vscode.Uri): boolean {
  forgetOldWrites();
  return recentWrites.has(uri.toString());
}

/** Forgets writes older than the window, so the map stays small. */
function forgetOldWrites(): void {
  const now = Date.now();
  for (const [key, at] of recentWrites) {
    if (now - at >= OWN_WRITE_WINDOW_MS) {
      recentWrites.delete(key);
    }
  }
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

/** A notebook's two folders: `src/Notebooks/<Name>/` and `.fabric-supersat/Notebooks/<Name>/`. */
export function notebookFolders(files: NotebookFiles): [source: vscode.Uri, local: vscode.Uri] {
  return [vscode.Uri.joinPath(files.py, '..'), vscode.Uri.joinPath(files.localIpynb, '..')];
}

/** The folders of a notebook's Fabric Data Engineering copies (any workspace), deleted with its local files. */
export function copyFolders(files: NotebookFiles): vscode.Uri[] {
  return locator?.foldersFor(files.root, files.name) ?? [];
}

/**
 * Deletes a notebook's local folders (`src/Notebooks/<Name>/`, with everything in it,
 * `.fabric-supersat/Notebooks/<Name>/`, and its Fabric Data Engineering copies), moving them
 * to the trash where the file system supports it. Refuses paths through symbolic links.
 * Returns the folders deleted.
 */
export async function deleteNotebookFiles(files: NotebookFiles): Promise<vscode.Uri[]> {
  checkNotebookName(files.name);
  const deleted: vscode.Uri[] = [];
  for (const folder of [...notebookFolders(files), ...copyFolders(files)]) {
    if (!(await exists(folder))) {
      continue;
    }
    await assertSafeWritePath(files.root, folder);
    try {
      await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: true });
    } catch {
      // No trash here (e.g. a virtual or web file system): delete it outright.
      if (await exists(folder)) {
        await vscode.workspace.fs.delete(folder, { recursive: true, useTrash: false });
      }
    }
    deleted.push(folder);
  }
  return deleted;
}

/** Replaces a notebook's `.py` and regenerates its `.ipynb` from it (keeping outputs). */
export async function writeNotebookPy(files: NotebookFiles, pyText: string): Promise<void> {
  await writeText(files.root, files.py, pyText);
  await syncNotebookFiles(files, 'py');
}

/**
 * Writes a file inside `root`, refusing paths through symbolic links (see `assertSafeWritePath`).
 * An existing file keeps its line endings (CRLF or LF); a new one gets `text`'s.
 */
async function writeText(root: vscode.Uri, uri: vscode.Uri, text: string): Promise<void> {
  await assertSafeWritePath(root, uri);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  const existing = await readTextIfExists(uri);
  const content = existing === undefined ? text : withLineEnding(text, lineEndingOf(existing));
  forgetOldWrites();
  recentWrites.set(uri.toString(), Date.now());
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}
