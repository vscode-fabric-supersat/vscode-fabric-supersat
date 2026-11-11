/**
 * Downloading environments (by name) from the Fabric API into `src/Environments/<Name>/`,
 * and uploading them back (to Fabric's saved state; publishing is separate, see `publish.ts`).
 */
import type * as vscode from 'vscode';
import type { FabricClient, Item, ItemDefinition, JsonRecord } from '../fabric/client';
import { sameFolderId, sameFolderPath, WorkspaceFolders } from '../notebooks/folders';
import { readItemProperties, writePropertiesFile } from '../notebooks/files';
import { type BulkOptions, type BulkResult, runBulk } from '../items/bulk';
import { exists } from '../util/localState';
import { recordHistory } from '../util/diagnostics';
import { ActionNeededError, isWarning } from '../util/errorFix';
import { findByName } from '../util/names';
import { getLogger } from '../util/logger';
import {
  contentFiles,
  definitionFromFiles,
  differentParts,
  filesFromDefinition,
  hashEnvironment,
  instancePoolId,
  PART_FOLDERS,
  undocumentedParts,
  uploadDefinition,
} from './definition';
import { recordItemSync } from '../workspace/state';
import {
  checkEnvironmentName,
  type EnvironmentFiles,
  environmentFiles,
  NEW_ENVIRONMENT_PROPERTIES_FILE,
  readEnvironmentFiles,
  writeEnvironmentFiles,
} from './files';

/** An environment item as listed in a workspace. */
export type EnvironmentInfo = Pick<Item, 'id' | 'displayName' | 'description' | 'folderId'>;

export interface EnvironmentDownloadOptions {
  /** The workspace's folders, shared by a bulk download so they're listed once. */
  folders?: WorkspaceFolders;
  /** The workspace's name: given, the download is recorded in its sync state. */
  workspaceName?: string;
}

/**
 * Downloads an environment: each part of its definition into `src/Environments/<Name>/` byte
 * for byte, and its description and folder into `<Name>.yaml`. Then reads the files back and
 * checks they give exactly Fabric's definition (throws if not, so a format problem shows at
 * once, not at a later upload). If a local copy exists, `confirmReplace` decides whether to
 * overwrite it. Returns the files, or `undefined` if the user chose not to replace them.
 */
export async function downloadEnvironment(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  environment: EnvironmentInfo,
  confirmReplace: (files: EnvironmentFiles) => Promise<boolean>,
  options: EnvironmentDownloadOptions = {},
): Promise<EnvironmentFiles | undefined> {
  checkEnvironmentName(environment.displayName);
  const files = environmentFiles(root, environment.displayName);
  if ((await exists(files.folder)) && !(await confirmReplace(files))) {
    return undefined;
  }
  const definition = await client.getEnvironmentDefinition(workspaceId, environment.id);
  const log = getLogger();
  log.debug(`Environment "${files.name}" definition files: ${definition.parts.map((p) => p.path).join(', ') || 'none'}`);
  const undocumented = undocumentedParts(definition);
  if (undocumented.length) {
    log.warn(`Environment "${files.name}": kept parts Microsoft doesn't document: ${undocumented.join(', ')}`);
  }
  const deleted = await writeEnvironmentFiles(files, filesFromDefinition(files.name, definition));
  if (deleted.length) {
    log.info(`Environment "${files.name}": deleted local files no longer in Fabric: ${deleted.join(', ')}`);
  }
  // Files outside the part folders that Fabric didn't send (e.g. your notes) aren't part of the definition: named, not checked.
  const paths = new Set(definition.parts.map((p) => p.path));
  const [local, others] = partition(await readEnvironmentFiles(files), (f) => paths.has(f.path) || PART_FOLDERS.includes(f.path.split('/')[0]));
  if (others.length) {
    log.info(`Environment "${files.name}": not part of its definition in Fabric: ${others.map((f) => f.path).join(', ')}`);
  }
  const different = differentParts(definition, definitionFromFiles(local));
  if (different.length) {
    throw new Error(`Environment "${files.name}": the downloaded files don't give back Fabric's definition exactly (${different.join(', ')}).`);
  }
  if (options.workspaceName) {
    await recordItemSync(root, options.workspaceName, 'environment', files.name, await hashEnvironment(local), 'download', environment.id);
  }
  const folders = options.folders ?? new WorkspaceFolders(client, workspaceId);
  let folder: string | undefined;
  try {
    folder = await folders.pathOf(environment.folderId);
  } catch (err) {
    log.warn(`Environment "${files.name}": couldn't read its folder in Fabric, so ${files.name}.yaml's folder was left as it is`, err);
  }
  await writePropertiesFile(root, files.properties, { description: environment.description, folder }, NEW_ENVIRONMENT_PROPERTIES_FILE);
  return files;
}

