/**
 * Files kept per Fabric workspace in `.fabric-supersat/workspaces/<Workspace Name>/`:
 *
 * - `metadata.md` / `metadata.json`: "Download Workspace Metadata" (see `metadata.ts`).
 * - `sync-state.json`: for each notebook, a hash of the `.py` last downloaded from or
 *   uploaded to this workspace, so "Upload All" can offer to upload only notebooks changed
 *   locally since. Changes made in Fabric aren't seen by it.
 *
 * These are outputs and bookkeeping only: no command acts on an ID read from them.
 */
import * as vscode from 'vscode';
import { assertSafeWritePath, ensureLocalStateDir, localStateDir } from '../util/localState';

export const WORKSPACES_DIR = 'workspaces';
export const SYNC_STATE_FILE = 'sync-state.json';

/**
 * A workspace name as a folder name: characters that can't be in a file name on some
 * system (`\ / : * ? " < > |`, control characters, `%` itself) and a trailing dot or
 * space are written as `%XX`; `.` and `..` are encoded whole.
 */
export function workspaceFolderName(name: string): string {
  let encoded = name.replace(/[\\/:*?"<>|%\u0000-\u001f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  encoded = encoded.replace(/[. ]$/, (c) => (c === '.' ? '%2E' : '%20'));
  return encoded === '' ? '%' : encoded;
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

export interface NotebookSyncState {
  /** SHA-256 of the `.py` text, in hex. */
  hash: string;
  time: string;
  direction: 'download' | 'upload';
}

export interface SyncState {
  notebooks: Record<string, NotebookSyncState>;
}

/** SHA-256 of a text, in hex (Web Crypto, so it works on desktop and web). */
export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A workspace's sync state; empty if there is none or it can't be read. */
export async function readSyncState(root: vscode.Uri, workspaceName: string): Promise<SyncState> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workspaceStateDir(root, workspaceName), SYNC_STATE_FILE));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<SyncState>;
    return { notebooks: parsed.notebooks && typeof parsed.notebooks === 'object' ? parsed.notebooks : {} };
  } catch {
    return { notebooks: {} };
  }
}

/** Updates to one workspace's file are made one at a time (bulk commands record several at once). */
const updates = new Map<string, Promise<unknown>>();

/** Records that a notebook's `.py` was just downloaded from, or uploaded to, the workspace. */
export async function recordSync(
  root: vscode.Uri,
  workspaceName: string,
  notebook: string,
  py: string,
  direction: NotebookSyncState['direction'],
): Promise<void> {
  const hash = await hashText(py);
  const key = workspaceStateDir(root, workspaceName).toString();
  const run = (updates.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const state = await readSyncState(root, workspaceName);
      state.notebooks[notebook] = { hash, time: new Date().toISOString(), direction };
      const sorted = Object.fromEntries(Object.entries(state.notebooks).sort(([a], [b]) => a.localeCompare(b)));
      await writeWorkspaceFile(root, workspaceName, SYNC_STATE_FILE, `${JSON.stringify({ notebooks: sorted }, undefined, 2)}\n`);
    });
  updates.set(key, run);
  try {
    await run;
  } finally {
    if (updates.get(key) === run) {
      updates.delete(key);
    }
  }
}

/** Whether a notebook's `.py` differs from what was last synced with the workspace (or was never synced). */
export async function changedSinceSync(state: SyncState, notebook: string, py: string): Promise<boolean> {
  const last = state.notebooks[notebook];
  return !last || last.hash !== (await hashText(py));
}
