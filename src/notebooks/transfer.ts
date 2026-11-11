import type * as vscode from 'vscode';
import type { FabricClient, ItemDefinition, Notebook } from '../fabric/client';
import { toBase64 } from '../util/base64';
import { exists } from '../util/localState';
import { getLogger } from '../util/logger';
import {
  checkNotebookName,
  FABRIC_PY_PART,
  type NotebookFiles,
  notebookFiles,
  isNotebookContent,
  NotFabricNotebookError,
  readNotebookDescription,
  readNotebookFolder,
  readTextIfExists,
  reportDroppedCells,
  syncNotebookFiles,
  writeNotebookFiles,
  writeNotebookProperties,
  writeNotebookPy,
} from './files';
import { contentParts, partText, requirePartText } from './definition';
import { dropUnknownHeaderKeys, fabricToIpynb, isFabricPy, parseFabricPy } from './format';
import { unsupportedNotebook } from './support';
import { KeyedLock } from '../util/keyedLock';
import { recordHistory } from '../util/diagnostics';
import { findByName } from '../util/names';
import { toLf } from '../util/text';
import { type CachedNotebook, transferredEntry, updateCachedNotebook } from '../workspace/notebookCache';
import { recordSync } from '../workspace/state';
import type { ReferenceMapper } from './references';
import { ActionNeededError } from '../util/errorFix';
import { type BulkOptions, type BulkResult, runBulk } from '../items/bulk';
import { deleteItems } from '../items/delete';
import { sameFolderId, sameFolderPath, WorkspaceFolders } from './folders';

/** The notebook fields download and upload use. */
type NotebookInfo = Pick<Notebook, 'id' | 'displayName' | 'description' | 'folderId'>;

export interface DownloadOptions {
  /** The workspace's name: given, the download is recorded in the history and sync state. */
  workspaceName?: string;
  /** The workspace's folders, shared by a command's notebooks (one is made if not given). */
  folders?: WorkspaceFolders;
}

export interface SendOptions {
  /** Points the notebook's lakehouses and environment at the workspace's own (see `applyReferences`). */
  references?: ReferenceMapper;
  /** The workspace's name: given, the upload is recorded in the history and sync state. */
  workspaceName?: string;
  /** The workspace's folders, shared by a command's notebooks (one is made if not given). */
  folders?: WorkspaceFolders;
}

/**
 * Downloads a notebook into its two local files: the `.py` exactly as Fabric's Git format
 * exports it, and the `.ipynb` generated from it (Fabric's cell outputs aren't downloaded;
 * a local `.ipynb`'s outputs are kept for cells whose code is unchanged), and
 * its description and folder into `<Name>.yaml` (see `writeNotebookProperties`).
 * If a local copy exists, `confirmReplace` decides whether to overwrite it.
 * Returns the files, or `undefined` if the user chose not to replace them.
 */
export async function downloadNotebook(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  notebook: NotebookInfo,
  confirmReplace: (files: NotebookFiles) => Promise<boolean>,
  options: DownloadOptions = {},
): Promise<NotebookFiles | undefined> {
  const { workspaceName } = options;
  try {
    const folders = options.folders ?? new WorkspaceFolders(client, workspaceId);
    const result = await downloadOne(client, root, workspaceId, notebook, confirmReplace, folders);
    if (result && workspaceName) {
      await recordSync(root, workspaceName, result.files.name, result.py, 'download', notebook.id);
      await updateCache(
        root,
        workspaceName,
        result.files.name,
        transferredEntry(result.files.name, notebook.id, FABRIC_PY_PART, result.fabricText, {
          description: notebook.description ?? '',
          ...(result.folder !== undefined ? { folder: result.folder } : {}),
        }),
      );
      recordHistory({ action: 'download', notebook: result.files.name, workspace: workspaceName, result: 'downloaded' });
    }
    return result?.files;
  } catch (err) {
    if (workspaceName) {
      recordHistory({ action: 'download', notebook: notebook.displayName, workspace: workspaceName, result: 'failed', error: message(err) });
    }
    throw err;
  }
}