/**
 * Downloads environments, `options.concurrency` at a time. Local copies are replaced only if
 * `replaceExisting`. One failure doesn't stop the rest.
 */
export function downloadEnvironments(
  client: FabricClient,
  root: vscode.Uri,
  workspaceId: string,
  environments: readonly EnvironmentInfo[],
  replaceExisting: boolean,
  options: BulkOptions & EnvironmentDownloadOptions = {},
): Promise<BulkResult> {
  const shared = { folders: options.folders ?? new WorkspaceFolders(client, workspaceId), workspaceName: options.workspaceName };
  return runBulk(environments, (e) => e.displayName, options, async (environment) => {
    const files = await downloadEnvironment(client, root, workspaceId, environment, async () => replaceExisting, shared);
    return files ? { kind: 'done' } : { kind: 'skipped', reason: 'local copy kept' };
  });
}

/** Splits items by a test: those that pass, then the rest. */
function partition<T>(items: readonly T[], test: (item: T) => boolean): [T[], T[]] {
  return [items.filter(test), items.filter((i) => !test(i))];
}

/** One environment ready to upload: what it sends, and the environment it replaces (if any). */
export interface PlannedEnvironmentUpload {
  files: EnvironmentFiles;
  definition: ItemDefinition;
  /** Its content hash, recorded in the sync state once uploaded (see `hashEnvironment`). */
  hash: string;
  /** From `<Name>.yaml`; `undefined` leaves Fabric's description as it is. */
  description?: string;
  /** From `<Name>.yaml`: a folder path, `''` for the workspace root; `undefined` leaves it where it is. */
  folder?: string;
  /** The environment of the same name in the workspace, if there is one. */
  existing?: EnvironmentInfo;
  /** For an existing environment `<Name>.yaml` puts in another folder: where it is, and where it goes (`''` for the root). */
  moves?: { from: string; to: string };
  /** A warning for the confirmation, e.g. a pool that isn't in the workspace. */
  warning?: string;
}

/** Planning an upload: the environments it would overwrite or create, and those it can't upload, with why. */
export interface EnvironmentUploadPlan {
  uploads: PlannedEnvironmentUpload[];
  skipped: { name: string; reason: string }[];
}

/**
 * Reads each environment to upload and finds the one it replaces in the workspace (by name),
 * without changing anything. An environment that can't be uploaded (e.g. no files under
 * `Setting/` or `Libraries/`, an invalid `<Name>.yaml`, or a name that can't be a folder) is
 * skipped with the reason; anything unexpected throws.
 */
