import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { FabricClient } from '../fabric/client';
import { BULK_CONCURRENCY } from '../fabric/requestLimiter';
import { listLocalNotebooks, type NotebookFiles, notebookFiles } from '../notebooks/files';
import { WorkspaceFolders } from '../notebooks/folders';
import type { NotebookSettings } from '../notebooks/notebookSettings';
import { type ReferenceMapper, uploadChangesReferences, type WorkspaceReferenceKind } from '../notebooks/references';
import { addFolderPaths, fetchNotebookSources, type RemoteNotebook } from '../notebooks/remote';
import { type BulkOptions, type BulkResult, deleteNotebooks, downloadNotebooks, planUploads, runUploads } from '../notebooks/transfer';
import { registerCommand } from '../util/commands';
import { isWarning } from '../util/errorFix';
import { reportError } from '../util/errors';
import { ensureLocalStateDir, localStateDir, requireProjectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { comparePropertiesWithLocal, compareWithLocal, describePropertyDifferences, ONLY_LOCAL } from '../workspace/metadata';
import { writeNotebookCache } from '../workspace/notebookCache';
import type { ResolvedWorkspace, WorkspaceService } from '../workspace/service';
import {
  type NotebookComparison,
  type PlannedSyncChange,
  planSync,
  SYNC_ACTION_LABELS,
  SYNC_ACTION_ORDER,
  type SyncAction,
  type SyncDirection,
  type SyncPlan,
} from '../workspace/sync';
import type { Feature } from './feature';
import {
  closeNotebookEditors,
  deleteNotebook,
  nameList,
  REFERENCES_NOTE,
  referenceMapper,
  reportKeptReferences,
} from './notebooks';
import { openDocument, saveNotebook } from './notebookSync';
import {
  localNotebooks,
  openComparison,
  openPropertiesComparison,
  PROPERTIES_BUTTON,
  recordComparison,
  remoteDocuments,
  withCancellableProgress,
} from './workspaceTools';

/**
 * "Sync Workspace": brings the selected workspace and `src/Notebooks` into line, in the
 * direction chosen. It fetches every notebook from Fabric (so it never acts on an out-of-date
 * cache), compares each with its local `.py` as "Compare All Notebooks with Workspace" does,
 * and lists what would change, each with its diff a click away. Nothing changes until you
 * confirm; then it uploads, downloads and deletes with the same code as the other commands.
 */
export const workspaceSync: Feature = {
  name: 'workspaceSync',
  activate(context, { fabric, workspace: selected, notebookSettings }) {
    context.subscriptions.push(
      registerCommand(Commands.syncWorkspace, 'Sync Workspace', async (direction?: unknown) => {
        try {
          return await syncWorkspace(fabric, selected, notebookSettings, isDirection(direction) ? direction : undefined);
        } catch (err) {
          await reportError('Sync Workspace', err);
          return undefined;
        }
      }),
    );
  },
};

function isDirection(value: unknown): value is SyncDirection {
  return value === 'toWorkspace' || value === 'toLocal';
}

/** Past-tense verbs for the summary, by direction and action. */
const DONE_VERBS: Readonly<Record<SyncDirection, Readonly<Record<SyncAction, string>>>> = {
  toWorkspace: { overwrite: 'uploaded', create: 'created', properties: 'description/folder updated', delete: 'deleted' },
  toLocal: { overwrite: 'replaced', create: 'downloaded', properties: 'notebook.yaml updated', delete: 'deleted locally' },
};

const ACTION_ICONS: Readonly<Record<SyncAction, string>> = {
  overwrite: '$(diff)',
  create: '$(add)',
  properties: '$(symbol-property)',
  delete: '$(trash)',
};

async function syncWorkspace(
  fabric: FabricClient,
  selected: WorkspaceService,
  notebookSettings: NotebookSettings,
  direction: SyncDirection | undefined,
): Promise<SyncResult | undefined> {
  const root = requireProjectRoot('sync notebooks in');
  const workspace = await selected.resolve();
  if (!workspace) {
    return undefined;
  }
  direction ??= await pickDirection(workspace.name);
  if (!direction) {
    return undefined;
  }
  // Before saving or fetching, so creating .fabric-supersat is asked about once.
  await ensureLocalStateDir(localStateDir(root));
  await notebookSettings.createFile();
  const settings = await notebookSettings.read();

  // Uploading sends what's on screen, as Upload All does: open notebooks are saved first.
  const notSaved = new Map<string, string>();
  if (direction === 'toWorkspace') {
    for (const files of await listLocalNotebooks(root)) {
      try {
        await saveNotebook(files);
      } catch (err) {
        notSaved.set(files.name.toLowerCase(), err instanceof Error ? err.message : String(err));
      }
    }
  }

  const compared = await withCancellableProgress(`Comparing src/Notebooks with ${workspace.name}`, (report, isCancelled) =>
    compareForSync(fabric, root, workspace, direction, {
      currentWorkspace: settings.currentWorkspace,
      isCancelled,
      onProgress: (name, done, total) => report(`${done}/${total} fetched (${name})`),
    }),
  );
  if (compared.cancelled) {
    const message = `Sync Workspace cancelled before every notebook in ${workspace.name} was fetched. Nothing was changed.`;
    getLogger().info(message);
    void vscode.window.showInformationMessage(message);
    return undefined;
  }
  const plan = holdBackUnsaved(root, compared.plan, notSaved);
  logPlan(workspace, plan);
  if (!plan.changes.length) {
    const message =
      `src/Notebooks and ${workspace.name} are already in sync: ${plan.same.length} notebook${plan.same.length === 1 ? '' : 's'} the same.` +
      (plan.skipped.length ? ` ${plan.skipped.length} left alone: ${nameList(plan.skipped.map((s) => s.name))} (see the log).` : '');
    void vscode.window.showInformationMessage(message);
    return undefined;
  }
  const picked = await pickChanges(root, workspace, plan, compared.sources, settings.currentWorkspace);
  if (!picked?.length || !(await confirmSync(workspace, plan, picked, direction === 'toWorkspace' && uploadChangesReferences(settings)))) {
    return undefined;
  }

  const references = direction === 'toWorkspace' ? referenceMapper(fabric, workspace, settings) : undefined;
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: Syncing ${syncTitle(direction, workspace.name)}`, cancellable: true },
    (progress, token) =>
      runSync(fabric, root, workspace, direction, picked, compared.sources, {
        currentWorkspace: settings.currentWorkspace,
        references,
        isCancelled: () => token.isCancellationRequested,
        onProgress: (name, done, total) => progress.report({ message: `${done}/${total} done (${name})`, increment: 100 / total }),
      }),
  );
  result.skipped.push(...plan.skipped);
  await reportSync(workspace, direction, result);
  reportKeptReferences(references, workspace);
  return result;
}

function syncTitle(direction: SyncDirection, workspaceName: string): string {
  return direction === 'toWorkspace' ? `src/Notebooks → ${workspaceName}` : `${workspaceName} → src/Notebooks`;
}

async function pickDirection(workspaceName: string): Promise<SyncDirection | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(cloud-upload) Make ${workspaceName} match src/Notebooks`,
        detail: `Uploads notebooks that differ or are only local, and deletes notebooks that are only in ${workspaceName}.`,
        direction: 'toWorkspace' as const,
      },
      {
        label: `$(cloud-download) Make src/Notebooks match ${workspaceName}`,
        detail: `Downloads notebooks that differ or are only in ${workspaceName}, and deletes local notebooks that aren't in it.`,
        direction: 'toLocal' as const,
      },
    ],
    {
      title: `Fabric: Sync Workspace (${workspaceName})`,
      placeHolder: 'Which side should change? You see the list of changes before anything is changed.',
    },
  );
  return picked?.direction;
}

