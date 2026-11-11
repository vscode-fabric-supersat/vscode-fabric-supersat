/**
 * Files kept per Fabric workspace in `.fabric-supersat/workspaces/<Workspace Name>/` (in the
 * folder and file names, a name that can't be a file name is encoded, see `workspaceFolderName`):
 *
 * - `<Workspace Name>.md` / `<Workspace Name>.json`: "Refresh Workspace Information" (see `metadata.ts`).
 * - `notebooks-cache/<Notebook Name>/`: each notebook as last fetched from Fabric (see
 *   `notebookCache.ts`), for "Compare All Notebooks with Workspace".
 * - `sync-state.json`: for each item, by kind (`notebooks`, `environments`), a hash of its
 *   content last downloaded from or uploaded to this workspace, or found the same as
 *   Fabric's by "Refresh Workspace Information" or "Compare Notebook with Workspace", so
 *   "Upload All" can offer to upload only items changed locally since. Changes made in
 *   Fabric aren't seen by it.
 *
 * These are outputs and bookkeeping only: no command acts on an ID read from them.
 */
import * as vscode from 'vscode';
import { ITEM_KINDS, type ItemKind, type ItemKindInfo } from '../items/kinds';
import { safeFolderName } from '../util/folderNames';
import { assertSafeWritePath, ensureLocalStateDir, localStateDir } from '../util/localState';
import { hashText } from '../util/hash';
import { toLf } from '../util/text';

export const WORKSPACES_DIR = 'workspaces';
export const SYNC_STATE_FILE = 'sync-state.json';

/**
 * A workspace name as a folder name: the name itself when it is a safe folder name,
 * otherwise encoded (see `safeFolderName`, the same rules as for notebook folders).
 */
export function workspaceFolderName(name: string): string {
  return safeFolderName(name);
}

/** A workspace information file's name, `<Workspace Name>.<extension>` (e.g. `Sales.md`; encoded as `workspaceFolderName` does). */
export function workspaceInfoFileName(workspaceName: string, extension: 'md' | 'json'): string {
  return `${workspaceFolderName(workspaceName)}.${extension}`;
}

/** `.fabric-supersat/workspaces/<Workspace Name>` in the project. */
export function workspaceStateDir(root: vscode.Uri, workspaceName: string): vscode.Uri {
  return vscode.Uri.joinPath(localStateDir(root), WORKSPACES_DIR, workspaceFolderName(workspaceName));
}

/** Writes a file in a workspace's folder, creating folders as needed (asking before creating `.fabric-supersat`). */
export function writeWorkspaceFile(root: vscode.Uri, workspaceName: string, file: string, text: string): Promise<vscode.Uri> {
  return writeLocalStateFile(root, [WORKSPACES_DIR, workspaceFolderName(workspaceName), file], text);
}

/** Writes a file at `parts` inside `.fabric-supersat` (asking before creating the folder). */
export async function writeLocalStateFile(root: vscode.Uri, parts: readonly string[], text: string): Promise<vscode.Uri> {
  const dir = localStateDir(root);
  await ensureLocalStateDir(dir);
  const uri = vscode.Uri.joinPath(dir, ...parts);
  await assertSafeWritePath(root, uri);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
  return uri;
}

/** Creates a folder at `parts` inside `.fabric-supersat` (asking before creating `.fabric-supersat`). */
export async function createLocalStateDir(root: vscode.Uri, parts: readonly string[]): Promise<vscode.Uri> {
  const dir = localStateDir(root);
  await ensureLocalStateDir(dir);
  const uri = vscode.Uri.joinPath(dir, ...parts);
  await assertSafeWritePath(root, uri);
  await vscode.workspace.fs.createDirectory(uri);
  return uri;
}

/** Deletes a file or folder at `parts` inside `.fabric-supersat`, if it exists. */
export async function deleteLocalStatePath(root: vscode.Uri, parts: readonly string[]): Promise<void> {
  const uri = vscode.Uri.joinPath(localStateDir(root), ...parts);
  await assertSafeWritePath(root, uri);
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  } catch {
    // Not there.
  }
}

