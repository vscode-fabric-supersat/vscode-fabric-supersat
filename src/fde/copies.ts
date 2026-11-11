/**
 * Fabric Data Engineering's (FDE's) copies of this project's notebooks, in its work folder
 * `.fabric-supersat/fabric-de` (layout in `layout.ts`).
 *
 * While "Use Fabric Data Engineering" is on (FDE's work folder setting is this project's
 * folder), a notebook's copy for the selected workspace is the notebook's `.ipynb`: it's the
 * `IpynbLocator` for `src/notebooks/files.ts`. So saving the copy updates the `.py`, the
 * `.py` updates the copy, and commands open, download into and upload from it. Notebooks
 * without a copy (e.g. not uploaded yet) keep `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`.
 *
 * Copies are found by reading the work folder, never by asking Fabric, and are matched to the
 * selected workspace by its ID if it was looked up this session, else by the name in each
 * workspace folder's `.workspace-info`. A copy's notebook is the `src/Notebooks` folder with
 * its name (ignoring case, as Fabric names match).
 *
 * After a download, upload or comparison records a notebook as the same as Fabric's, its
 * copy is brought up to date and its content hash recorded (so FDE shows it as unmodified);
 * a new notebook in Fabric gets a copy. A notebook deleted from (or not found in) Fabric
 * loses its copy, whose `.ipynb` goes back to `.fabric-supersat/Notebooks` if it's newer.
 */

