/**
 * Environment commands beyond download and upload: "Compare Environment with Workspace",
 * "Compare All Environments with Workspace", "Create New Environment" and "Delete Environment".
 * Comparisons fetch environments live (there is no environment cache, see
 * `src/environments/remote.ts`).
 */
import * as vscode from 'vscode';
import { Commands } from '../constants';
import { compareEnvironments, compareOneEnvironment, type EnvironmentComparison } from '../environments/compare';
import { changedFiles, contentFiles, type EnvironmentFile, isTextPart, NEW_ENVIRONMENT_SPARK_COMPUTE, SPARK_COMPUTE_PART } from '../environments/definition';
import {
  checkEnvironmentName,
  type EnvironmentFiles,
  environmentFiles,
  environmentFilesFor,
  listLocalEnvironments,
  NEW_ENVIRONMENT_PROPERTIES_FILE,
  readEnvironmentFiles,
} from '../environments/files';
import type { FabricClient } from '../fabric/client';
import { BULK_CONCURRENCY } from '../fabric/requestLimiter';
import { deleteItems } from '../items/delete';
import { propertiesText, readTextIfExists } from '../notebooks/files';
import { registerCommand } from '../util/commands';
import { ActionNeededError } from '../util/errorFix';
import { reportError } from '../util/errors';
import { folderNameProblem } from '../util/folderNames';
import { assertSafeWritePath, exists, requireProjectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { withProgress } from '../util/progress';
import { findByName } from '../util/names';
import { describePropertyDifferences, ONLY_LOCAL, type CompareStatus } from '../workspace/metadata';
import type { ResolvedWorkspace } from '../workspace/service';
import type { Feature } from './feature';
import { type DeleteScope, deleteScopes, tabUri } from './notebooks';
import { PROPERTIES_BUTTON, remoteDocuments, withCancellableProgress } from './workspaceTools';

export const environmentTools: Feature = {
  name: 'environmentTools',
  activate(context, { fabric, workspace: selected }) {
    context.subscriptions.push(
      registerCommand(Commands.compareEnvironmentWithWorkspace, 'Compare Environment with Workspace', async (arg?: unknown) => {
        try {
          const root = requireProjectRoot('compare environments in');
          const files = await environmentFor(root, arg, 'Compare');
          if (!files) {
            return undefined;
          }
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const compared = await withProgress(`Comparing "${files.name}" with ${workspace.name}…`, () => compareOneEnvironment(fabric, root, workspace, files.name));
          const { status, properties } = compared;
          const note = properties && describePropertyDifferences(properties);
          if (status === 'Same' && !note) {
            void vscode.window.showInformationMessage(`"${files.name}" is the same in src/Environments and ${workspace.name}, description and folder included.`);
          } else if (status === ONLY_LOCAL) {
            void vscode.window.showInformationMessage(`"${files.name}" isn't in ${workspace.name}. Upload it with Upload Environment.`);
          } else if (status === 'Not Fetched') {
            void vscode.window.showWarningMessage(`"${files.name}" couldn't be fetched from ${workspace.name}: ${compared.source?.error ?? 'unknown error'}`);
          } else {
            await openEnvironmentComparison(root, workspace, compared);
          }
          return status;
        } catch (err) {
          await reportError('Compare Environment with Workspace', err);
          return undefined;
        }
      }),

      registerCommand(Commands.compareAllEnvironmentsWithWorkspace, 'Compare All Environments with Workspace', async () => {
        try {
          const root = requireProjectRoot('compare environments in');
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const compared = await withCancellableProgress(`Comparing src/Environments with ${workspace.name}`, (report, isCancelled) =>
            compareEnvironments(fabric, root, workspace, {
              concurrency: BULK_CONCURRENCY,
              isCancelled,
              onProgress: (name, done, total) => report(`${done}/${total} fetched (${name})`),
            }),
          );
          if (compared.cancelled) {
            void vscode.window.showInformationMessage('Compare All Environments with Workspace cancelled. Nothing was changed.');
            return undefined;
          }
          if (!compared.comparisons.length) {
            void vscode.window.showInformationMessage(`No environments in src/Environments or ${workspace.name}.`);
            return compared.comparisons;
          }
          showComparisons(root, workspace, compared.comparisons);
          return compared.comparisons;
        } catch (err) {
          await reportError('Compare All Environments with Workspace', err);
          return undefined;
        }
      }),

      registerCommand(Commands.newEnvironment, 'Create New Environment', async (name?: string) => {
        try {
          const root = requireProjectRoot('create environments in');
          const chosen =
            name ??
            (await vscode.window.showInputBox({
              title: 'Create New Environment',
              prompt: 'Name of the environment (its folder in src/Environments, and its name in Fabric when uploaded)',
              validateInput: async (value) => {
                const problem = value ? folderNameProblem(value) : 'is empty';
                if (problem) {
                  return `The name ${problem}.`;
                }
                return (await exists(environmentFiles(root, value).folder)) ? `src/Environments/${value} already exists.` : undefined;
              },
            }));
          if (!chosen) {
            return undefined;
          }
          return await createEnvironment(root, chosen);
        } catch (err) {
          await reportError('Create New Environment', err);
          return undefined;
        }
      }),

      registerCommand(Commands.deleteEnvironment, 'Delete Environment', async (arg?: unknown) => {
        try {
          const root = requireProjectRoot('delete environments in');
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const remote = await withProgress('Loading environments…', () => fabric.listEnvironments(workspace.id));
          const files = await environmentFor(root, arg, 'Delete', remote.map((e) => e.displayName));
          if (!files) {
            return undefined;
          }
          const inFabric = findByName(remote, files.name);
          const scope = await confirmDelete(files, workspace, await exists(files.folder), !!inFabric);
          if (!scope) {
            return undefined;
          }
          return await deleteEnvironment(fabric, root, workspace, files, inFabric, scope);
        } catch (err) {
          await reportError('Delete Environment', err);
          return undefined;
        }
      }),
    );
  },
};

/**
 * The environment a command works on: the one `arg` (an Explorer or editor URI) or the active
 * editor is in, or one picked from `src/Environments` (and `remoteNames`, if given).
 */
async function environmentFor(root: vscode.Uri, arg: unknown, verb: string, remoteNames: readonly string[] = []): Promise<EnvironmentFiles | undefined> {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  const found = uri && environmentFilesFor(root, uri);
  if (found) {
    return found;
  }
  const local = (await listLocalEnvironments(root)).map((e) => e.name);
  const names = [...local, ...remoteNames.filter((r) => !local.some((l) => l.toLowerCase() === r.toLowerCase()))].sort((a, b) => a.localeCompare(b));
  if (!names.length) {
    void vscode.window.showInformationMessage('No environments in src/Environments' + (remoteNames.length ? '' : ' (download one first)') + '.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    names.map((name) => ({ label: name, description: local.includes(name) ? (remoteNames.length && !remoteNames.some((r) => r.toLowerCase() === name.toLowerCase()) ? 'local only' : '') : 'only in Fabric' })),
    { title: `${verb} an Environment` },
  );
  return picked && environmentFiles(root, picked.label);
}

const STATUS_ORDER: CompareStatus[] = ['Different', 'Only in Fabric', ONLY_LOCAL, 'Not Supported', 'Not Fetched', 'Same'];
const STATUS_ICONS: Record<CompareStatus, string> = {
  Different: '$(diff)',
  'Only in Fabric': '$(cloud)',
  [ONLY_LOCAL]: '$(file)',
  'Not Supported': '$(circle-slash)',
  'Not Fetched': '$(warning)',
  Same: '$(check)',
};

interface ComparisonItem extends vscode.QuickPickItem {
  comparison: EnvironmentComparison;
}

/** Lists every environment's status, differences first; picking one opens its comparison. Stays open while you look. */
function showComparisons(root: vscode.Uri, workspace: ResolvedWorkspace, comparisons: readonly EnvironmentComparison[]): void {
  const sorted = [...comparisons].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));
  const items: ComparisonItem[] = sorted.map((comparison) => {
    const note = comparison.properties ? describePropertyDifferences(comparison.properties) : '';
    return {
      label: `${STATUS_ICONS[comparison.status]} ${comparison.name}`,
      description: `${comparison.status}${note ? ` · ${note}` : ''}${comparison.source?.error ? ` · ${comparison.source.error}` : ''}`,
      buttons: comparison.properties?.differences.length ? [PROPERTIES_BUTTON] : [],
      comparison,
    };
  });
  const picker = vscode.window.createQuickPick<ComparisonItem>();
  picker.title = `Fabric: Compare All Environments (src/Environments ↔ ${workspace.name})`;
  picker.placeholder = 'Pick one to see its differences (Fabric on the left). Fetched just now.';
  picker.items = items;
  picker.ignoreFocusOut = true;
  picker.matchOnDescription = true;
  picker.onDidAccept(() => {
    const [item] = picker.selectedItems;
    if (item) {
      void openEnvironmentComparison(root, workspace, item.comparison);
    }
  });
  picker.onDidTriggerItemButton(({ item }) => void openPropertiesComparison(root, workspace, item.comparison));
  picker.onDidHide(() => picker.dispose());
  picker.show();
}