/** What was last synced of one item: a hash of its content, when, and how. */
export interface ItemSyncState {
  /**
   * SHA-256 of its content, in hex: a notebook's `.py` text with LF line endings, an
   * environment's files as `hashEnvironment` (`src/environments/definition.ts`) makes it.
   */
  hash: string;
  time: string;
  /** How it was synced: downloaded, uploaded, or found the same as Fabric's when comparing. */
  direction: 'download' | 'upload' | 'compare';
}

/** A workspace's sync state: each kind of item, by local name. */
export type SyncState = Record<ItemKindInfo['stateKey'], Record<string, ItemSyncState>>;

/** SHA-256 of a text, in hex (Web Crypto, so it works on desktop and web). */
export { hashText } from '../util/hash';

/** A workspace's sync state; empty if there is none or it can't be read. */
export async function readSyncState(root: vscode.Uri, workspaceName: string): Promise<SyncState> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceStateDir(root, workspaceName), SYNC_STATE_FILE));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SyncState>;
    const items = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, ItemSyncState>) : {});
    return { notebooks: items(parsed.notebooks), environments: items(parsed.environments) };
  } catch {
    return { notebooks: {}, environments: {} };
  }
}

/** A change to a workspace JSON file's content; returns whether it changed anything (so whether to write). */
type JsonFileChange<T> = (content: T) => boolean;

/** Changes to one file waiting for the write under way to finish, and that next write. */
interface Batch {
  changes: JsonFileChange<never>[];
  written: Promise<void>;
}

/** Each file's last write (under way or waiting), so its writes run one at a time. */
const writes = new Map<string, Promise<void>>();
/** Each file's batch not yet started: changes made meanwhile join it. */
const batches = new Map<string, Batch>();

/** An item recorded as synced with a workspace (`synced`), or forgotten (deleted there, or not found there). */
export interface SyncRecorded {
  readonly root: vscode.Uri;
  readonly workspaceName: string;
  readonly kind: ItemKind;
  /** The local item's name. */
  readonly name: string;
  readonly synced: boolean;
  /** The notebook's item ID in Fabric, when the caller knows it (download and upload). */
  readonly itemId?: string;
}

const syncRecorded = new vscode.EventEmitter<SyncRecorded>();

/**
 * Fires after an item is recorded in a workspace's sync state (downloaded, uploaded, or
 * found the same by comparing) or forgotten there. Fabric Data Engineering's copies follow
 * it (for notebooks).
 */
export const onDidRecordSync = syncRecorded.event;

/** Records that a notebook's `.py` was just downloaded from, or uploaded to, the workspace (or found the same). */
export async function recordSync(
  root: vscode.Uri,
  workspaceName: string,
  notebook: string,
  py: string,
  direction: ItemSyncState['direction'],
  itemId?: string,
): Promise<void> {
  await recordItemSync(root, workspaceName, 'notebook', notebook, await hashNotebookPy(py), direction, itemId);
}

/** A notebook's content hash for the sync state: its `.py` with LF line endings. */
export function hashNotebookPy(py: string): Promise<string> {
  return hashText(toLf(py));
}

/** Records that an item (of `kind`, with content hash `hash`) was just downloaded, uploaded, or found the same as Fabric's. */
export async function recordItemSync(
  root: vscode.Uri,
  workspaceName: string,
  kind: ItemKind,
  name: string,
  hash: string,
  direction: ItemSyncState['direction'],
  itemId?: string,
): Promise<void> {
  const key = ITEM_KINDS[kind].stateKey;
  await updateSyncState(root, workspaceName, (state) => {
    state[key][name] = { hash, time: new Date().toISOString(), direction };
    return true;
  });
  syncRecorded.fire({ root, workspaceName, kind, name, synced: true, ...(itemId ? { itemId } : {}) });
}