import * as vscode from 'vscode';
import {
  ipynbLocationsChanged,
  type IpynbLocator,
  NOTEBOOKS_DIR,
  notebookFiles,
  readTextIfExists,
  refreshIpynbIfStale,
  setIpynbLocator,
  SOURCE_DIR,
  syncNotebookFiles,
} from '../notebooks/files';
import { assertSafeWritePath, exists, localStateDir, projectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { findByName } from '../util/names';
import { hashText, onDidRecordSync, type SyncRecorded } from '../workspace/state';
import type { WorkspaceService } from '../workspace/service';
import {
  artifactInfoFile,
  FDE_WORK_FOLDER_SETTING,
  type FdeNotebook,
  type FdeWorkspace,
  INFO_FILES,
  notebookFiles as fdeNotebookFiles,
  notebookIpynbPath,
  notebookItemFolder,
  notebooksFolder,
  readArtifactInfo,
  readWorkspaceInfo,
  resourceInfoFile,
  workspaceInfoFile,
} from './layout';
import { fdeFolder, readWorkFolderSetting, writeFdeFiles } from './workFolder';

/** A workspace folder in the work folder. */
export interface FdeWorkspaceFolder {
  /** The folder name: the workspace ID, lowercase. */
  readonly id: string;
  /** From `.workspace-info`. */
  readonly name?: string;
  readonly capacityId?: string;
  readonly personal: boolean;
}

/** A notebook copy in the work folder, of a notebook in `src/Notebooks`. */
export interface FdeCopy {
  readonly ipynb: vscode.Uri;
  /** `<workspace ID>/SynapseNotebook/<item ID>`: everything of this copy. */
  readonly itemFolder: vscode.Uri;
  readonly workspace: FdeWorkspaceFolder;
  readonly itemId: string;
  /** Fabric's name for it, as its folder and file are named. */
  readonly displayName: string;
  readonly capacityId?: string;
  /** The local notebook it's a copy of (its `src/Notebooks` folder name). */
  readonly localName: string;
}

export interface FdeCopiesOptions {
  /** The project folder; defaults to `projectRoot()`. */
  root?: () => vscode.Uri | undefined;
  /** The selected workspace. */
  workspace: Pick<WorkspaceService, 'selected' | 'selectedId' | 'onDidChange'>;
  /** Whether "Use Fabric Data Engineering" is on for this project; defaults to FDE's work folder setting being its folder. */
  isEnabled?: (root: vscode.Uri) => boolean;
}

/** Whether FDE's work folder setting is this project's FDE folder (desktop: a `file:` folder). */
export function usesFdeFolder(root: vscode.Uri): boolean {
  const setting = readWorkFolderSetting();
  return root.scheme === 'file' && !!setting && vscode.Uri.file(setting).toString() === fdeFolder(localStateDir(root)).toString();
}

const REBUILD_DELAY_MS = 300;

/** The index of FDE copies, and the `.ipynb` locator built on it (see the file comment). */
export class FdeCopies implements IpynbLocator, vscode.Disposable {
  private readonly root: () => vscode.Uri | undefined;
  private readonly workspace: FdeCopiesOptions['workspace'];
  private readonly isEnabled: (root: vscode.Uri) => boolean;
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private copies: FdeCopy[] = [];
  private workspaces: FdeWorkspaceFolder[] = [];
  /** The project folder the index is for. */
  private indexed: string | undefined;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  /** Rebuilds and copy updates run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The first index, so tests (and anything else) can wait for it. */
  readonly ready: Promise<void>;

  constructor(options: FdeCopiesOptions) {
    this.root = options.root ?? projectRoot;
    this.workspace = options.workspace;
    this.isEnabled = options.isEnabled ?? usesFdeFolder;
    this.disposables.push(
      setIpynbLocator(this),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(FDE_WORK_FOLDER_SETTING)) {
          ipynbLocationsChanged();
        }
      }),
      this.workspace.onDidChange(() => ipynbLocationsChanged()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.watch();
        this.scheduleRebuild();
      }),
      onDidRecordSync((e) => void this.follow(e)),
      { dispose: () => this.watchers.forEach((w) => w.dispose()) },
      { dispose: () => clearTimeout(this.rebuildTimer) },
    );
    this.watch();
    this.ready = this.rebuild();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** Whether "Use Fabric Data Engineering" is on for `root`. */
  enabled(root: vscode.Uri): boolean {
    return this.isEnabled(root);
  }

  // IpynbLocator

  ipynbFor(root: vscode.Uri, name: string): vscode.Uri | undefined {
    if (!this.isIndexed(root) || !this.isEnabled(root)) {
      return undefined;
    }
    const matches = this.forSelectedWorkspace().filter((c) => c.localName === name);
    return matches.length === 1 ? matches[0].ipynb : undefined;
  }

  nameFor(root: vscode.Uri, uri: vscode.Uri): string | undefined {
    const key = uri.toString();
    return this.isIndexed(root) ? this.copies.find((c) => c.ipynb.toString() === key)?.localName : undefined;
  }

  foldersFor(root: vscode.Uri, name: string): vscode.Uri[] {
    return this.isIndexed(root) ? this.copies.filter((c) => c.localName === name).map((c) => c.itemFolder) : [];
  }

  // The index

  /** Every copy of a notebook in the project (any workspace). */
  all(root: vscode.Uri): readonly FdeCopy[] {
    return this.isIndexed(root) ? this.copies : [];
  }

  /** The copies in the selected workspace's folder (by its ID if known, else by name). */
  forSelectedWorkspace(): FdeCopy[] {
    const selected = this.workspace.selected;
    if (!selected) {
      return [];
    }
    const id = this.workspace.selectedId?.toLowerCase();
    const name = selected.name.toLowerCase();
    return this.copies.filter((c) => (id ? c.workspace.id === id : c.workspace.name?.toLowerCase() === name));
  }

  private isIndexed(root: vscode.Uri): boolean {
    return this.indexed === root.toString();
  }

  /** Reads the work folder again (debounced), e.g. after files there were created or deleted. */
  scheduleRebuild(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => void this.rebuild(), REBUILD_DELAY_MS);
  }

  /** Reads the work folder and the project's notebooks; says so if which `.ipynb` notebooks use may have changed. */
  rebuild(): Promise<void> {
    return this.enqueue(async () => {
      const root = this.root();
      const before = this.signature();
      if (!root) {
        [this.copies, this.workspaces, this.indexed] = [[], [], undefined];
      } else {
        try {
          const { copies, workspaces } = await scan(root);
          [this.copies, this.workspaces, this.indexed] = [copies, workspaces, root.toString()];
        } catch (err) {
          getLogger().warn('Couldn\'t read Fabric Data Engineering\'s work folder', err);
          [this.copies, this.workspaces, this.indexed] = [[], [], root.toString()];
        }
      }
      if (this.signature() !== before) {
        ipynbLocationsChanged();
      }
    });
  }

  private signature(): string {
    return JSON.stringify([this.indexed, this.copies.map((c) => [c.ipynb.toString(), c.localName, c.workspace.name])]);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(task);
    this.queue = run;
    return run;
  }

  /** Watches for copies and notebooks created or deleted, to keep the index current. */
  private watch(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
    const root = this.root();
    if (!root) {
      return;
    }
    for (const pattern of [
      new vscode.RelativePattern(fdeFolder(localStateDir(root)), '**'),
      new vscode.RelativePattern(root, `${SOURCE_DIR}/${NOTEBOOKS_DIR}/*/*.py`),
    ]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, false);
      this.watchers.push(watcher, watcher.onDidCreate(() => this.scheduleRebuild()), watcher.onDidDelete(() => this.scheduleRebuild()));
    }
  }

  // Keeping copies current

  /**
   * Makes sure a notebook has a copy for `notebook` (its item in `workspace`), up to date with
   * its `.py`, and records whether it's the same as Fabric's (FDE shows it as modified if not).
   * A new copy starts from the notebook's other copy in that workspace (an earlier item of the
   * same name) or its `localIpynb`, so outputs carry over. Other copies of it in that
   * workspace (earlier items) are removed. Returns the copy's `.ipynb`, or `undefined` if the
   * notebook has no local files to copy.
   */
  async ensureCopy(
    root: vscode.Uri,
    workspace: FdeWorkspace,
    notebook: FdeNotebook,
    localName: string,
    sameAsFabric: boolean,
  ): Promise<vscode.Uri | undefined> {
    const folder = fdeFolder(localStateDir(root));
    const uri = vscode.Uri.joinPath(folder, ...notebookIpynbPath(notebook));
    const wsId = workspace.id.toLowerCase();
    const itemId = notebook.itemId.toLowerCase();
    const others = this.copies.filter((c) => c.workspace.id === wsId && c.localName === localName && c.itemId !== itemId);
    if (await exists(uri)) {
      await writeFdeFiles(root, folder, [workspaceInfoFile(workspace)]);
    } else {
      const seed = (others.length ? await readTextIfExists(others[0].ipynb) : undefined) ?? (await localIpynbText(root, localName));
      if (seed === undefined) {
        return undefined;
      }
      await writeFdeFiles(root, folder, fdeNotebookFiles(workspace, notebook, seed, { lastUpdatedDate: new Date().toISOString() }));
    }
    for (const other of others) {
      await removeCopy(root, other, { keepOutputs: false });
    }
    await refreshCopy(root, folder, notebook, uri, localName, sameAsFabric);
    return uri;
  }

  /**
   * After a notebook is recorded as synced with a workspace, or forgotten there (see
   * `onDidRecordSync`): updates, creates or removes its copy in that workspace's folder.
   * Only while "Use Fabric Data Engineering" is on for the project. Failures are only logged:
   * the command that recorded it has done its work.
   */
  private follow(e: SyncRecorded): Promise<void> {
    return this.enqueue(async () => {
      const root = this.root();
      if (e.kind !== 'notebook' || !root || e.root.toString() !== root.toString() || !this.isIndexed(root) || !this.isEnabled(root)) {
        return;
      }
      try {
        const changed = await this.followNow(root, e);
        if (changed) {
          // Read again at once (not debounced), so commands right after see the new copies.
          const { copies, workspaces } = await scan(root);
          [this.copies, this.workspaces] = [copies, workspaces];
          ipynbLocationsChanged();
        }
      } catch (err) {
        getLogger().warn(`Couldn't update the Fabric Data Engineering copy of "${e.name}"`, err);
      }
    });
  }

  /** Returns whether copies were created or removed. */
  private async followNow(root: vscode.Uri, e: SyncRecorded): Promise<boolean> {
    const wsName = e.workspaceName.toLowerCase();
    const notebookName = e.name.toLowerCase();
    const inWorkspace = this.copies.filter((c) => c.workspace.name?.toLowerCase() === wsName && c.localName.toLowerCase() === notebookName);
    if (!e.synced) {
      for (const copy of inWorkspace) {
        await removeCopy(root, copy, { keepOutputs: true });
        getLogger().info(`Removed the Fabric Data Engineering copy of "${copy.localName}": it's no longer in ${e.workspaceName}`);
      }
      return inWorkspace.length > 0;
    }
    const itemId = e.itemId?.toLowerCase();
    const current = itemId ? inWorkspace.filter((c) => c.itemId === itemId) : inWorkspace;
    if (current.length) {
      const folder = fdeFolder(localStateDir(root));
      for (const copy of current) {
        const capacityId = copy.capacityId ?? copy.workspace.capacityId;
        if (capacityId) {
          const notebook = { workspaceId: copy.workspace.id, capacityId, itemId: copy.itemId, displayName: copy.displayName };
          await refreshCopy(root, folder, notebook, copy.ipynb, copy.localName, true);
        }
      }
      return false;
    }
    // A notebook new in Fabric (or re-created there): give it a copy, in its workspace's folder if there is just one.
    const workspaces = this.workspaces.filter((w) => w.name?.toLowerCase() === wsName && w.capacityId);
    const localName = inWorkspace[0]?.localName ?? (await localNotebookName(root, e.name));
    if (!itemId || workspaces.length !== 1 || localName === undefined) {
      return false;
    }
    const [w] = workspaces;
    const capacityId = w.capacityId!;
    const created = await this.ensureCopy(
      root,
      { id: w.id, name: w.name ?? e.workspaceName, capacityId, personal: w.personal },
      { workspaceId: w.id, capacityId, itemId, displayName: localName },
      localName,
      true,
    );
    if (created) {
      getLogger().info(`Copied "${localName}" to Fabric Data Engineering's work folder (item ${itemId}), the same as in ${e.workspaceName}`);
    }
    return created !== undefined;
  }

  /**
   * Copies each copy in the selected workspace's folder back to its notebook's `localIpynb`
   * where the copy is newer, so outputs follow the notebook when "Use Fabric Data
   * Engineering" is turned off. Copies are kept. Returns how many were copied back.
   */
  async copyBack(root: vscode.Uri): Promise<number> {
    let count = 0;
    for (const copy of this.isIndexed(root) ? this.forSelectedWorkspace() : []) {
      if (await copyToLocalIpynb(root, copy)) {
        count++;
      }
    }
    return count;
  }
}