/**
 * Notebooks that can't be synced safely right now, moved from `changes` to `skipped`: when
 * uploading, ones whose unsaved changes couldn't be saved; when changing local files, ones
 * with unsaved changes in an editor (they would be overwritten or deleted underneath it).
 */
function holdBackUnsaved(root: vscode.Uri, plan: SyncPlan, notSaved: ReadonlyMap<string, string>): SyncPlan {
  const changes: PlannedSyncChange[] = [];
  const skipped = [...plan.skipped];
  for (const change of plan.changes) {
    const reason =
      plan.direction === 'toWorkspace'
        ? notSaved.get(change.name.toLowerCase())
        : change.action !== 'create' && hasUnsavedChanges(notebookFiles(root, change.name))
          ? 'it has unsaved changes. Save or revert them first'
          : undefined;
    if (reason) {
      skipped.push({ name: change.name, reason });
    } else {
      changes.push(change);
    }
  }
  return { ...plan, changes, skipped };
}

function hasUnsavedChanges(files: NotebookFiles): boolean {
  return [files.py, files.ipynb, files.properties].some((uri) => openDocument(uri)?.isDirty);
}

function logPlan(workspace: ResolvedWorkspace, plan: SyncPlan): void {
  const log = getLogger();
  const labels = SYNC_ACTION_LABELS[plan.direction];
  log.info(
    `Sync Workspace (${syncTitle(plan.direction, workspace.name)}): ${plan.changes.length} to change, ${plan.same.length} the same, ${plan.skipped.length} left alone`,
  );
  plan.changes.forEach((c) =>
    log.info(`  ${c.name}: ${c.status}${c.properties ? ` (${propertyNote(c)})` : ''} → ${labels[c.action]}`),
  );
  plan.propertyErrors?.forEach((e) => log.warn(`  ${e.name}: description and folder not compared: ${e.reason}`));
  plan.skipped.forEach((s) => log.warn(`  ${s.name}: left alone, ${s.reason}`));
}

