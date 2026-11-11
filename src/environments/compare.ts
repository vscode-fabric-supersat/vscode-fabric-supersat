/**
 * Comparing a workspace's environments with `src/Environments`, for the compare commands and
 * "Sync Workspace": fetches every environment (live: there is no environment cache), compares
 * content and properties, records environments found the same in the sync state (and
 * forgets local ones no longer in Fabric), and plans a sync in either direction.
 */
import type * as vscode from 'vscode';
import type { FabricClient } from '../fabric/client';
import { WorkspaceFolders } from '../notebooks/folders';
import { compareItemProperties, type CompareStatus, localName, ONLY_LOCAL, type PropertyComparison } from '../workspace/metadata';
import { forgetItemSync, recordItemSync } from '../workspace/state';
import { findByName } from '../util/names';
import { type ItemComparison, planSync, type SyncDirection, type SyncPlan } from '../workspace/sync';
import { hashEnvironment } from './definition';
import { type LocalEnvironments, localEnvironments } from './files';
import { addEnvironmentFolderPaths, compareEnvironment, fetchEnvironmentSources, type RemoteEnvironment } from './remote';

/** One environment, compared. */
export interface EnvironmentComparison {
  /** The local name if it's local, else Fabric's. */
  name: string;
  status: CompareStatus;
  /** As fetched from Fabric (not for `Only Local`). */
  source?: RemoteEnvironment;
  /** How its description and folder compare with `<Name>.yaml` (for `Same` and `Different`). */
  properties?: PropertyComparison;
}

export interface EnvironmentsCompared {
  comparisons: EnvironmentComparison[];
  local: LocalEnvironments;
  /** Cancelled before every environment was fetched: nothing was recorded. */
  cancelled: boolean;
}

/**
 * Fetches every environment in the workspace and compares each with `src/Environments`
 * (content, then description and folder). Environments found the same are recorded as
 * synced, and local ones not in the workspace are forgotten in its sync state.
 */
export async function compareEnvironments(
  client: FabricClient,
  root: vscode.Uri,
  workspace: { id: string; name: string },
  options: { concurrency?: number; isCancelled?: () => boolean; onProgress?: (name: string, done: number, total: number) => void } = {},
): Promise<EnvironmentsCompared> {
  const [items, local] = await Promise.all([client.listEnvironments(workspace.id), localEnvironments(root)]);
  items.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const sources = await fetchEnvironmentSources(client, workspace.id, items, options);
  if (sources.some((s) => s.cancelled)) {
    return { comparisons: [], local, cancelled: true };
  }
  const folders = new WorkspaceFolders(client, workspace.id);
  await addEnvironmentFolderPaths(sources, (folderId) => folders.pathOf(folderId));
  const comparisons: EnvironmentComparison[] = [];
  for (const source of sources) {
    comparisons.push(await compareFetched(root, workspace.name, source, local));
  }
  const remote = new Set(items.map((i) => i.displayName.toLowerCase()));
  for (const name of local.names.filter((n) => !remote.has(n.toLowerCase()))) {
    await forgetItemSync(root, workspace.name, 'environment', name);
    comparisons.push({ name, status: ONLY_LOCAL });
  }
  return { comparisons, local, cancelled: false };
}

/** Plans a sync of environments from their comparisons (see `planSync`, the same for every kind). */
export function planEnvironmentSync(direction: SyncDirection, comparisons: readonly EnvironmentComparison[]): SyncPlan {
  const items: ItemComparison[] = comparisons.map((c) => ({
    name: c.name,
    status: c.status,
    ...(c.properties ? { properties: c.properties.differences } : {}),
    ...(c.source?.error ? { reason: c.source.error } : {}),
  }));
  const propertyErrors = comparisons.filter((c) => c.properties?.error).map((c) => ({ name: c.name, reason: c.properties!.error! }));
  return { ...planSync(direction, items), propertyErrors };
}

/** Compares one fetched environment with its local copy, recording it as synced if it's the same. */
async function compareFetched(root: vscode.Uri, workspaceName: string, source: RemoteEnvironment, local: LocalEnvironments): Promise<EnvironmentComparison> {
  const found = localName(local, source.environment.displayName);
  const files = found === undefined ? undefined : await local.readFiles(found);
  const status = compareEnvironment(source, files);
  if (status === 'Same' && found !== undefined && files) {
    await recordItemSync(root, workspaceName, 'environment', found, await hashEnvironment(files), 'compare', source.environment.id);
  }
  const properties = status === 'Same' || status === 'Different' ? await compareItemProperties(source.environment.displayName, source.properties, local) : undefined;
  return { name: found ?? source.environment.displayName, status, source, ...(properties ? { properties } : {}) };
}

/**
 * Compares one environment (by local name) with the workspace's, fetching only it. Not in the
 * workspace: `Only Local`, and forgotten in its sync state.
 */
export async function compareOneEnvironment(
  client: FabricClient,
  root: vscode.Uri,
  workspace: { id: string; name: string },
  name: string,
): Promise<EnvironmentComparison> {
  const [items, local] = await Promise.all([client.listEnvironments(workspace.id), localEnvironments(root)]);
  const item = findByName(items, name);
  if (!item) {
    await forgetItemSync(root, workspace.name, 'environment', name);
    return { name, status: ONLY_LOCAL };
  }
  const [source] = await fetchEnvironmentSources(client, workspace.id, [item]);
  const folders = new WorkspaceFolders(client, workspace.id);
  await addEnvironmentFolderPaths([source], (folderId) => folders.pathOf(folderId));
  return compareFetched(root, workspace.name, source, local);
}
