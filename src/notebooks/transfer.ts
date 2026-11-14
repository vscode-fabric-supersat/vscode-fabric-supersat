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
  isNotebookContent,
  NotFabricNotebookError,
  readNotebookDescription,
  readTextIfExists,
  syncNotebookFiles,
  writeNotebookDescription,
  writeNotebookFiles,
  writeNotebookPy,
} from './files';
import { fabricToIpynb, formatFabricPy, ipynbToFabric, isFabricPy, parseFabricPy } from './format';
import { mapLimit } from '../util/concurrency';
import { recordHistory } from '../util/diagnostics';
import { recordSync } from '../workspace/state';
import { type ReferenceMapper, toSameWorkspace, type WorkspaceReferenceKind } from './references';

export interface DownloadOptions {
  /** Which references in this workspace to save as "same workspace" (see `notebooks/references.ts`). */
  sameWorkspace?: Record<WorkspaceReferenceKind, boolean>;
  /** The workspace's name: given, the download is recorded in the history and sync state. */
  workspaceName?: string;
}

export interface SendOptions {
  /** Points the notebook's lakehouses and environment at the workspace's own (see `applyReferences`). */
  references?: ReferenceMapper;
  /** The workspace's name: given, the upload is recorded in the history and sync state. */
  workspaceName?: string;
}

/**
 * Downloads a notebook into its two local files: the `.py` exactly as Fabric's Git format
 * exports it, and the `.ipynb` generated from it (Fabric's cell outputs aren't downloaded;
 * a local `.ipynb`'s outputs are kept for cells whose code is unchanged), and
 * its description into `notebook.yaml` (only if it has one, or the file already exists).
 * If a local copy exists, `confirmReplace` decides whether to overwrite it. `sameWorkspace`
 * says which references in this workspace to save as "same workspace" instead.
 * Returns the files, or `undefined` if the user chose not to replace them.
 */