/** Reads the work folder: its workspace folders, and the copies of notebooks that are in `src/Notebooks`. */
async function scan(root: vscode.Uri): Promise<{ copies: FdeCopy[]; workspaces: FdeWorkspaceFolder[] }> {
  const folder = fdeFolder(localStateDir(root));
  const copies: FdeCopy[] = [];
  const workspaces: FdeWorkspaceFolder[] = [];
  const locals = (await subfolders(vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOKS_DIR))).map((displayName) => ({ displayName }));
  for (const id of await subfolders(folder)) {
    const wsInfo = readWorkspaceInfo((await readTextIfExists(vscode.Uri.joinPath(folder, id, INFO_FILES.workspace))) ?? '');
    const workspace: FdeWorkspaceFolder = { id: id.toLowerCase(), name: wsInfo?.name, capacityId: wsInfo?.capacityId, personal: !!wsInfo?.personal };
    workspaces.push(workspace);
    for (const itemId of await subfolders(vscode.Uri.joinPath(folder, ...notebooksFolder(id)))) {
      const itemFolder = vscode.Uri.joinPath(folder, ...notebookItemFolder({ workspaceId: id, itemId }));
      const info = readArtifactInfo((await readTextIfExists(vscode.Uri.joinPath(itemFolder, INFO_FILES.artifact))) ?? '');
      for (const displayName of await subfolders(itemFolder)) {
        const ipynb = vscode.Uri.joinPath(itemFolder, displayName, `${displayName}.ipynb`);
        const local = findByName(locals, displayName);
        if (local && (await exists(ipynb))) {
          copies.push({ ipynb, itemFolder, workspace, itemId: itemId.toLowerCase(), displayName, capacityId: info?.capacityId, localName: local.displayName });
        }
      }
    }
  }
  return { copies, workspaces };
}