async function downloadOne(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  notebook: NotebookInfo,
  confirmReplace: (files: NotebookFiles) => Promise<boolean>,
  folders: WorkspaceFolders,
): Promise<{ files: NotebookFiles; py: string; fabricText: string; folder?: string } | undefined> {
  checkNotebookName(notebook.displayName);
  const files = notebookFiles(root, notebook.displayName);
  if (((await exists(files.py)) || (await exists(files.ipynb))) && !(await confirmReplace(files))) {
    return undefined;
  }
  // One request: Fabric's Git format. Fabric's cell outputs (only in its .ipynb export)
  // aren't downloaded; the local .ipynb is generated from the .py.
  const gitSource = await client.getNotebookDefinition(workspaceId, notebook.id);
  getLogger().debug(`Notebook "${files.name}" definition files: ${gitSource.parts.map((p) => p.path).join(', ')} (Git format)`);
  for (const content of contentParts(gitSource)) {
    const unsupported = unsupportedNotebook(files.name, content.path, partText(content));
    if (unsupported) {
      throw new ActionNeededError(unsupported);
    }
  }
  const fabricText = toLf(requirePartText(gitSource, '.py'));
  const py = knownHeaderKeysOnly(files.name, fabricText);
  // Outputs from local runs are kept for cells whose code is unchanged (as saving the .py does).
  const existing = await readTextIfExists(files.ipynb);
  const keep = existing !== undefined && isNotebookContent('ipynb', existing) ? existing : undefined;
  await writeNotebookFiles(files, py, fabricToIpynb(parseFabricPy(py), keep));
  reportDroppedCells(files, keep);
  const folder = await folderPathOf(folders, files.name, notebook.folderId);
  await writeNotebookProperties(files, { description: notebook.description, folder });
  return { files, py, fabricText, folder };
}

/**
 * A downloaded notebook's folder path (`''` for the workspace root), or `undefined` if Fabric's
 * folders couldn't be read: the download still counts, and `<Name>.yaml` keeps its `folder`.
 */
async function folderPathOf(folders: WorkspaceFolders, name: string, folderId: string | undefined): Promise<string | undefined> {
  try {
    return await folders.pathOf(folderId);
  } catch (err) {
    getLogger().warn(`Notebook "${name}": couldn't read its folder in Fabric, so ${name}.yaml's folder was left as it is`, err);
    return undefined;
  }
}

/** The `.py` without header keys this extension doesn't know (see `HEADER_META_KEYS`), logging any dropped. */
function knownHeaderKeysOnly(name: string, py: string): string {
  const result = dropUnknownHeaderKeys(py);
  if (result.dropped.length) {
    getLogger().info(`Notebook "${name}": left out unknown header keys: ${result.dropped.join(', ')}`);
  }
  return result.py;
}

/** Updates the workspace's notebook cache, if it has one (see `notebookCache.ts`); a failure is only logged. */
async function updateCache(root: vscode.Uri, workspaceName: string, name: string, entry: CachedNotebook | undefined): Promise<void> {
  try {
    await updateCachedNotebook(root, workspaceName, name, entry);
  } catch (err) {
    getLogger().warn(`Notebook "${name}": couldn't update the notebook cache for ${workspaceName}`, err);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
      throw new ActionNeededError(`Notebook "${files.name}" has no local files to upload.`);
    }
    await syncNotebookFiles(files, 'ipynb');
    py = (await readTextIfExists(files.py)) ?? '';
  }
  if (!isFabricPy(py)) {
    throw new NotFabricNotebookError(files.py, 'py');
  }
  // Fabric gets LF line endings (a local file may have CRLF, e.g. on Windows), and only known header keys.
  py = knownHeaderKeysOnly(files.name, toLf(py));
  const unsupported = unsupportedNotebook(files.name, FABRIC_PY_PART, py);
  if (unsupported) {
    throw new ActionNeededError(unsupported);
  }
  if (!parseFabricPy(py).cells.length) {
    throw new ActionNeededError(`Notebook "${files.name}" has no cells to upload.`);
  }
  return py;
}

/**
 * Sends a notebook's `.py` to the workspace: updates `existing`, or creates the notebook.
 * `description` (from `<Name>.yaml`) is set too, if given and different from Fabric's;
 * `undefined` leaves Fabric's description as it is. With `target`, the notebook is created in
 * (or moved to, if it isn't there) that folder, `folderId` `undefined` being the workspace root;
 * without, a new notebook goes in the root and an existing one stays where it is. Returns what
 * happened, and the notebook's ID (if Fabric reported it on creating it).
 */