export async function downloadNotebook(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  notebook: Pick<Notebook, 'id' | 'displayName' | 'description'>,
  confirmReplace: (files: NotebookFiles) => Promise<boolean>,
  options: DownloadOptions = {},
): Promise<NotebookFiles | undefined> {
  const { workspaceName } = options;
  try {
    const result = await downloadOne(client, root, workspaceId, notebook, confirmReplace, options.sameWorkspace);
    if (result && workspaceName) {
      await recordSync(root, workspaceName, result.files.name, result.py, 'download');
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
  notebook: Pick<Notebook, 'id' | 'displayName' | 'description'>,
  confirmReplace: (files: NotebookFiles) => Promise<boolean>,
  sameWorkspace?: Record<WorkspaceReferenceKind, boolean>,
): Promise<{ files: NotebookFiles; py: string } | undefined> {
  checkNotebookName(notebook.displayName);
  const files = notebookFiles(root, notebook.displayName);
  if (((await exists(files.py)) || (await exists(files.ipynb))) && !(await confirmReplace(files))) {
    return undefined;
  }
  // One request: Fabric's Git format. Fabric's cell outputs (only in its .ipynb export)
  // aren't downloaded; the local .ipynb is generated from the .py.
  const gitSource = await client.getNotebookDefinition(workspaceId, notebook.id);
  getLogger().debug(`Notebook "${files.name}" definition files: ${gitSource.parts.map((p) => p.path).join(', ')} (Git format)`);
  for (const content of gitSource.parts.filter((p) => /^notebook-content\.[a-z]+$/i.test(p.path))) {
    const unsupported = unsupportedNotebook(files.name, content.path, new TextDecoder().decode(fromBase64(content.payload)));
    if (unsupported) {
      throw new Error(unsupported);
    }
  }
  const fabricPy = partText(gitSource, '.py');
  const py = sameWorkspace ? toSameWorkspace(fabricPy, workspaceId, sameWorkspace) : fabricPy;
  // Outputs from local runs are kept for cells whose code is unchanged (as saving the .py does).
  const existing = await readTextIfExists(files.ipynb);
  const keep = existing !== undefined && isNotebookContent('ipynb', existing) ? existing : undefined;
  await writeNotebookFiles(files, py, fabricToIpynb(parseFabricPy(py), keep));
  await writeNotebookDescription(files, notebook.description);
  return { files, py };
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
      throw new Error(`Notebook "${files.name}" has no local files to upload.`);
    }
    await syncNotebookFiles(files, 'ipynb');
    py = (await readTextIfExists(files.py)) ?? '';
  }
  if (!isFabricPy(py)) {
    throw new NotFabricNotebookError(files.py, 'py');
  }
  const unsupported = unsupportedNotebook(files.name, FABRIC_PY_PART, py);
  if (unsupported) {
    throw new Error(unsupported);
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
  options: SendOptions = {},
): Promise<'created' | 'updated' | undefined> {
  const py = await readNotebookPy(files);
  const description = await readNotebookDescription(files);
  const existing = findByName(await client.listNotebooks(workspaceId), files.name);
  if (!(await confirm(existing))) {
    return undefined;
  }
  return uploadPrepared(client, workspaceId, { files, py, description, existing }, options);
}

/**
 * Uploads a notebook whose `.py` has been read: points its references at the workspace
 * (writing them to the local files), sends it, and records it in the history and sync state.
 */
async function uploadPrepared(
  client: FabricClient,
  workspaceId: string,
  { files, py, description, existing }: PlannedUpload,
  { references, workspaceName }: SendOptions,
): Promise<'created' | 'updated'> {
  let replaced: string[] = [];
  try {
    const ready = await applyReferences(files, py, references);
    replaced = ready.replaced;
    const result = await sendNotebook(client, workspaceId, files.name, ready.py, existing, description);
    if (workspaceName) {
      await recordSync(files.root, workspaceName, files.name, ready.py, 'upload');
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
  for (const line of result.notes) {
    getLogger().info(`Notebook "${files.name}": ${line}`);
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
  /** Called as each notebook finishes: its name, how many have finished, and how many there are. */
  onProgress?: (name: string, done: number, total: number) => void;
  isCancelled?: () => boolean;
  /** How many notebooks to work on at once (default 1). */
  concurrency?: number;
}

export type UploadOptions = BulkOptions & SendOptions;

type Outcome = { kind: 'done' } | { kind: 'skipped' | 'failed'; reason: string };

/** Runs `task` for each item, `options.concurrency` at a time, and collects a `BulkResult` in the items' order. */
async function runBulk<T>(
  items: readonly T[],
  nameOf: (item: T) => string,
  options: BulkOptions,
  task: (item: T) => Promise<Outcome>,
): Promise<BulkResult> {
  let finished = 0;
  const outcomes = await mapLimit(
    items,
    options.concurrency ?? 1,
    async (item) => {
      let outcome: Outcome;
      try {
        outcome = await task(item);
      } catch (err) {
        outcome = { kind: 'failed', reason: message(err) };
      }
      options.onProgress?.(nameOf(item), ++finished, items.length);
      return outcome;
    },
    () => options.isCancelled?.() ?? false,
  );
  const result: BulkResult = { done: [], skipped: [], failed: [], cancelled: false };
  outcomes.forEach((outcome, index) => {
    const name = nameOf(items[index]);
    if (!outcome) {
      result.cancelled = true;
    } else if (outcome.kind === 'done') {
      result.done.push(name);
    } else {
      result[outcome.kind].push({ name, reason: outcome.reason });
    }
  });
  return result;
}

/**
 * Downloads notebooks, `options.concurrency` at a time. Local copies are replaced only if `replaceExisting`.
 * One failure (e.g. a Spark SQL or T-SQL notebook, or a name that can't be a folder) doesn't stop the rest.
 */
export async function downloadNotebooks(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  notebooks: readonly Pick<Notebook, 'id' | 'displayName' | 'description'>[],
  replaceExisting: boolean,
  options: BulkOptions & DownloadOptions = {},
): Promise<BulkResult> {
  return runBulk(notebooks, (n) => n.displayName, options, async (notebook) => {
    const files = await downloadNotebook(client, root, workspaceId, notebook, async () => replaceExisting, options);
    return files ? { kind: 'done' } : { kind: 'skipped', reason: 'local copy kept' };
  });
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

/** Uploads planned notebooks, `options.concurrency` at a time; one failure doesn't stop the rest. */
export async function runUploads(
  client: FabricClient,
  workspaceId: string,
  uploads: readonly PlannedUpload[],
  options: UploadOptions = {},
): Promise<BulkResult> {
  return runBulk(uploads, (u) => u.files.name, options, async (upload) => {
    await uploadPrepared(client, workspaceId, upload, options);
    return { kind: 'done' };
  });
}

/**
 * Notebook languages, as opposed to cell languages. Only PySpark and Python notebooks are
 * supported; SQL cells inside them are (Spark SQL `%%sql` in PySpark, T-SQL `%%tsql` in Python).
 *
 * - **Spark SQL** notebooks run Spark SQL on a Spark cluster, and Fabric stores them as
 *   `notebook-content.sql` (documented, like `.scala` for Scala and `.r` for SparkR).
 * - **T-SQL** notebooks run T-SQL on a warehouse or SQL analytics endpoint. Their kernel is
 *   `sqldatawarehouse` (seen in a real export, 2026-11); Microsoft doesn't document which
 *   Git-format file Fabric stores them in, so they are recognised by that kernel instead.
 */
const TSQL_NOTEBOOK = {
  label: 'T-SQL',
  runs: 'T-SQL on a warehouse or SQL analytics endpoint',
  cells: 'T-SQL cells (%%tsql) in a Python notebook are supported.',
};

const UNSUPPORTED_BY_EXTENSION: Record<string, { label: string; runs: string; cells: string }> = {
  sql: {
    label: 'Spark SQL',
    runs: 'Spark SQL on a Spark cluster',
    cells: 'Spark SQL cells (%%sql) in a PySpark notebook are supported.',
  },
  scala: { label: 'Scala', runs: 'Scala on a Spark cluster', cells: '' },
  r: { label: 'SparkR', runs: 'R on a Spark cluster', cells: '' },
} as const;

/** Supported notebooks' language as an .ipynb names it (`microsoft.language`, else `language_info.name`). */
const IPYNB_LANGUAGES: Record<string, string> = { sparksql: 'Spark SQL', sql: 'Spark SQL', scala: 'Scala', r: 'SparkR' };

/**
 * The notebook language an `.ipynb` export declares: T-SQL (its kernel), PySpark or
 * Python (Python code, on the Spark or Jupyter kernel), Spark SQL, Scala, SparkR, or the
 * declared name if it's something else.
 */
export function ipynbLanguage(text: string): string {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { metadata?: Record<string, unknown> };
    metadata = parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {};
  } catch {
    // Not JSON: the caller's format checks report it.
  }
  const field = (owner: unknown, key: string) =>
    owner && typeof owner === 'object' && typeof (owner as Record<string, unknown>)[key] === 'string'
      ? ((owner as Record<string, unknown>)[key] as string)
      : undefined;
  const kernel = field(metadata.kernel_info, 'name');
  if (kernel === 'sqldatawarehouse') {
    return 'T-SQL';
  }
  const language = (field(metadata.microsoft, 'language') ?? field(metadata.language_info, 'name'))?.toLowerCase();
  if (language === undefined || language === 'python') {
    return kernel === 'jupyter' ? 'Python' : 'PySpark';
  }
  return IPYNB_LANGUAGES[language] ?? language;
}

/** Why a notebook can't be downloaded, from its `.ipynb` export, or `undefined` if it's a PySpark or Python notebook. */
export function unsupportedIpynb(name: string, text: string): string | undefined {
  const language = ipynbLanguage(text);
  if (language === 'PySpark' || language === 'Python') {
    return undefined;
  }
  const kind = language === 'T-SQL' ? TSQL_NOTEBOOK : Object.values(UNSUPPORTED_BY_EXTENSION).find((k) => k.label === language);
  return kind
    ? unsupportedMessage(name, kind)
    : `"${name}" is a ${language} notebook. Only PySpark and Python notebooks are supported.`;
}

/** The `.py` (Fabric's Git format) for an `.ipynb` export, as download writes it. */
export function pyFromIpynb(text: string): string {
  return formatFabricPy(ipynbToFabric(text));
}

function unsupportedMessage(name: string, kind: { label: string; runs: string; cells: string }, path?: string): string {
  return (
    `"${name}" is a ${kind.label} notebook (${path ? `${path}; ` : ''}it runs ${kind.runs}). ${kind.label} notebooks aren't supported yet, ` +
    `only PySpark and Python notebooks. ${kind.cells}`
  ).trimEnd();
}

/** A T-SQL notebook's kernel, in a Git-format header (any comment prefix) or an .ipynb. */
const TSQL_KERNEL = /"kernel_info"\s*:\s*\{[^}]*"name"\s*:\s*"sqldatawarehouse"/;

/** Whether a notebook file (Git format, or .ipynb) is a T-SQL notebook. */
export function isTsqlNotebook(text: string): boolean {
  // Git-format header lines are prefixed per language (`# META`, `-- META`): drop the prefixes.
  return TSQL_KERNEL.test(text.replace(/^\s*(#|--|\/\/)\s*META ?/gm, ''));
}

/**
 * Why a notebook can't be downloaded or uploaded, from one of its Git-format files
 * (`notebook-content.<ext>`), or `undefined` if it's a PySpark or Python notebook.
 * `tsql` says it is already known to be a T-SQL notebook (from its .ipynb export).
 */
export function unsupportedNotebook(name: string, path: string, text: string, tsql = false): string | undefined {
  const extension = path.split('.').pop()!.toLowerCase();
  const kind = tsql || isTsqlNotebook(text) ? TSQL_NOTEBOOK : UNSUPPORTED_BY_EXTENSION[extension];
  return kind && unsupportedMessage(name, kind, path);
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