// ---------------------------------------------------------------------------------------
// Comparing

export interface SyncComparison {
  plan: SyncPlan;
  /** Every notebook in the workspace, as just fetched. */
  sources: RemoteNotebook[];
  /** Cancelled before every notebook was fetched: `plan` is empty. */
  cancelled: boolean;
}

/**
 * Fetches every notebook in the workspace and compares it with `src/Notebooks`, as "Compare
 * All Notebooks with Workspace" does, then plans the sync. Like a refresh with notebook
 * details, it replaces the notebook cache and records notebooks found the same in the sync
 * state. Descriptions and folders are compared too (see `compareProperties`).
 */
export async function compareForSync(
  fabric: FabricClient,
  root: vscode.Uri,
  workspace: { id: string; name: string },
  direction: SyncDirection,
  options: {
    currentWorkspace?: Record<WorkspaceReferenceKind, boolean>;
    isCancelled?: () => boolean;
    onProgress?: (name: string, done: number, total: number) => void;
  } = {},
): Promise<SyncComparison> {
  const [notebooks, local] = await Promise.all([fabric.listNotebooks(workspace.id), localNotebooks(root)]);
  notebooks.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const sources = await fetchNotebookSources(fabric, workspace.id, notebooks, {
    concurrency: BULK_CONCURRENCY,
    isCancelled: options.isCancelled,
    onProgress: options.onProgress,
  });
  const folders = new WorkspaceFolders(fabric, workspace.id);
  await addFolderPaths(sources, (folderId) => folders.pathOf(folderId));
  await writeNotebookCache(root, workspace.name, sources);
  const cancelled = sources.some((s) => s.cancelled);
  if (cancelled) {
    return { plan: planSync(direction, []), sources, cancelled };
  }

  const comparisons: NotebookComparison[] = [];
  const propertyErrors: { name: string; reason: string }[] = [];
  for (const source of sources) {
    const name = source.notebook.displayName;
    const status = await compareWithLocal(source, local, workspace.id, options.currentWorkspace);
    await recordComparison(root, workspace.name, local, name, status);
    const localName = local.names.find((n) => n.toLowerCase() === name.toLowerCase());
    const properties = status === 'Same' || status === 'Different' ? await comparePropertiesWithLocal(source, local) : undefined;
    if (properties?.error) {
      propertyErrors.push({ name: localName ?? name, reason: properties.error });
    }
    comparisons.push({
      name: localName ?? name,
      status,
      properties: properties?.differences,
      reason: status === 'Not Supported' ? (source.unsupported ?? `Fabric stores it as ${source.gitPath}.`) : source.error,
    });
  }
  const remoteNames = new Set(notebooks.map((n) => n.displayName.toLowerCase()));
  for (const name of local.names.filter((n) => !remoteNames.has(n.toLowerCase()))) {
    await recordComparison(root, workspace.name, local, name, ONLY_LOCAL);
    comparisons.push({ name, status: ONLY_LOCAL });
  }
  return { plan: { ...planSync(direction, comparisons), propertyErrors }, sources, cancelled };
}

