import type * as vscode from 'vscode';
import type { FabricClient, ItemDefinition, Notebook } from '../fabric/client';
import { fromBase64, toBase64 } from '../util/base64';
import { exists } from '../util/localState';
import { getLogger } from '../util/logger';
import {
  checkNotebookName,
  FABRIC_PY_PART,
  type NotebookFiles,
  notebookFiles,
  NotFabricNotebookError,
  readNotebookDescription,
  readTextIfExists,
  syncNotebookFiles,
  writeNotebookDescription,
  writeNotebookFiles,
} from './files';
import { isFabricPy, parseFabricPy } from './format';

/**
 * Downloads a notebook into its two local files (both exactly as Fabric exports them), and
 * its description into `notebook.yaml` (only if it has one, or the file already exists).
 * If a local copy exists, `confirmReplace` decides whether to overwrite it.
 * Returns the files, or `undefined` if the user chose not to replace them.
 */
export async function downloadNotebook(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  notebook: Pick<Notebook, 'id' | 'displayName' | 'description'>,
  confirmReplace: (files: NotebookFiles) => Promise<boolean>,
): Promise<NotebookFiles | undefined> {
  checkNotebookName(notebook.displayName);
  const files = notebookFiles(root, notebook.displayName);
  if (((await exists(files.py)) || (await exists(files.ipynb))) && !(await confirmReplace(files))) {
    return undefined;
  }
  const [gitSource, ipynb] = await Promise.all([
    client.getNotebookDefinition(workspaceId, notebook.id),
    client.getNotebookDefinition(workspaceId, notebook.id, 'ipynb'),
  ]);
  getLogger().debug(
    `Notebook "${files.name}" definition files: ${gitSource.parts.map((p) => p.path).join(', ')} (Git format); ` +
      `${ipynb.parts.map((p) => p.path).join(', ')} (ipynb)`,
  );
  const other = gitSource.parts.find((p) => /^notebook-content\.(sql|scala|r)$/i.test(p.path));
  if (other && !gitSource.parts.some((p) => p.path.endsWith('.py'))) {
    // Fabric's Git format uses notebook-content.sql / .scala / .r for those languages.
    const language = { sql: 'Spark SQL', scala: 'Scala', r: 'SparkR' }[other.path.split('.').pop()!.toLowerCase()];
    throw new Error(
      `"${files.name}" is a ${language} notebook (${other.path}). Only PySpark and Python notebooks are supported so far.`,
    );
  }
  await writeNotebookFiles(files, partText(gitSource, '.py'), partText(ipynb, '.ipynb'));
  await writeNotebookDescription(files, notebook.description);
  return files;
}

/**
 * The `.py` to upload for a notebook: the file itself, or (if only the `.ipynb` exists) one
 * generated from it. Throws if it isn't a Fabric notebook or has no cells, so nothing broken
 * reaches Fabric.
 */
export async function readNotebookPy(files: NotebookFiles): Promise<string> {
  checkNotebookName(files.name);
  let py = await readTextIfExists(files.py);
  if (py === undefined) {
    if (!(await exists(files.ipynb))) {
      throw new Error(`Notebook "${files.name}" has no local files to upload.`);
    }
    await syncNotebookFiles(files, 'ipynb');
    py = (await readTextIfExists(files.py)) ?? '';
  }
  if (!isFabricPy(py)) {
    throw new NotFabricNotebookError(files.py, 'py');
  }
  if (!parseFabricPy(py).cells.length) {
    throw new Error(`Notebook "${files.name}" has no cells to upload.`);
  }
  return py;
}

/**
 * Sends a notebook's `.py` to the workspace: updates `existing`, or creates the notebook.
 * `description` (from `notebook.yaml`) is set too, if given and different from Fabric's;
 * `undefined` leaves Fabric's description as it is.
 */
export async function sendNotebook(
  client: FabricClient,
  workspaceId: string,
  name: string,
  py: string,
  existing: Pick<Notebook, 'id' | 'description'> | undefined,
  description?: string,
): Promise<'created' | 'updated'> {
  const definition: ItemDefinition = {
    parts: [{ path: FABRIC_PY_PART, payload: toBase64(new TextEncoder().encode(py)), payloadType: 'InlineBase64' }],
  };
  if (existing) {
    await client.updateNotebookDefinition(workspaceId, existing.id, definition);
    if (description !== undefined && description !== (existing.description ?? '')) {
      await client.updateNotebook(workspaceId, existing.id, { description });
      getLogger().info(`Notebook "${name}": ${description ? 'updated the description' : 'cleared the description'}`);
    }
    return 'updated';
  }
  await client.createNotebook(workspaceId, name, definition, description);
  return 'created';
}

/**
 * Uploads a notebook's `.py` to the workspace, replacing the notebook with the same name or
 * creating one. `confirm` is told which (an existing notebook, or `undefined` for a new
 * one) and can cancel. Returns what happened, or `undefined` if cancelled.
 */