/**
 * Opens an environment's comparison: for content that differs (or is only in Fabric), the file
 * picked from those that differ, Fabric's on the left (read-only); for a binary file, its sizes.
 * Only local: reveals its folder. The same content: its properties.
 */
export async function openEnvironmentComparison(root: vscode.Uri, workspace: ResolvedWorkspace, comparison: EnvironmentComparison): Promise<void> {
  try {
    const files = environmentFiles(root, comparison.name);
    if (comparison.status === ONLY_LOCAL || comparison.status === 'Not Fetched') {
      await vscode.commands.executeCommand('revealInExplorer', files.folder);
      return;
    }
    if (comparison.status === 'Same') {
      await openPropertiesComparison(root, workspace, comparison);
      return;
    }
    const fabric = comparison.source?.files ?? [];
    const local = comparison.status === 'Only in Fabric' ? [] : await readLocalContent(files);
    const paths = comparison.status === 'Only in Fabric' ? fabric.map((f) => f.path) : changedFiles(fabric, local);
    const picked =
      paths.length === 1
        ? paths[0]
        : (
            await vscode.window.showQuickPick(
              paths.map((path) => ({ label: path, description: describeFileChange(path, fabric, local) })),
              { title: `"${comparison.name}": files that differ from ${workspace.name}` },
            )
          )?.label;
    if (!picked) {
      return;
    }
    await openFileComparison(workspace, files, picked, fabric, local);
  } catch (err) {
    await reportError(`Compare "${comparison.name}"`, err);
  }
}