/**
 * Forgets a notebook deleted from the workspace, so "Upload Changed" counts it as changed
 * (it would otherwise skip it as unchanged, though it is no longer in Fabric). Names match
 * ignoring case, as Fabric matches them. Writes nothing if the notebook wasn't recorded.
 */
export function forgetSync(root: vscode.Uri, workspaceName: string, notebook: string): Promise<void> {
  return forgetItemSync(root, workspaceName, 'notebook', notebook);
}

/** `forgetSync` for an item of any kind. */
export async function forgetItemSync(root: vscode.Uri, workspaceName: string, kind: ItemKind, name: string): Promise<void> {
  const key = name.toLowerCase();
  const items = ITEM_KINDS[kind].stateKey;
  await updateSyncState(root, workspaceName, (state) => {
    const recorded = Object.keys(state[items]).filter((n) => n.toLowerCase() === key);
    recorded.forEach((n) => delete state[items][n]);
    return recorded.length > 0;
  });
  syncRecorded.fire({ root, workspaceName, kind, name, synced: false });
}

/** Changes one workspace's sync state (see `updateWorkspaceJsonFile`). */
function updateSyncState(root: vscode.Uri, workspaceName: string, change: JsonFileChange<SyncState>): Promise<void> {
  return updateWorkspaceJsonFile(root, workspaceName, SYNC_STATE_FILE, () => readSyncState(root, workspaceName), change, (state) => {
    const sorted = (items: Record<string, ItemSyncState>) => Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)));
    // Environments only once there are some, so the file stays as it was for notebook-only projects.
    const content = { notebooks: sorted(state.notebooks), ...(Object.keys(state.environments).length ? { environments: sorted(state.environments) } : {}) };
    return `${JSON.stringify(content, undefined, 2)}\n`;
  });
}

/**
 * Changes a JSON file in a workspace's folder. Writes run one at a time, and changes made
 * while one is under way are applied together in the next: one read and one write for all
 * of them. A bulk command over 100 notebooks then writes the file a few times, not 100
 * (each write is a dozen file-system calls, slow where antivirus scans every file).
 * Resolves once the file has the change, or there was nothing to write.
 */
async function updateWorkspaceJsonFile<T>(
  root: vscode.Uri,
  workspaceName: string,
  file: string,
  read: () => Promise<T>,
  change: JsonFileChange<T>,
  serialize: (content: T) => string,
): Promise<void> {
  const key = vscode.Uri.joinPath(workspaceStateDir(root, workspaceName), file).toString();
  const waiting = batches.get(key);
  if (waiting) {
    waiting.changes.push(change as JsonFileChange<never>);
    return waiting.written;
  }
  const batch: Batch = { changes: [change as JsonFileChange<never>], written: Promise.resolve() };
  batch.written = (writes.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      // From here on, changes made meanwhile go in the next batch.
      batches.delete(key);
      const content = await read();
      // Every change is applied (no short-circuit), then the file is written once if any changed it.
      const changed = (batch.changes as JsonFileChange<T>[]).map((c) => c(content)).some(Boolean);
      if (!changed) {
        return;
      }
      await writeWorkspaceFile(root, workspaceName, file, serialize(content));
    });
  batches.set(key, batch);
  writes.set(key, batch.written);
  try {
    await batch.written;
  } finally {
    if (writes.get(key) === batch.written) {
      writes.delete(key);
    }
  }
}

/** Whether a notebook's `.py` differs (line endings aside) from what was last synced with the workspace (or was never synced). */
export async function changedSinceSync(state: SyncState, notebook: string, py: string): Promise<boolean> {
  return itemChangedSinceSync(state, 'notebook', notebook, await hashNotebookPy(py));
}

/** Whether an item's content hash differs from what was last synced with the workspace (or it was never synced). */
export function itemChangedSinceSync(state: SyncState, kind: ItemKind, name: string, hash: string): boolean {
  return state[ITEM_KINDS[kind].stateKey][name]?.hash !== hash;
}