export async function uploadNotebook(
  client: FabricClient,
  files: NotebookFiles,
  workspaceId: string,
  confirm: (existing: Notebook | undefined) => Promise<boolean>,
): Promise<'created' | 'updated' | undefined> {
  const py = await readNotebookPy(files);
  const description = await readNotebookDescription(files);
  const existing = findByName(await client.listNotebooks(workspaceId), files.name);
  if (!(await confirm(existing))) {
    return undefined;
  }
  return sendNotebook(client, workspaceId, files.name, py, existing, description);
}

/** What a bulk download or upload did, notebook by notebook. */
export interface BulkResult {
  done: string[];
  /** Not attempted: e.g. a local copy kept, or not a Fabric notebook. */
  skipped: { name: string; reason: string }[];
  /** Attempted, but Fabric or the file system failed. */
  failed: { name: string; reason: string }[];
  /** Stopped early by the user; the rest weren't attempted. */
  cancelled: boolean;
}

export interface BulkOptions {
  onProgress?: (name: string, index: number, total: number) => void;
  isCancelled?: () => boolean;
}

/**
 * Downloads notebooks one at a time. Local copies are replaced only if `replaceExisting`.
 * One failure (e.g. a Spark SQL notebook, or a name that can't be a folder) doesn't stop the rest.
 */
export async function downloadNotebooks(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  notebooks: readonly Pick<Notebook, 'id' | 'displayName' | 'description'>[],
  replaceExisting: boolean,
  options: BulkOptions = {},
): Promise<BulkResult> {
  const result: BulkResult = { done: [], skipped: [], failed: [], cancelled: false };
  for (const [index, notebook] of notebooks.entries()) {
    if (options.isCancelled?.()) {
      result.cancelled = true;
      break;
    }
    options.onProgress?.(notebook.displayName, index, notebooks.length);
    try {
      const files = await downloadNotebook(client, root, workspaceId, notebook, async () => replaceExisting);
      if (files) {
        result.done.push(notebook.displayName);
      } else {
        result.skipped.push({ name: notebook.displayName, reason: 'local copy kept' });
      }
    } catch (err) {
      result.failed.push({ name: notebook.displayName, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** One notebook ready to upload: its `.py`, its description, and the notebook it replaces (if any). */
export interface PlannedUpload {
  files: NotebookFiles;
  py: string;
  /** From `notebook.yaml`; `undefined` leaves Fabric's description as it is. */
  description?: string;
  existing: Notebook | undefined;
}

/**
 * Works out what "Upload All" will do: each local notebook's `.py` and whether it replaces
 * a notebook in the workspace or creates one. Notebooks that can't be uploaded are skipped
 * with the reason.
 */
export async function planUploads(
  client: FabricClient,
  workspaceId: string,
  local: readonly NotebookFiles[],
): Promise<{ uploads: PlannedUpload[]; skipped: { name: string; reason: string }[] }> {
  const remote = await client.listNotebooks(workspaceId);
  const uploads: PlannedUpload[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const files of local) {
    try {
      uploads.push({
        files,
        py: await readNotebookPy(files),
        description: await readNotebookDescription(files),
        existing: findByName(remote, files.name),
      });
    } catch (err) {
      skipped.push({ name: files.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { uploads, skipped };
}

/** Uploads planned notebooks one at a time; one failure doesn't stop the rest. */
export async function runUploads(
  client: FabricClient,
  workspaceId: string,
  uploads: readonly PlannedUpload[],
  options: BulkOptions = {},
): Promise<BulkResult> {
  const result: BulkResult = { done: [], skipped: [], failed: [], cancelled: false };
  for (const [index, { files, py, description, existing }] of uploads.entries()) {
    if (options.isCancelled?.()) {
      result.cancelled = true;
      break;
    }
    options.onProgress?.(files.name, index, uploads.length);
    try {
      await sendNotebook(client, workspaceId, files.name, py, existing, description);
      result.done.push(files.name);
    } catch (err) {
      result.failed.push({ name: files.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

/** Fabric names are unique per workspace ignoring case; prefer an exact match anyway. */
export function findByName<T extends { displayName: string }>(items: readonly T[], name: string): T | undefined {
  return (
    items.find((i) => i.displayName === name) ??
    items.find((i) => i.displayName.toLowerCase() === name.toLowerCase())
  );
}

function partText(definition: ItemDefinition, extension: string): string {
  const part = definition.parts.find((p) => p.path.endsWith(extension));
  if (!part) {
    const paths = definition.parts.map((p) => p.path).join(', ') || 'none';
    throw new Error(`Fabric returned no ${extension} file for the notebook (got: ${paths}).`);
  }
  return new TextDecoder().decode(fromBase64(part.payload));
}