/** A change's property differences for a list: e.g. `description and folder differ`. */
function propertyNote(change: PlannedSyncChange): string {
  return describePropertyDifferences({ differences: change.properties ?? [] });
}

// ---------------------------------------------------------------------------------------
// Picking and confirming

interface SyncItem extends vscode.QuickPickItem {
  change: PlannedSyncChange;
}

/**
 * Lists the changes, all ticked, for the user to untick any to leave alone. Each has a button
 * that opens its comparison (Fabric on the left), as in "Compare All Notebooks with Workspace".
 */
function pickChanges(
  root: vscode.Uri,
  workspace: ResolvedWorkspace,
  plan: SyncPlan,
  sources: readonly RemoteNotebook[],
  currentWorkspace: Record<WorkspaceReferenceKind, boolean> | undefined,
): Promise<PlannedSyncChange[] | undefined> {
  const labels = SYNC_ACTION_LABELS[plan.direction];
  const compareButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-compare'), tooltip: 'Open the comparison' };
  const sourceOf = (name: string) => sources.find((s) => s.notebook.displayName.toLowerCase() === name.toLowerCase());
  const items: SyncItem[] = plan.changes.map((change) => ({
    label: `${ACTION_ICONS[change.action]} ${change.name}`,
    description: `${labels[change.action]} (${change.status}${change.properties ? `; ${propertyNote(change)}` : ''})`,
    buttons: change.properties ? [compareButton, PROPERTIES_BUTTON] : [compareButton],
    change,
  }));
  const picker = vscode.window.createQuickPick<SyncItem>();
  picker.title = `Fabric: Sync Workspace (${syncTitle(plan.direction, workspace.name)})`;
  picker.placeholder =
    [
      `${plan.changes.length} to change`,
      plan.same.length ? `${plan.same.length} the same` : '',
      plan.skipped.length ? `${plan.skipped.length} left alone (not supported, not fetched or unsaved)` : '',
    ]
      .filter(Boolean)
      .join(', ') + '. Untick any to leave alone, then press Enter. The compare button shows the differences (Fabric on the left).';
  picker.canSelectMany = true;
  picker.ignoreFocusOut = true;
  picker.matchOnDescription = true;
  picker.items = items;
  picker.selectedItems = items;
  return new Promise((resolve) => {
    let accepted = false;
    picker.onDidTriggerItemButton(({ item, button }) => {
      const remote = sourceOf(item.change.name);
      void (button === PROPERTIES_BUTTON
        ? openPropertiesComparison(root, workspace, remoteDocuments, item.change.name, remote)
        : // The content diff, even for a notebook whose content is the same (the other button shows its properties).
          openComparison({ label: '', name: item.change.name, status: item.change.status, remote }, root, workspace, remoteDocuments, currentWorkspace));
    });
    picker.onDidAccept(() => {
      accepted = true;
      resolve(picker.selectedItems.map((i) => i.change));
      picker.hide();
    });
    picker.onDidHide(() => {
      if (!accepted) {
        resolve(undefined);
      }
      picker.dispose();
    });
    picker.show();
  });
}