export async function sendNotebook(
  client: FabricClient,
  workspaceId: string,
  name: string,
  py: string,
  existing: Pick<Notebook, 'id' | 'description' | 'folderId'> | undefined,
  description?: string,
  target?: { folderId: string | undefined },
): Promise<{ result: 'created' | 'updated'; id?: string }> {
  const definition: ItemDefinition = {
    parts: [{ path: FABRIC_PY_PART, payload: toBase64(new TextEncoder().encode(py)), payloadType: 'InlineBase64' }],
  };
  if (existing) {
    await client.updateNotebookDefinition(workspaceId, existing.id, definition);
    if (description !== undefined && description !== (existing.description ?? '')) {
      await client.updateNotebook(workspaceId, existing.id, { description });
      getLogger().info(`Notebook "${name}": ${description ? 'updated the description' : 'cleared the description'}`);
    }
    if (target && !sameFolderId(existing.folderId, target.folderId)) {
      await client.moveItem(workspaceId, existing.id, target.folderId);
      getLogger().info(`Notebook "${name}": moved to ${target.folderId ? `folder ${target.folderId}` : 'the workspace root'}`);
    }
    return { result: 'updated', id: existing.id };
  }
  const created = await client.createNotebook(workspaceId, name, definition, description, target?.folderId);
  return { result: 'created', id: typeof created?.id === 'string' ? created.id : undefined };
}

/**
 * Uploads of the same notebook to the same workspace run one at a time, from any command:
 * otherwise a second upload started while Fabric is still creating the notebook could try
 * to create it again, or two uploads could finish in the wrong order.
 */
const uploadLock = new KeyedLock();

/** The upload lock's key: the workspace, and the notebook's name ignoring case (as Fabric matches names). */
function uploadKey(workspaceId: string, name: string): string {
  return `${workspaceId}\n${name.toLowerCase()}`;
}

/** Where an upload puts a notebook: `<Name>.yaml`'s folder, and the folder it's in now (for one that exists). */
export interface Placement {
  /** The folder path from `<Name>.yaml` (`''` for the workspace root). */
  to: string;
  /** The existing notebook's folder path in Fabric; `undefined` for a new notebook. */
  from?: string;
}

/** Whether an upload changes an existing notebook's description (to the one in `<Name>.yaml`). */
export function changesDescription(upload: Pick<PlannedUpload, 'description' | 'existing'>): boolean {
  return upload.existing !== undefined && upload.description !== undefined && upload.description !== (upload.existing.description ?? '');
}

/** Whether an upload moves an existing notebook to another folder. */
export function movesNotebook(placement: Placement | undefined): placement is Placement & { from: string } {
  return placement?.from !== undefined && !sameFolderPath(placement.from, placement.to);
}

/**
 * Uploads a notebook's `.py` to the workspace, replacing the notebook with the same name or
 * creating one. `confirm` is told which (an existing notebook, or `undefined` for a new
 * one), and where it goes if `<Name>.yaml` names a folder, and can cancel. Returns what
 * happened, or `undefined` if cancelled.
 *
 * Waits for an upload of the same notebook under way, then reads the files as they are by
 * then. Further calls made while one is waiting share it (and its result) instead of queuing.
 */
export async function uploadNotebook(
  client: FabricClient,
  files: NotebookFiles,
  workspaceId: string,
  confirm: (existing: Notebook | undefined, placement: Placement | undefined) => Promise<boolean>,
  options: SendOptions = {},
): Promise<'created' | 'updated' | undefined> {
  return uploadLock.run(
    uploadKey(workspaceId, files.name),
    async () => {
      const py = await readNotebookPy(files);
      const description = await readNotebookDescription(files);
      const folder = await readNotebookFolder(files);
      const existing = findByName(await client.listNotebooks(workspaceId), files.name);
      const folders = options.folders ?? new WorkspaceFolders(client, workspaceId);
      const placement = folder === undefined ? undefined : { to: folder, from: existing ? await folders.pathOf(existing.folderId) : undefined };
      if (!(await confirm(existing, placement))) {
        return undefined;
      }
      return uploadPrepared(client, workspaceId, { files, py, description, folder, existing }, { ...options, folders });
    },
    { share: true },
  );
}