export async function planEnvironmentUploads(
  client: FabricClient,
  workspaceId: string,
  environments: readonly EnvironmentFiles[],
): Promise<EnvironmentUploadPlan> {
  const items = await client.listEnvironments(workspaceId);
  const pools = await client.listWorkspacePools(workspaceId).catch((err: unknown) => {
    getLogger().warn('Couldn\'t list the workspace\'s Spark pools, so environments\' pools weren\'t checked', err);
    return undefined;
  });
  const plan: EnvironmentUploadPlan = { uploads: [], skipped: [] };
  const folders = new WorkspaceFolders(client, workspaceId);
  for (const files of environments) {
    try {
      plan.uploads.push(await planOne(files, items, pools, folders));
    } catch (err) {
      if (!isWarning(err)) {
        throw err;
      }
      plan.skipped.push({ name: files.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return plan;
}

async function planOne(
  files: EnvironmentFiles,
  items: readonly Item[],
  pools: readonly JsonRecord[] | undefined,
  folders: WorkspaceFolders,
): Promise<PlannedEnvironmentUpload> {
  checkEnvironmentName(files.name);
  const local = contentFiles(await readEnvironmentFiles(files));
  if (!local.length) {
    throw new ActionNeededError(
      `Environment "${files.name}" has nothing to upload: no files under ${files.name}/Setting/ or ${files.name}/Libraries/. Download it from Fabric first, or add its Setting/Sparkcompute.yml.`,
    );
  }
  const { description, folder } = await readItemProperties(files);
  const poolId = instancePoolId(local);
  const known = pools?.some((p) => typeof p.id === 'string' && p.id.toLowerCase() === poolId?.toLowerCase());
  const warning =
    poolId && pools && !known
      ? `its Spark pool (instance_pool_id ${poolId}) isn't one of the workspace's custom pools: it may be a capacity pool, or another workspace's. It's uploaded as it is.`
      : undefined;
  const existing = findByName(items, files.name);
  // Where an existing environment is now, to say whether it moves (unknown if Fabric's folders can't be read: upload then moves it if needed).
  const from = existing && folder !== undefined ? await folders.pathOf(existing.folderId).catch(() => undefined) : undefined;
  const moves = from !== undefined && folder !== undefined && !sameFolderPath(from, folder) ? { from, to: folder } : undefined;
  return {
    files,
    definition: uploadDefinition(local),
    hash: await hashEnvironment(local),
    ...(description !== undefined ? { description } : {}),
    ...(folder !== undefined ? { folder } : {}),
    ...(existing ? { existing } : {}),
    ...(moves ? { moves } : {}),
    ...(warning ? { warning } : {}),
  };
}

/** What uploading one environment did, and its ID (for publishing it). */
export interface EnvironmentUploadResult {
  result: 'created' | 'updated';
  id: string | undefined;
}

/**
 * Uploads a planned environment: replaces the existing one's definition (or creates it, in
 * the folder `<Name>.yaml` names), sets its description and moves it as `<Name>.yaml` says,
 * and records it in the sync state and history. The upload is Fabric's saved state of the
 * environment: it takes effect once published (see `publishEnvironment` in the client).
 */
export async function uploadEnvironment(
  client: FabricClient,
  workspaceId: string,
  upload: PlannedEnvironmentUpload,
  options: EnvironmentDownloadOptions = {},
): Promise<EnvironmentUploadResult> {
  const { files, definition, description, folder, existing } = upload;
  const { workspaceName } = options;
  const folders = options.folders ?? new WorkspaceFolders(client, workspaceId);
  try {
    // The folder first: one that can't be created stops the upload before anything changes.
    const folderId = folder === undefined ? undefined : await folders.ensure(folder);
    let result: EnvironmentUploadResult;
    if (existing) {
      await client.updateEnvironmentDefinition(workspaceId, existing.id, definition);
      if (description !== undefined && description !== (existing.description ?? '')) {
        await client.updateItem(workspaceId, 'environment', existing.id, { description });
      }
      if (folder !== undefined && !sameFolderId(existing.folderId, folderId)) {
        await client.moveItem(workspaceId, existing.id, folderId);
      }
      result = { result: 'updated', id: existing.id };
    } else {
      const created = await client.createEnvironment(workspaceId, files.name, definition, description || undefined, folderId);
      result = { result: 'created', id: created?.id };
    }
    if (workspaceName) {
      await recordItemSync(files.root, workspaceName, 'environment', files.name, upload.hash, 'upload', result.id);
      recordHistory({ action: 'upload', notebook: files.name, kind: 'environment', workspace: workspaceName, result: result.result });
    }
    return result;
  } catch (err) {
    if (workspaceName) {
      recordHistory({
        action: 'upload',
        notebook: files.name,
        kind: 'environment',
        workspace: workspaceName,
        result: 'failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    throw err;
  }
}

/** Uploads planned environments, `options.concurrency` at a time; one failure doesn't stop the rest. Returns the IDs of those uploaded, by name. */
export async function uploadEnvironments(
  client: FabricClient,
  workspaceId: string,
  uploads: readonly PlannedEnvironmentUpload[],
  options: BulkOptions & EnvironmentDownloadOptions = {},
): Promise<BulkResult & { ids: Map<string, string> }> {
  const shared = { folders: options.folders ?? new WorkspaceFolders(client, workspaceId), workspaceName: options.workspaceName };
  const ids = new Map<string, string>();
  const result = await runBulk(uploads, (u) => u.files.name, options, async (upload) => {
    const { id } = await uploadEnvironment(client, workspaceId, upload, shared);
    if (id) {
      ids.set(upload.files.name, id);
    }
    return { kind: 'done' };
  });
  return { ...result, ids };
}