/** A folder's subfolders (not symbolic links, not hidden), or none if it doesn't exist. */
async function subfolders(dir: vscode.Uri): Promise<string[]> {
  try {
    return (await vscode.workspace.fs.readDirectory(dir))
      .filter(([name, type]) => type === vscode.FileType.Directory && !name.startsWith('.'))
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The `src/Notebooks` folder name matching `name` (ignoring case), if it has a `.py`. */
async function localNotebookName(root: vscode.Uri, name: string): Promise<string | undefined> {
  const found = findByName((await subfolders(vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOKS_DIR))).map((displayName) => ({ displayName })), name);
  return found && (await exists(notebookFiles(root, found.displayName).py)) ? found.displayName : undefined;
}

/** A notebook's `localIpynb` text, brought up to date with its `.py` first (created if missing). */
async function localIpynbText(root: vscode.Uri, name: string): Promise<string | undefined> {
  const local = notebookFiles(root, name);
  const files = notebookFiles(root, name, local.localIpynb);
  if (!isDirty(files.localIpynb)) {
    await refreshIpynbIfStale(files);
  }
  return readTextIfExists(files.localIpynb);
}

/**
 * Brings a copy up to date with its notebook's `.py` (keeping outputs of unchanged cells) and
 * records it in `.artifact-info`: its content hash if `sameAsFabric` (FDE then shows it as
 * unmodified), else a value that makes FDE show it as modified.
 */
async function refreshCopy(
  root: vscode.Uri,
  folder: vscode.Uri,
  notebook: FdeNotebook,
  ipynb: vscode.Uri,
  localName: string,
  sameAsFabric: boolean,
): Promise<void> {
  const files = notebookFiles(root, localName, ipynb);
  if (isDirty(ipynb)) {
    getLogger().info(`The Fabric Data Engineering copy of "${localName}" has unsaved changes, so it wasn't updated from its .py`);
  } else if (await exists(files.py)) {
    await syncNotebookFiles(files, 'py');
  }
  const text = await readTextIfExists(ipynb);
  const contentHash = sameAsFabric && text !== undefined && !isDirty(ipynb) ? await hashText(text) : undefined;
  await writeFdeFiles(root, folder, [
    artifactInfoFile(notebook, { lastUpdatedDate: new Date().toISOString(), ...(contentHash ? { contentHash } : {}) }),
    resourceInfoFile(notebook),
  ]);
}

/**
 * Deletes a copy's item folder (to the trash where possible). With `keepOutputs`, its
 * `.ipynb` is first copied to the notebook's `localIpynb` if newer. A copy with unsaved
 * changes is left alone.
 */
async function removeCopy(root: vscode.Uri, copy: FdeCopy, { keepOutputs }: { keepOutputs: boolean }): Promise<void> {
  if (isDirty(copy.ipynb)) {
    getLogger().info(`The Fabric Data Engineering copy of "${copy.localName}" has unsaved changes, so it wasn't removed`);
    return;
  }
  if (keepOutputs) {
    await copyToLocalIpynb(root, copy);
  }
  await assertSafeWritePath(root, copy.itemFolder);
  try {
    await vscode.workspace.fs.delete(copy.itemFolder, { recursive: true, useTrash: true });
  } catch {
    if (await exists(copy.itemFolder)) {
      await vscode.workspace.fs.delete(copy.itemFolder, { recursive: true, useTrash: false });
    }
  }
}

/** Copies a copy's `.ipynb` to its notebook's `localIpynb` if that is missing or older. Returns whether it did. */
async function copyToLocalIpynb(root: vscode.Uri, copy: FdeCopy): Promise<boolean> {
  const target = notebookFiles(root, copy.localName).localIpynb;
  const [from, to] = await Promise.all([mtime(copy.ipynb), mtime(target)]);
  if (from === undefined || (to !== undefined && to >= from) || isDirty(target)) {
    return false;
  }
  await assertSafeWritePath(root, target);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
  await vscode.workspace.fs.writeFile(target, await vscode.workspace.fs.readFile(copy.ipynb));
  return true;
}

async function mtime(uri: vscode.Uri): Promise<number | undefined> {
  try {
    return (await vscode.workspace.fs.stat(uri)).mtime;
  } catch {
    return undefined;
  }
}

/** Whether a file is open with unsaved changes (as a notebook or as text). */
function isDirty(uri: vscode.Uri): boolean {
  const key = uri.toString();
  return (
    vscode.workspace.notebookDocuments.some((d) => d.isDirty && d.uri.toString() === key) ||
    vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString() === key)
  );
}