/**
 * Uploads a planned notebook (see `planUploads`), after any upload of it under way. If it had
 * to wait, the notebook may have been created meanwhile, so whether it exists is checked again.
 */
async function uploadPlanned(
  client: FabricClient,
  workspaceId: string,
  upload: PlannedUpload,
  options: SendOptions,
): Promise<'created' | 'updated'> {
  return uploadLock.run(uploadKey(workspaceId, upload.files.name), async (waited) => {
    const existing = waited ? findByName(await client.listNotebooks(workspaceId), upload.files.name) : upload.existing;
    return uploadPrepared(client, workspaceId, { ...upload, existing }, options);
  });
}

/**
 * Uploads a notebook whose `.py` has been read: points its references at the workspace
 * (writing them to the local files), sends it, and records it in the history and sync state.
 */
async function uploadPrepared(
  client: FabricClient,
  workspaceId: string,
  { files, py, description, folder, existing }: PlannedUpload,
  { references, workspaceName, folders }: SendOptions,
): Promise<'created' | 'updated'> {
  let replaced: string[] = [];
  const workspaceFolders = folders ?? new WorkspaceFolders(client, workspaceId);
  try {
    // The folder first: one that can't be created stops the upload before anything changes.
    const target = folder === undefined ? undefined : { folderId: await workspaceFolders.ensure(folder) };
    const ready = await applyReferences(files, py, references);
    replaced = ready.replaced;
    const { result, id } = await sendNotebook(client, workspaceId, files.name, ready.py, existing, description, target);
    if (workspaceName) {
      await recordSync(files.root, workspaceName, files.name, ready.py, 'upload', id);
      // Its properties in Fabric now: <Name>.yaml's, or what it had (a new notebook: none, in the root).
      const fabricFolder = folder ?? (existing ? await folderPathOf(workspaceFolders, files.name, existing.folderId) : '');
      await updateCache(
        files.root,
        workspaceName,
        files.name,
        transferredEntry(files.name, id, FABRIC_PY_PART, ready.py, {
          description: description ?? existing?.description ?? '',
          ...(fabricFolder !== undefined ? { folder: fabricFolder } : {}),
        }),
      );
      recordHistory({
        action: 'upload',
        notebook: files.name,
        workspace: workspaceName,
        result,
        ...(replaced.length ? { replaced } : {}),
      });
    }
    return result;
  } catch (err) {
    if (workspaceName) {
      recordHistory({ action: 'upload', notebook: files.name, workspace: workspaceName, result: 'failed', error: message(err) });
    }
    throw err;
  }
}

/**
 * Points the notebook's lakehouses and environment at the target workspace (see
 * `notebooks/references.ts`) and writes the changed IDs into its local files, so what is
 * uploaded is what's on disk; source control shows the change, to commit or revert.
 * Returns the `.py` to upload, and the IDs changed.
 */
export async function applyReferences(
  files: NotebookFiles,
  py: string,
  references: ReferenceMapper | undefined,
): Promise<{ py: string; replaced: string[] }> {
  if (!references) {
    return { py, replaced: [] };
  }
  const result = await references.retarget(py);
  for (const line of result.replaced) {
    getLogger().info(`Notebook "${files.name}": replaced ${line}`);
  }
  for (const line of result.kept) {
    getLogger().warn(`Notebook "${files.name}": ${line}`);
  }
  if (result.py !== py) {
    await writeNotebookPy(files, result.py);
    getLogger().info(`Notebook "${files.name}": wrote the changed IDs to its local files`);
  }
  return { py: result.py, replaced: result.replaced };
}

export type { BulkOptions, BulkResult, Outcome } from '../items/bulk';

export type UploadOptions = BulkOptions & SendOptions;

/**
 * Downloads notebooks, `options.concurrency` at a time. Local copies are replaced only if `replaceExisting`.
 * One failure (e.g. a Spark SQL or T-SQL notebook, or a name that can't be a folder) doesn't stop the rest.
 */
