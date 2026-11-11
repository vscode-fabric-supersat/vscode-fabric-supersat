import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { FabricClient } from '../fabric/client';
import { BULK_CONCURRENCY } from '../fabric/requestLimiter';
import { listLocalNotebooks, type NotebookFiles, notebookFiles } from '../notebooks/files';
import { WorkspaceFolders } from '../notebooks/folders';
import type { NotebookSettings } from '../notebooks/notebookSettings';
import { type ReferenceMapper, uploadChangesReferences } from '../notebooks/references';
import { addFolderPaths, fetchNotebookSources, type RemoteNotebook } from '../notebooks/remote';
import { type BulkOptions, type BulkResult, deleteNotebooks, downloadNotebooks, planUploads, runUploads } from '../notebooks/transfer';
import { registerCommand } from '../util/commands';
import { isWarning } from '../util/errorFix';
import { reportError } from '../util/errors';
import { notify } from '../util/notify';
import { ensureLocalStateDir, localStateDir, requireProjectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { comparePropertiesWithLocal, compareWithLocal, describePropertyDifferences, ONLY_LOCAL } from '../workspace/metadata';
import { writeNotebookCache } from '../workspace/notebookCache';
import type { ResolvedWorkspace, WorkspaceService } from '../workspace/service';
import {
  type ItemComparison,
  type PlannedSyncChange,
  planSync,
  SYNC_ACTION_LABELS,
  SYNC_ACTION_ORDER,
  type SyncAction,
  type SyncDirection,
  type SyncPlan,
} from '../workspace/sync';
import type { Feature } from './feature';
import { compareEnvironments, type EnvironmentComparison, planEnvironmentSync } from '../environments/compare';
import { environmentFiles, listLocalEnvironments } from '../environments/files';
import { downloadEnvironments, planEnvironmentUploads, uploadEnvironments } from '../environments/transfer';
import { deleteItems } from '../items/delete';
import type { ItemKind } from '../items/kinds';
import { offerToPublish, saveEnvironmentFiles } from './environments';
import { deleteLocalEnvironment, openEnvironmentComparison, openPropertiesComparison as openEnvironmentProperties } from './environmentTools';
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
 * "Sync Workspace": brings the selected workspace and `src/` (notebooks and environments)
 * into line, in the direction chosen. It fetches every notebook and environment from Fabric
 * (so it never acts on an out-of-date cache), compares each with its local files as the
 * compare commands do, and lists what would change, each with its diff a click away. Nothing
 * changes until you confirm; then it uploads, downloads and deletes with the same code as the
 * other commands. Each kind is compared, planned and run on its own (names are unique per kind).
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
  toLocal: { overwrite: 'replaced', create: 'downloaded', properties: '.yaml properties updated', delete: 'deleted locally' },
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
): Promise<(SyncResult & { environments: SyncResult }) | undefined> {
  const root = requireProjectRoot('sync notebooks and environments in');
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
  const environmentsNotSaved = new Map<string, string>();
  if (direction === 'toWorkspace') {
    for (const files of await listLocalNotebooks(root)) {
      try {
        await saveNotebook(files);
      } catch (err) {
        notSaved.set(files.name.toLowerCase(), err instanceof Error ? err.message : String(err));
      }
    }
    for (const files of await listLocalEnvironments(root)) {
      try {
        await saveEnvironmentFiles([files]);
      } catch (err) {
        environmentsNotSaved.set(files.name.toLowerCase(), err instanceof Error ? err.message : String(err));
      }
    }
  }

  const compared = await withCancellableProgress(`Comparing src/Notebooks with ${workspace.name}`, (report, isCancelled) =>
    compareForSync(fabric, root, workspace, direction, {
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
  logPlan(workspace, plan, 'notebook');

  const environmentsCompared = await withCancellableProgress(`Comparing src/Environments with ${workspace.name}`, (report, isCancelled) =>
    compareEnvironments(fabric, root, workspace, {
      concurrency: BULK_CONCURRENCY,
      isCancelled,
      onProgress: (name, done, total) => report(`${done}/${total} fetched (${name})`),
    }),
  );
  if (environmentsCompared.cancelled) {
    const message = `Sync Workspace cancelled before every environment in ${workspace.name} was fetched. Nothing was changed.`;
    getLogger().info(message);
    void vscode.window.showInformationMessage(message);
    return undefined;
  }
  const environmentPlan = holdBackUnsavedEnvironments(root, planEnvironmentSync(direction, environmentsCompared.comparisons), environmentsNotSaved);
  logPlan(workspace, environmentPlan, 'environment');

  if (!plan.changes.length && !environmentPlan.changes.length) {
    const skipped = [...plan.skipped, ...environmentPlan.skipped];
    const message =
      `src/ and ${workspace.name} are already in sync: ${countOf(plan.same.length, 'notebook')} and ${countOf(environmentPlan.same.length, 'environment')} the same.` +
      (skipped.length ? ` ${skipped.length} left alone: ${nameList(skipped.map((s) => s.name))} (see the log).` : '');
    void vscode.window.showInformationMessage(message);
    return undefined;
  }
  const picked = await pickChanges(root, workspace, plan, compared.sources, environmentPlan, environmentsCompared.comparisons);
  if (
    !picked ||
    (!picked.notebook.length && !picked.environment.length) ||
    !(await confirmSync(workspace, plan, picked.notebook, direction === 'toWorkspace' && uploadChangesReferences(settings), environmentPlan, picked.environment))
  ) {
    return undefined;
  }

  const references = direction === 'toWorkspace' && picked.notebook.length ? referenceMapper(fabric, workspace, settings) : undefined;
  const empty = (): SyncResult => ({ done: [], skipped: [], failed: [], cancelled: false, actions: {} });
  let publishable: { id: string; name: string }[] = [];
  const [result, environmentResult] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: Syncing ${syncTitle(direction, workspace.name)}`, cancellable: true },
    async (progress, token) => {
      const total = picked.notebook.length + picked.environment.length;
      const options = (offset: number) => ({
        isCancelled: () => token.isCancellationRequested,
        onProgress: (name: string, done: number) => progress.report({ message: `${offset + done}/${total} done (${name})`, increment: 100 / total }),
      });
      const notebooks = picked.notebook.length
        ? await runSync(fabric, root, workspace, direction, picked.notebook, compared.sources, { references, ...options(0) })
        : empty();
      const environments =
        picked.environment.length && !notebooks.cancelled
          ? await runEnvironmentSync(fabric, root, workspace, direction, picked.environment, environmentsCompared.comparisons, options(picked.notebook.length))
          : { ...empty(), cancelled: notebooks.cancelled && picked.environment.length > 0 };
      publishable = 'uploaded' in environments ? environments.uploaded : [];
      return [notebooks, environments] as const;
    },
  );
  result.skipped.push(...plan.skipped);
  environmentResult.skipped.push(...environmentPlan.skipped);
  reportSync(workspace, direction, [
    ['notebook', result],
    ['environment', environmentResult],
  ]);
  reportKeptReferences(references, workspace);
  if (publishable.length) {
    offerToPublish(fabric, workspace, publishable, `Uploaded ${countOf(publishable.length, 'environment')} to ${workspace.name}.`);
  }
  return { ...result, environments: environmentResult };
}

function countOf(count: number, kind: string): string {
  return `${count} ${kind}${count === 1 ? '' : 's'}`;
}

function syncTitle(direction: SyncDirection, workspaceName: string): string {
  return direction === 'toWorkspace' ? `src → ${workspaceName}` : `${workspaceName} → src`;
}

async function pickDirection(workspaceName: string): Promise<SyncDirection | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: `$(cloud-upload) Make ${workspaceName} match src/Notebooks and src/Environments`,
        detail: `Uploads notebooks and environments that differ or are only local, and deletes those only in ${workspaceName}.`,
        direction: 'toWorkspace' as const,
      },
      {
        label: `$(cloud-download) Make src/Notebooks and src/Environments match ${workspaceName}`,
        detail: `Downloads notebooks and environments that differ or are only in ${workspaceName}, and deletes local ones that aren't in it.`,
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

/** `holdBackUnsaved` for environments: those not saved before uploading, or with unsaved files before changing local ones. */
function holdBackUnsavedEnvironments(root: vscode.Uri, plan: SyncPlan, notSaved: ReadonlyMap<string, string>): SyncPlan {
  const changes: PlannedSyncChange[] = [];
  const skipped = [...plan.skipped];
  for (const change of plan.changes) {
    const folder = `${environmentFiles(root, change.name).folder.toString()}/`;
    const reason =
      plan.direction === 'toWorkspace'
        ? notSaved.get(change.name.toLowerCase())
        : change.action !== 'create' && vscode.workspace.textDocuments.some((d) => d.isDirty && d.uri.toString().startsWith(folder))
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
  return [files.py, files.ipynb, files.localIpynb, files.properties].some((uri) => openDocument(uri)?.isDirty);
}

function logPlan(workspace: ResolvedWorkspace, plan: SyncPlan, kind: ItemKind): void {
  const log = getLogger();
  const labels = SYNC_ACTION_LABELS[plan.direction];
  log.info(
    `Sync Workspace (${syncTitle(plan.direction, workspace.name)}), ${kind}s: ${plan.changes.length} to change, ${plan.same.length} the same, ${plan.skipped.length} left alone`,
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

  const comparisons: ItemComparison[] = [];
  const propertyErrors: { name: string; reason: string }[] = [];
  for (const source of sources) {
    const name = source.notebook.displayName;
    const status = await compareWithLocal(source, local);
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
  itemKind: ItemKind;
  change: PlannedSyncChange;
}

/** The changes picked, by kind. */
type PickedChanges = Record<ItemKind, PlannedSyncChange[]>;

/**
 * Lists the changes (notebooks, then environments), all ticked, for the user to untick any to
 * leave alone. Each has a button that opens its comparison (Fabric on the left), as in the
 * compare commands.
 */
function pickChanges(
  root: vscode.Uri,
  workspace: ResolvedWorkspace,
  plan: SyncPlan,
  sources: readonly RemoteNotebook[],
  environmentPlan: SyncPlan,
  environments: readonly EnvironmentComparison[],
): Promise<PickedChanges | undefined> {
  const labels = SYNC_ACTION_LABELS[plan.direction];
  const compareButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('git-compare'), tooltip: 'Open the comparison' };
  const sourceOf = (name: string) => sources.find((s) => s.notebook.displayName.toLowerCase() === name.toLowerCase());
  const environmentOf = (name: string) => environments.find((c) => c.name.toLowerCase() === name.toLowerCase());
  const toItem = (kind: ItemKind) => (change: PlannedSyncChange): SyncItem => ({
    label: `${ACTION_ICONS[change.action]} ${change.name}`,
    description: `${kind === 'environment' ? 'Environment: ' : ''}${labels[change.action]} (${change.status}${change.properties ? `; ${propertyNote(change)}` : ''})`,
    buttons: change.properties ? [compareButton, PROPERTIES_BUTTON] : [compareButton],
    itemKind: kind,
    change,
  });
  const items: SyncItem[] = [...plan.changes.map(toItem('notebook')), ...environmentPlan.changes.map(toItem('environment'))];
  const changeCount = plan.changes.length + environmentPlan.changes.length;
  const same = plan.same.length + environmentPlan.same.length;
  const skipped = plan.skipped.length + environmentPlan.skipped.length;
  const picker = vscode.window.createQuickPick<SyncItem>();
  picker.title = `Fabric: Sync Workspace (${syncTitle(plan.direction, workspace.name)})`;
  picker.placeholder =
    [
      `${changeCount} to change`,
      same ? `${same} the same` : '',
      skipped ? `${skipped} left alone (not supported, not fetched or unsaved)` : '',
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
      if (item.itemKind === 'environment') {
        const comparison = environmentOf(item.change.name) ?? { name: item.change.name, status: item.change.status };
        // The content comparison even for an environment whose content is the same: its properties have their own button.
        void (button === PROPERTIES_BUTTON
          ? openEnvironmentProperties(root, workspace, comparison)
          : openEnvironmentComparison(root, workspace, comparison.status === 'Same' ? { ...comparison, status: 'Different' } : comparison));
        return;
      }
      const remote = sourceOf(item.change.name);
      void (button === PROPERTIES_BUTTON
        ? openPropertiesComparison(root, workspace, remoteDocuments, item.change.name, remote)
        : // The content diff, even for a notebook whose content is the same (the other button shows its properties).
          openComparison({ label: '', name: item.change.name, status: item.change.status, remote }, root, workspace, remoteDocuments));
    });
    picker.onDidAccept(() => {
      accepted = true;
      resolve({
        notebook: picker.selectedItems.filter((i) => i.itemKind === 'notebook').map((i) => i.change),
        environment: picker.selectedItems.filter((i) => i.itemKind === 'environment').map((i) => i.change),
      });
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
  environmentPlan: SyncPlan,
  pickedEnvironments: readonly PlannedSyncChange[],
): Promise<boolean> {
  const labels = SYNC_ACTION_LABELS[plan.direction];
  const byAction = (changes: readonly PlannedSyncChange[], prefix: string) =>
    SYNC_ACTION_ORDER.map((action) => [action, changes.filter((c) => c.action === action).map((c) => c.name)] as const)
      .filter(([, names]) => names.length)
      .map(([action, names]) => `${prefix}${labels[action]} ${names.length}: ${nameList(names)}.`);
  const all = [...picked, ...pickedEnvironments];
  const deletes = all.some((c) => c.action === 'delete');
  const toWorkspace = plan.direction === 'toWorkspace';
  const skipped = [...plan.skipped, ...environmentPlan.skipped];
  const button = 'Sync';
  const choice = await vscode.window.showWarningMessage(
    toWorkspace ? `Make ${workspace.name} match src/?` : `Make src/ match ${workspace.name}?`,
    {
      modal: true,
      detail: [
        ...byAction(picked, pickedEnvironments.length ? 'Notebooks: ' : ''),
        ...byAction(pickedEnvironments, 'Environments: '),
        !all.some((c) => c.action === 'overwrite')
          ? ''
          : toWorkspace
            ? `Changes made in ${workspace.name} to the notebooks and environments overwritten are lost.`
            : "Replaced local files lose changes you haven't uploaded. Source control can restore committed files.",
        deletes
          ? toWorkspace
            ? `Deleted in ${workspace.name} for everyone using it. Fabric keeps them in the workspace's recycle bin only if it has one turned on.`
            : 'Deleted local files (src/Notebooks/<Name>/, .fabric-supersat/Notebooks/<Name>/, src/Environments/<Name>/) are moved to the trash where possible.'
          : '',
        toWorkspace && pickedEnvironments.some((c) => c.action !== 'delete')
          ? 'Environments are uploaded to their saved state in Fabric: they take effect once published (offered afterwards).'
          : '',
        skipped.length ? `Left alone: ${nameList(skipped.map((s) => s.name))} (see the log for why).` : '',
        toWorkspace && changesReferences && picked.length ? REFERENCES_NOTE : '',
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
}

/**
 * Makes the planned changes: uploads (overwrite, create, properties) then deletes in Fabric, or
 * downloads (overwrite, create, properties) then deletes local files. Properties are brought
 * into line by uploading (which sets `<Name>.yaml`'s description and folder in Fabric) or
 * downloading (which writes Fabric's into `<Name>.yaml`) the notebook. Downloads and uploads are
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

/**
 * Makes the planned environment changes, as `runSync` does for notebooks: uploads (overwrite,
 * create, properties) then deletes in Fabric, or downloads then deletes local folders.
 * Uploaded environments go to their saved state in Fabric; `uploaded` lists them for publishing.
 */
export async function runEnvironmentSync(
  fabric: FabricClient,
  root: vscode.Uri,
  workspace: { id: string; name: string },
  direction: SyncDirection,
  changes: readonly PlannedSyncChange[],
  comparisons: readonly EnvironmentComparison[],
  options: BulkOptions = {},
): Promise<SyncResult & { uploaded: { id: string; name: string }[] }> {
  const transfers = changes.filter((c) => c.action !== 'delete');
  const deletes = changes.filter((c) => c.action === 'delete');
  const step = (offset: number): BulkOptions => ({
    isCancelled: options.isCancelled,
    concurrency: options.concurrency ?? BULK_CONCURRENCY,
    onProgress: (name, done) => options.onProgress?.(name, offset + done, changes.length),
  });
  const remoteOf = (name: string) => comparisons.find((c) => c.name.toLowerCase() === name.toLowerCase())?.source?.environment;
  const results: BulkResult[] = [];
  const uploaded: { id: string; name: string }[] = [];
  if (direction === 'toWorkspace') {
    const plan = await planEnvironmentUploads(fabric, workspace.id, transfers.map((c) => environmentFiles(root, c.name)));
    const sent = await uploadEnvironments(fabric, workspace.id, plan.uploads, { ...step(0), workspaceName: workspace.name });
    sent.skipped.push(...plan.skipped);
    sent.ids.forEach((id, name) => uploaded.push({ id, name }));
    results.push(sent);
    if (deletes.length && !sent.cancelled) {
      const items = deletes.map((c) => remoteOf(c.name)).filter((e) => e !== undefined);
      results.push(await deleteItems(fabric, workspace.id, 'environment', items, { ...step(transfers.length), root, workspaceName: workspace.name }));
    }
  } else {
    const items = transfers.map((c) => remoteOf(c.name)).filter((e) => e !== undefined);
    const downloaded = await downloadEnvironments(fabric, root, workspace.id, items, true, { ...step(0), workspaceName: workspace.name });
    results.push(downloaded);
    if (deletes.length && !downloaded.cancelled) {
      const removed: BulkResult = { done: [], skipped: [], failed: [], cancelled: false };
      for (const { name } of deletes) {
        if (options.isCancelled?.()) {
          removed.cancelled = true;
          break;
        }
        try {
          await deleteLocalEnvironment(root, environmentFiles(root, name));
          removed.done.push(name);
        } catch (err) {
          removed[isWarning(err) ? 'skipped' : 'failed'].push({ name, reason: err instanceof Error ? err.message : String(err) });
        }
        options.onProgress?.(name, transfers.length + removed.done.length, changes.length);
      }
      results.push(removed);
    }
  }
  const result: SyncResult & { uploaded: { id: string; name: string }[] } = { done: [], skipped: [], failed: [], cancelled: false, actions: {}, uploaded };
  for (const r of results) {
    result.done.push(...r.done);
    result.skipped.push(...r.skipped);
    result.failed.push(...r.failed);
    result.cancelled ||= r.cancelled;
  }
  result.cancelled ||= deletes.length > 0 && transfers.length > 0 && results.length === 1;
  for (const name of result.done) {
    const change = changes.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (change) {
      result.actions[name] = change.action;
    }
  }
  return result;
}

/** Logs what was done item by item (each kind's result) and shows one summary, with the log a click away if anything was left out. */
function reportSync(workspace: ResolvedWorkspace, direction: SyncDirection, results: readonly (readonly [ItemKind, SyncResult])[]): void {
  const log = getLogger();
  const verbs = DONE_VERBS[direction];
  const counts: string[] = [];
  for (const [kind, result] of results) {
    result.done.forEach((name) => log.info(`Sync Workspace: ${kind} "${name}" ${verbs[result.actions[name]] ?? 'synced'}`));
    result.skipped.forEach(({ name, reason }) => log.warn(`Sync Workspace: skipped ${kind} "${name}": ${reason}`));
    result.failed.forEach(({ name, reason }) => log.error(`Sync Workspace: ${kind} "${name}" failed: ${reason}`));
    const done = SYNC_ACTION_ORDER.map((action) => [action, result.done.filter((n) => result.actions[n] === action).length] as const)
      .filter(([, n]) => n)
      .map(([action, n]) => `${n} ${verbs[action]}`);
    if (done.length) {
      counts.push(`${kind}s ${done.join(', ')}`);
    }
  }
  const total = (key: 'skipped' | 'failed') => results.reduce((n, [, r]) => n + r[key].length, 0);
  const cancelled = results.some(([, r]) => r.cancelled);
  const parts = [
    `Synced ${syncTitle(direction, workspace.name)}: ${counts.length ? counts.join('; ') : 'nothing changed'}.`,
    total('skipped') ? `${total('skipped')} skipped.` : '',
    total('failed') ? `${total('failed')} failed.` : '',
    cancelled ? 'Cancelled before the rest.' : '',
  ].filter(Boolean);
  if (!total('skipped') && !total('failed') && !cancelled) {
    void vscode.window.showInformationMessage(parts.join(' '));
    return;
  }
  notify('warning', parts.join(' '), ['Show Log'], () => log.show());
}