async function readLocalContent(files: EnvironmentFiles): Promise<EnvironmentFile[]> {
  return contentFiles(await readEnvironmentFiles(files));
}

function describeFileChange(path: string, fabric: readonly EnvironmentFile[], local: readonly EnvironmentFile[]): string {
  const inFabric = fabric.some((f) => f.path === path);
  const isLocal = local.some((f) => f.path === path);
  return !isLocal ? 'only in Fabric' : !inFabric ? 'only local' : isTextPart(path) ? 'differs' : 'differs (binary)';
}

async function openFileComparison(
  workspace: ResolvedWorkspace,
  files: EnvironmentFiles,
  path: string,
  fabric: readonly EnvironmentFile[],
  local: readonly EnvironmentFile[],
): Promise<void> {
  const remote = fabric.find((f) => f.path === path);
  const mine = local.find((f) => f.path === path);
  if (!isTextPart(path)) {
    const size = (f: EnvironmentFile | undefined) => (f ? `${f.bytes.length} bytes` : 'none');
    void vscode.window.showInformationMessage(`${files.name}/${path} is a binary file: ${workspace.name}'s is ${size(remote)}, yours is ${size(mine)}.`);
    return;
  }
  const text = (f: EnvironmentFile | undefined) => (f ? new TextDecoder().decode(f.bytes) : '');
  const left = remoteDocuments.set(workspace, `${files.name}/${path}`, path, text(remote));
  const right = mine ? vscode.Uri.joinPath(files.folder, ...path.split('/')) : remoteDocuments.set(workspace, `${files.name}/${path} (no local file)`, path, '');
  await vscode.commands.executeCommand('vscode.diff', left, right, `${files.name}/${path}: ${workspace.name} ↔ src/Environments`, {
    preview: true,
    preserveFocus: true,
  });
}

/** Opens a diff of an environment's `<Name>.yaml`: as downloading would write it (left), and yours (right). */
export async function openPropertiesComparison(root: vscode.Uri, workspace: ResolvedWorkspace, comparison: EnvironmentComparison): Promise<void> {
  try {
    const properties = comparison.source?.properties;
    if (!properties) {
      void vscode.window.showInformationMessage(`"${comparison.name}" is the same in src/Environments and ${workspace.name}.`);
      return;
    }
    const files = environmentFiles(root, comparison.name);
    const existing = await readTextIfExists(files.properties);
    const fabricText = propertiesText(files.properties, existing, properties, NEW_ENVIRONMENT_PROPERTIES_FILE) ?? '';
    const left = remoteDocuments.set(workspace, `${comparison.name} environment`, `${comparison.name}.yaml`, fabricText);
    const right = existing === undefined ? remoteDocuments.set(workspace, `${comparison.name} (no local file)`, `${comparison.name}.yaml`, '') : files.properties;
    await vscode.commands.executeCommand('vscode.diff', left, right, `${comparison.name}/${comparison.name}.yaml: ${workspace.name} ↔ src/Environments`, {
      preview: true,
      preserveFocus: true,
    });
  } catch (err) {
    await reportError(`Compare "${comparison.name}" ${comparison.name}.yaml`, err);
  }
}