async function confirmSync(
  workspace: ResolvedWorkspace,
  plan: SyncPlan,
  picked: readonly PlannedSyncChange[],
  changesReferences: boolean,
): Promise<boolean> {
  const labels = SYNC_ACTION_LABELS[plan.direction];
  const byAction = SYNC_ACTION_ORDER.map((action) => [action, picked.filter((c) => c.action === action).map((c) => c.name)] as const).filter(
    ([, names]) => names.length,
  );
  const deletes = picked.some((c) => c.action === 'delete');
  const toWorkspace = plan.direction === 'toWorkspace';
  const button = 'Sync';
  const choice = await vscode.window.showWarningMessage(
    toWorkspace ? `Make ${workspace.name} match src/Notebooks?` : `Make src/Notebooks match ${workspace.name}?`,
    {
      modal: true,
      detail: [
        ...byAction.map(([action, names]) => `${labels[action]} ${names.length}: ${nameList(names)}.`),
        !picked.some((c) => c.action === 'overwrite')
          ? ''
          : toWorkspace
            ? `Changes made in ${workspace.name} to the notebooks overwritten are lost.`
            : "Replaced local files lose changes you haven't uploaded. Source control can restore committed files.",
        deletes
          ? toWorkspace
            ? `Notebooks are deleted in ${workspace.name} for everyone using it. Fabric keeps them in the workspace's recycle bin only if it has one turned on.`
            : 'Deleted local files (src/Notebooks/<Name>/ and .fabric-supersat/Notebooks/<Name>/) are moved to the trash where possible.'
          : '',
        plan.skipped.length ? `Left alone: ${nameList(plan.skipped.map((s) => s.name))} (see the log for why).` : '',
        toWorkspace && changesReferences ? REFERENCES_NOTE : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    button,
  );
  return choice === button;
}

// ---------------------------------------------------------------------------------------
// Running

export interface SyncResult extends BulkResult {
  /** What was done to each notebook in `done`. */
  actions: Record<string, SyncAction>;
}

export interface RunSyncOptions extends BulkOptions {
  /** Points uploaded notebooks' references at the workspace's items (upload only). */
  references?: ReferenceMapper;
  /** The `notebooks.currentWorkspace` settings (download only). */
  currentWorkspace?: Record<WorkspaceReferenceKind, boolean>;
}

/**
 * Makes the planned changes: uploads (overwrite, create, properties) then deletes in Fabric, or
 * downloads (overwrite, create, properties) then deletes local files. Properties are brought
 * into line by uploading (which sets `notebook.yaml`'s description and folder in Fabric) or
 * downloading (which writes Fabric's into `notebook.yaml`) the notebook. Downloads and uploads are
 * recorded in the history, sync state and notebook cache as the other commands record them.
 * One failure doesn't stop the rest; cancelling stops what hasn't started.
 */
export async function runSync(
  fabric: FabricClient,
  root: vscode.Uri,
  workspace: { id: string; name: string },
  direction: SyncDirection,
  changes: readonly PlannedSyncChange[],
  sources: readonly RemoteNotebook[],
  options: RunSyncOptions = {},
): Promise<SyncResult> {
  const transfers = changes.filter((c) => c.action !== 'delete');
  const deletes = changes.filter((c) => c.action === 'delete');
  const total = changes.length;
  // Both steps count towards one progress total.
  const step = (offset: number): BulkOptions => ({
    isCancelled: options.isCancelled,
    concurrency: options.concurrency ?? BULK_CONCURRENCY,
    onProgress: (name, done) => options.onProgress?.(name, offset + done, total),
  });
  const notebookOf = (name: string) => sources.find((s) => s.notebook.displayName.toLowerCase() === name.toLowerCase())?.notebook;
  const results: BulkResult[] = [];

  if (direction === 'toWorkspace') {
    const plan = await planUploads(fabric, workspace.id, transfers.map((c) => notebookFiles(root, c.name)));
    const uploaded = await runUploads(fabric, workspace.id, plan.uploads, { ...step(0), references: options.references, workspaceName: workspace.name });
    uploaded.skipped.push(...plan.skipped);
    results.push(uploaded);
    if (deletes.length && !uploaded.cancelled) {
      const notebooks = deletes.map((c) => notebookOf(c.name)).filter((n) => n !== undefined);
      results.push(await deleteNotebooks(fabric, workspace.id, notebooks, { ...step(transfers.length), root, workspaceName: workspace.name }));
    }
  } else {
    const notebooks = transfers.map((c) => notebookOf(c.name)).filter((n) => n !== undefined);
    const downloaded = await downloadNotebooks(fabric, root, workspace.id, notebooks, true, {
      ...step(0),
      currentWorkspace: options.currentWorkspace,
      workspaceName: workspace.name,
    });
    results.push(downloaded);
    if (deletes.length && !downloaded.cancelled) {
      results.push(await deleteLocal(fabric, root, workspace, deletes, step(transfers.length)));
    }
  }

  const result: SyncResult = { done: [], skipped: [], failed: [], cancelled: false, actions: {} };
  for (const r of results) {
    result.done.push(...r.done);
    result.skipped.push(...r.skipped);
    result.failed.push(...r.failed);
    result.cancelled ||= r.cancelled;
  }
  // Deletes not started because the transfers were cancelled.
  result.cancelled ||= deletes.length > 0 && results.length === 1;
  for (const name of result.done) {
    const change = changes.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (change) {
      result.actions[name] = change.action;
    }
  }
  return result;
}

/** Deletes local notebooks one at a time, closing their editors first; one failure doesn't stop the rest. */
async function deleteLocal(
  fabric: FabricClient,
  root: vscode.Uri,
  workspace: { id: string; name: string },
  deletes: readonly PlannedSyncChange[],
  options: BulkOptions,
): Promise<BulkResult> {
  const result: BulkResult = { done: [], skipped: [], failed: [], cancelled: false };
  let done = 0;
  for (const { name } of deletes) {
    if (options.isCancelled?.()) {
      result.cancelled = true;
      break;
    }
    const files = notebookFiles(root, name);
    try {
      await closeNotebookEditors(files);
      await deleteNotebook(fabric, files, workspace, undefined, 'Local Only');
      result.done.push(name);
    } catch (err) {
      result[isWarning(err) ? 'skipped' : 'failed'].push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
    options.onProgress?.(name, ++done, deletes.length);
  }
  return result;
}

/** Logs what was done notebook by notebook and shows a summary, with the log a click away if anything was left out. */
async function reportSync(workspace: ResolvedWorkspace, direction: SyncDirection, result: SyncResult): Promise<void> {
  const log = getLogger();
  const verbs = DONE_VERBS[direction];
  result.done.forEach((name) => log.info(`Sync Workspace: notebook "${name}" ${verbs[result.actions[name]] ?? 'synced'}`));
  result.skipped.forEach(({ name, reason }) => log.warn(`Sync Workspace: skipped notebook "${name}": ${reason}`));
  result.failed.forEach(({ name, reason }) => log.error(`Sync Workspace: notebook "${name}" failed: ${reason}`));
  const counts = SYNC_ACTION_ORDER.map((action) => [action, result.done.filter((n) => result.actions[n] === action).length] as const)
    .filter(([, n]) => n)
    .map(([action, n]) => `${n} ${verbs[action]}`);
  const parts = [
    `Synced ${syncTitle(direction, workspace.name)}: ${counts.length ? counts.join(', ') : 'nothing changed'}.`,
    result.skipped.length ? `${result.skipped.length} skipped.` : '',
    result.failed.length ? `${result.failed.length} failed.` : '',
    result.cancelled ? 'Cancelled before the rest.' : '',
  ].filter(Boolean);
  if (!result.skipped.length && !result.failed.length && !result.cancelled) {
    void vscode.window.showInformationMessage(parts.join(' '));
    return;
  }
  if ((await vscode.window.showWarningMessage(parts.join(' '), 'Show Log')) === 'Show Log') {
    log.show();
  }
}
