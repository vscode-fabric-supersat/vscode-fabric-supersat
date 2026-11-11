import * as vscode from 'vscode';
import {
  droppedCellsMessage,
  EmptyNotebookError,
  listLocalNotebooks,
  type NotebookFileKind,
  type NotebookFiles,
  notebookFilesFor,
  NotFabricNotebookError,
  onNonFabricCellsDropped,
  refreshIpynbIfStale,
  syncNotebookFiles,
  wasWrittenByExtension,
} from '../notebooks/files';
import { NonFabricCellsError } from '../notebooks/format';
import { reportError } from '../util/errors';
import { projectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import type { Feature } from './feature';
import { ActionNeededError } from '../util/errorFix';

/**
 * Keeps each notebook's two files in sync, in every mode (Restricted Mode included). The
 * `.py` is the source of truth:
 *
 * - Saving either file in VS Code updates the other.
 * - A `.py` changed on disk by other means (git discard, checkout, pull, another tool)
 *   regenerates its `.ipynb`.
 * - At startup (and when folders change), each `.ipynb` older than its `.py`, or missing,
 *   is regenerated.
 *
 * Each change is synced once, with one message at most: the watcher ignores files just
 * saved in VS Code (the save hook syncs them), and the save hook ignores saves made by a
 * command that syncs and reports itself (`saveForCommand`).
 */
export const notebookSync: Feature = {
  name: 'notebookSync',
  activate(context) {
    context.subscriptions.push(new NotebookSync());
  },
};

/** What made a notebook's files sync. */
export type SyncTrigger = 'save' | 'disk' | 'startup';

/** A sync that rewrote a notebook's other file. */
export interface SyncEvent {
  files: NotebookFiles;
  /** The file that was saved or changed (the other one was rewritten from it). */
  from: NotebookFileKind;
  trigger: SyncTrigger;
}

export interface NotebookSyncOptions {
  /** The project folder; defaults to `projectRoot()` (the first folder of the VS Code workspace). */
  root?: () => vscode.Uri | undefined;
  /** Shows a warning; defaults to logging it and showing it in a notification. */
  warn?: (message: string) => void;
}

/** The save hooks, `.py` watcher and startup refresh for one project folder (see `notebookSync`). */
export class NotebookSync implements vscode.Disposable {
  private readonly root: () => vscode.Uri | undefined;
  private readonly warn: (message: string) => void;
  private readonly synced = new vscode.EventEmitter<SyncEvent>();
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.Disposable | undefined;
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  /** The startup refresh, so tests (and anything else) can wait for it. */
  readonly ready: Promise<void>;

  /** Fires after a sync rewrote a notebook's other file. */
  readonly onDidSync = this.synced.event;

  constructor(options: NotebookSyncOptions = {}) {
    this.root = options.root ?? projectRoot;
    this.warn = options.warn ?? warn;
    this.disposables.push(
      this.synced,
      vscode.workspace.onDidSaveNotebookDocument((doc) => void this.syncAfterSave(doc.uri)),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.syncAfterSave(doc.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.watch();
        void this.refreshStaleNotebooks();
      }),
      onNonFabricCellsDropped((dropped) => {
        if (this.inProject(dropped.files)) {
          this.warn(droppedCellsMessage(dropped));
        }
      }),
    );
    this.watch();
    this.ready = this.refreshStaleNotebooks();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.pending.forEach((timer) => clearTimeout(timer));
    this.disposables.forEach((d) => d.dispose());
  }

  /** Whether a notebook belongs to this project folder. */
  private inProject(files: NotebookFiles): boolean {
    return files.root.toString() === this.root()?.toString();
  }

  private notify(files: NotebookFiles, from: NotebookFileKind, trigger: SyncTrigger): void {
    this.synced.fire({ files, from, trigger });
  }

  /**
   * Watches each `src/Notebooks/<Name>/<Name>.py` in the project so a `.py` changed outside
   * the editor (git discard, checkout, pull, another tool) regenerates its `.ipynb`. The
   * extension's own writes and saves in VS Code are ignored, and changes are debounced so a
   * burst (e.g. a branch switch) syncs each file once.
   */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const root = this.root();
    if (!root) {
      return;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, 'src/Notebooks/*/*.py'));
    const onChange = (uri: vscode.Uri) => {
      if (wasWrittenByExtension(uri) || wasSavedInEditor(uri)) {
        return;
      }
      clearTimeout(this.pending.get(uri.toString()));
      this.pending.set(
        uri.toString(),
        setTimeout(() => {
          this.pending.delete(uri.toString());
          // Checked again: the watcher can report a save before VS Code's save event arrives.
          if (!wasSavedInEditor(uri)) {
            void this.syncFromDisk(uri);
          }
        }, 300),
      );
    };
    const subscriptions = [watcher.onDidChange(onChange), watcher.onDidCreate(onChange)];
    this.watcher = { dispose: () => [...subscriptions, watcher].forEach((d) => d.dispose()) };
  }

  /** Regenerates a notebook's `.ipynb` from its `.py` after the `.py` changed on disk. */
  private async syncFromDisk(uri: vscode.Uri): Promise<void> {
    const root = this.root();
    const match = root && notebookFilesFor(root, uri);
    if (match?.kind !== 'py') {
      return;
    }
    const { files } = match;
    if (openDocument(files.ipynb)?.isDirty) {
      this.warn(
        `${vscode.workspace.asRelativePath(files.py)} changed on disk, but ${vscode.workspace.asRelativePath(files.ipynb)} has unsaved changes, so it wasn't updated.`,
      );
      return;
    }
    try {
      if (await syncNotebookFiles(files, 'py', { background: true })) {
        getLogger().info(`Updated ${vscode.workspace.asRelativePath(files.ipynb)}: ${vscode.workspace.asRelativePath(files.py)} changed on disk`);
        this.notify(files, 'py', 'disk');
      }
    } catch (err) {
      if (err instanceof EmptyNotebookError) {
        this.warn(`Not synced: ${err.message}`);
        return;
      }
      // A plain Python file at a notebook's path, or a half-written file: nothing to sync.
      getLogger().debug(`Not synced from disk: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** At startup (and when folders change): regenerate each `.ipynb` whose `.py` is newer, or missing. */
  private async refreshStaleNotebooks(): Promise<void> {
    const root = this.root();
    if (!root) {
      return;
    }
    try {
      for (const files of await listLocalNotebooks(root)) {
        if (openDocument(files.ipynb)?.isDirty) {
          continue;
        }
        try {
          if (await refreshIpynbIfStale(files, { background: true })) {
            getLogger().info(`Updated ${vscode.workspace.asRelativePath(files.ipynb)} from ${vscode.workspace.asRelativePath(files.py)}`);
            this.notify(files, 'py', 'startup');
          }
        } catch (err) {
          if (err instanceof EmptyNotebookError) {
            this.warn(`Not synced: ${err.message}`);
            continue;
          }
          getLogger().debug(`Not refreshed: ${files.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      getLogger().warn('Checking notebooks at startup failed', err);
    }
  }

  /** After one of a notebook's files is saved in VS Code, updates the other one. */
  private async syncAfterSave(uri: vscode.Uri): Promise<void> {
    editorSaves.set(uri.toString(), Date.now());
    if (commandSaves.has(uri.toString())) {
      return; // The command syncs, and reports any problem, itself.
    }
    const root = this.root();
    const match = root && notebookFilesFor(root, uri);
    if (!match) {
      return;
    }
    const { files, kind } = match;
    const other = kind === 'py' ? files.ipynb : files.py;
    if (openDocument(other)?.isDirty) {
      this.warn(`${vscode.workspace.asRelativePath(other)} has unsaved changes, so it wasn't updated from the file you saved.`);
      return;
    }
    try {
      if (await syncNotebookFiles(files, kind)) {
        getLogger().debug(`Updated ${vscode.workspace.asRelativePath(other)}`);
        this.notify(files, kind, 'save');
      }
    } catch (err) {
      if (err instanceof EmptyNotebookError || err instanceof NotFabricNotebookError || err instanceof NonFabricCellsError) {
        this.warn(`Not synced: ${err.message}`);
        return;
      }
      await reportError(`Update ${vscode.workspace.asRelativePath(other)}`, err);
    }
  }
}

/** How long after a save in VS Code the file watcher's event for it is ignored. */
const EDITOR_SAVE_WINDOW_MS = 3000;
/** Files saved in VS Code recently, so the file watcher leaves them to the save hook. */
const editorSaves = new Map<string, number>();
/** Saves made by commands that sync and report themselves, so the save hook leaves them alone. */
const commandSaves = new Set<string>();

/**
 * Saves a document for a command that syncs the notebook itself afterwards (and reports
 * any problem), so the save doesn't also sync and warn. Returns whether it was saved.
 */
export async function saveForCommand(doc: vscode.NotebookDocument | vscode.TextDocument): Promise<boolean> {
  const key = doc.uri.toString();
  commandSaves.add(key);
  try {
    return await doc.save();
  } finally {
    commandSaves.delete(key);
  }
}

/**
 * Saves a notebook's open, unsaved file (if any) and updates its other file. Throws if both
 * files have unsaved changes, since one would overwrite the other.
 */
export async function saveNotebook(files: NotebookFiles): Promise<void> {
  const py = openDocument(files.py);
  const ipynb = openDocument(files.ipynb);
  if (py?.isDirty && ipynb?.isDirty) {
    throw new ActionNeededError('both of its files have unsaved changes. Save one and revert the other');
  }
  const [doc, kind] = py?.isDirty ? [py, 'py' as const] : ipynb?.isDirty ? [ipynb, 'ipynb' as const] : [];
  if (doc && kind) {
    if (!(await saveForCommand(doc))) {
      throw new Error('its unsaved changes couldn\'t be saved');
    }
    await syncNotebookFiles(files, kind);
  }
}

/** The open notebook or text document for `uri`, if any. */
export function openDocument(uri: vscode.Uri): vscode.NotebookDocument | vscode.TextDocument | undefined {
  const key = uri.toString();
  return (
    vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === key) ??
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === key)
  );
}

/** Whether `uri` was saved in VS Code in the last few seconds (forgetting older saves). */
function wasSavedInEditor(uri: vscode.Uri): boolean {
  const now = Date.now();
  for (const [key, at] of editorSaves) {
    if (now - at >= EDITOR_SAVE_WINDOW_MS) {
      editorSaves.delete(key);
    }
  }
  return editorSaves.has(uri.toString());
}

/** Logs a warning and shows it. */
function warn(message: string): void {
  getLogger().warn(message);
  void vscode.window.showWarningMessage(message);
}