/** Creates `src/Environments/<Name>/Setting/Sparkcompute.yml` (see `NEW_ENVIRONMENT_SPARK_COMPUTE`) and opens it. Nothing changes in Fabric until it's uploaded. */
export async function createEnvironment(root: vscode.Uri, name: string): Promise<EnvironmentFiles> {
  checkEnvironmentName(name);
  const files = environmentFiles(root, name);
  if (await exists(files.folder)) {
    throw new ActionNeededError(`Environment "${name}" already exists: src/Environments/${name}.`);
  }
  const settings = vscode.Uri.joinPath(files.folder, ...SPARK_COMPUTE_PART.split('/'));
  await assertSafeWritePath(root, settings);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(settings, '..'));
  await vscode.workspace.fs.writeFile(settings, new TextEncoder().encode(NEW_ENVIRONMENT_SPARK_COMPUTE));
  getLogger().info(`Created environment "${name}" in src/Environments`);
  await vscode.commands.executeCommand('vscode.open', settings);
  return files;
}

async function confirmDelete(files: EnvironmentFiles, workspace: ResolvedWorkspace, local: boolean, remote: boolean): Promise<DeleteScope | undefined> {
  const scopes = deleteScopes(local, remote);
  if (!scopes.length) {
    void vscode.window.showInformationMessage(`Environment "${files.name}" isn't in src/Environments or ${workspace.name}.`);
    return undefined;
  }
  const detail = [
    local
      ? `Local: deletes ${vscode.workspace.asRelativePath(files.folder)}/ (with everything in it), moved to the trash where possible. Source control can restore committed files.`
      : 'It has no local files.',
    remote
      ? `Workspace: deletes it in ${workspace.name}, for everyone using the workspace. Notebooks that use it lose its settings and libraries. Fabric keeps it in the workspace's recycle bin only if it has one turned on.`
      : `It isn't in ${workspace.name}.`,
  ].join('\n\n');
  return vscode.window.showWarningMessage(`Delete environment "${files.name}"?`, { modal: true, detail }, ...scopes);
}

/** Deletes an environment where `scope` says: in the workspace first (if Fabric refuses, the local files are left alone), then its local folder. */
export async function deleteEnvironment(
  fabric: FabricClient,
  root: vscode.Uri,
  workspace: { id: string; name: string },
  files: EnvironmentFiles,
  remote: { id: string; displayName: string } | undefined,
  scope: DeleteScope,
): Promise<{ failed?: string; deletedFolder?: vscode.Uri }> {
  if (scope !== 'Workspace Only') {
    const dirty = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.toString().startsWith(`${files.folder.toString()}/`));
    if (dirty) {
      throw new ActionNeededError(`${vscode.workspace.asRelativePath(dirty.uri)} has unsaved changes. Save or revert it first.`);
    }
  }
  if (scope !== 'Local Only' && remote) {
    const result = await deleteItems(fabric, workspace.id, 'environment', [remote], { root, workspaceName: workspace.name });
    const failed = [...result.failed, ...result.skipped][0];
    if (failed) {
      void vscode.window.showWarningMessage(`Environment "${files.name}" wasn't deleted in ${workspace.name}: ${failed.reason}`);
      return { failed: failed.reason };
    }
  }
  const deletedFolder = scope !== 'Workspace Only' ? await deleteLocalEnvironment(root, files) : undefined;
  const where = scope === 'Both' ? `in ${workspace.name} and locally` : scope === 'Local Only' ? 'locally' : `in ${workspace.name}`;
  getLogger().info(`Deleted environment "${files.name}" ${where}`);
  void vscode.window.showInformationMessage(`Deleted environment "${files.name}" ${where}.`);
  return { ...(deletedFolder ? { deletedFolder } : {}) };
}

/**
 * Deletes an environment's local folder (to the trash where possible), closing its editors
 * first. Refuses if a file in it has unsaved changes. Returns the folder, or `undefined` if it
 * didn't exist.
 */
export async function deleteLocalEnvironment(root: vscode.Uri, files: EnvironmentFiles): Promise<vscode.Uri | undefined> {
  if (!(await exists(files.folder))) {
    return undefined;
  }
  const dirty = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.toString().startsWith(`${files.folder.toString()}/`));
  if (dirty) {
    throw new ActionNeededError(`${vscode.workspace.asRelativePath(dirty.uri)} has unsaved changes. Save or revert it first.`);
  }
  await closeEditorsIn(files.folder);
  await assertSafeWritePath(root, files.folder);
  try {
    await vscode.workspace.fs.delete(files.folder, { recursive: true, useTrash: true });
  } catch {
    if (await exists(files.folder)) {
      await vscode.workspace.fs.delete(files.folder, { recursive: true, useTrash: false });
    }
  }
  return files.folder;
}

/** Closes editors showing files in a folder about to be deleted (unsaved ones were refused before). */
async function closeEditorsIn(folder: vscode.Uri): Promise<void> {
  const prefix = `${folder.toString()}/`;
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => tabUri(t)?.toString().startsWith(prefix));
  if (tabs.length) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}