export async function downloadNotebooks(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  notebooks: readonly NotebookInfo[],
  replaceExisting: boolean,
  options: BulkOptions & DownloadOptions = {},
): Promise<BulkResult> {
  const shared = { ...options, folders: options.folders ?? new WorkspaceFolders(client, workspaceId) };
  return runBulk(notebooks, (n) => n.displayName, options, async (notebook) => {
    const files = await downloadNotebook(client, root, workspaceId, notebook, async () => replaceExisting, shared);
    return files ? { kind: 'done' } : { kind: 'skipped', reason: 'local copy kept' };
  });
}

/**
 * Deletes notebooks from the workspace, `options.concurrency` at a time; one failure doesn't
 * stop the rest. Local files aren't touched. With `root` and `workspaceName`, each deletion
 * is recorded in the history, and the notebook is forgotten in the workspace's sync state,
 * so "Upload Changed" uploads it again.
 */
export function deleteNotebooks(
  client: FabricClient,
  workspaceId: string,
  notebooks: readonly Pick<Notebook, 'id' | 'displayName'>[],
  options: BulkOptions & { root?: vscode.Uri; workspaceName?: string } = {},
): Promise<BulkResult> {
  const { root, workspaceName } = options;
  return deleteItems(client, workspaceId, 'notebook', notebooks, {
    ...options,
    afterDelete: async (name) => {
      if (root && workspaceName) {
        await updateCache(root, workspaceName, name, undefined);
      }
    },
  });
}

/** One notebook ready to upload: its `.py`, its properties, and the notebook it replaces (if any). */
export interface PlannedUpload {
  files: NotebookFiles;
  py: string;
  /** From `<Name>.yaml`; `undefined` leaves Fabric's description as it is. */
  description?: string;
  /** From `<Name>.yaml`: a folder path, `''` for the workspace root; `undefined` leaves the notebook where it is. */
  folder?: string;
  existing: Notebook | undefined;
  /** Where it goes, when `folder` is given (see `Placement`). */
  placement?: Placement;
}

/**
 * Works out what "Upload All" will do: each local notebook's `.py` and whether it replaces
 * a notebook in the workspace or creates one, and in which folder. Notebooks that can't be
 * uploaded are skipped with the reason. The workspace's folders are listed only if a notebook
 * that exists has a `folder` in its `<Name>.yaml`.
 */
export async function planUploads(
  client: FabricClient,
  workspaceId: string,
  local: readonly NotebookFiles[],
): Promise<{ uploads: PlannedUpload[]; skipped: { name: string; reason: string }[] }> {
  // The local files are read while Fabric lists the notebooks.
  const [remote, read] = await Promise.all([
    client.listNotebooks(workspaceId),
    Promise.all(
      local.map(async (files): Promise<Omit<PlannedUpload, 'existing'> | { files: NotebookFiles; reason: string }> => {
        try {
          const [py, description, folder] = await Promise.all([readNotebookPy(files), readNotebookDescription(files), readNotebookFolder(files)]);
          return { files, py, description, folder };
        } catch (err) {
          return { files, reason: err instanceof Error ? err.message : String(err) };
        }
      }),
    ),
  ]);
  const uploads: PlannedUpload[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const folders = new WorkspaceFolders(client, workspaceId);
  for (const r of read) {
    if ('reason' in r) {
      skipped.push({ name: r.files.name, reason: r.reason });
      continue;
    }
    const existing = findByName(remote, r.files.name);
    if (r.folder === undefined) {
      uploads.push({ ...r, existing });
      continue;
    }
    try {
      const from = existing ? await folders.pathOf(existing.folderId) : undefined;
      uploads.push({ ...r, existing, placement: { to: r.folder, from } });
    } catch (err) {
      skipped.push({ name: r.files.name, reason: `couldn't read its folder in Fabric: ${message(err)}` });
    }
  }
  return { uploads, skipped };
}

/** Uploads planned notebooks, `options.concurrency` at a time; one failure doesn't stop the rest. */
export async function runUploads(
  client: FabricClient,
  workspaceId: string,
  uploads: readonly PlannedUpload[],
  options: UploadOptions = {},
): Promise<BulkResult> {
  // Listed again (if needed), rather than taken from the plan: folders may have changed while the user decided.
  const shared = { ...options, folders: options.folders ?? new WorkspaceFolders(client, workspaceId) };
  return runBulk(uploads, (u) => u.files.name, options, async (upload) => {
    await uploadPlanned(client, workspaceId, upload, shared);
    return { kind: 'done' };
  });
}
