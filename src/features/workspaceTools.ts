import * as vscode from 'vscode';
import { accountLabel, decodeJwt } from '../auth/jwt';
import type { FabricAuth } from '../auth/service';
import { Commands } from '../constants';
import type { FabricClient } from '../fabric/client';
import { BULK_CONCURRENCY } from '../fabric/requestLimiter';
import {
  listLocalNotebooks,
  type NotebookFiles,
  notebookFiles,
  notebookFilesFor,
  notebookPropertiesText,
  readNotebookProperties,
  readTextIfExists,
} from '../notebooks/files';
import { WorkspaceFolders } from '../notebooks/folders';
import {
  checkNotebookFormats,
  hasFailure,
  type NotebookFormatResult,
  renderFormatReport,
  replaceIds,
} from '../notebooks/formatTest';
import { referenceMapperFor } from '../notebooks/references';
import { addFolderPaths, fetchNotebookSources, type RemoteNotebook } from '../notebooks/remote';
import { getConfig } from '../util/config';
import { duration } from '../util/diagnostics';
import { reportError } from '../util/errors';
import { ActionNeededError } from '../util/errorFix';
import { safeFolderName } from '../util/folderNames';
import { requireProjectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { findByName } from '../util/names';
import { withProgress } from '../util/progress';
import {
  collectWorkspaceMetadata,
  type CompareStatus,
  comparePropertiesWithLocal,
  compareWithLocal,
  describePropertyDifferences,
  expectedLocalPy,
  type LocalNotebooks,
  ONLY_LOCAL,
  type PropertyComparison,
  renderMetadataMarkdown,
} from '../workspace/metadata';
import {
  cacheEntry,
  cachedSources,
  type CacheWriteResult,
  readNotebookCache,
  updateCachedNotebook,
  writeNotebookCache,
} from '../workspace/notebookCache';
import type { NotebookSettings } from '../notebooks/notebookSettings';
import type { ResolvedWorkspace, WorkspaceService } from '../workspace/service';
import {
  deleteLocalStatePath,
  forgetSync,
  recordSync,
  workspaceInfoFileName,
  writeLocalStateFile,
  writeWorkspaceFile,
} from '../workspace/state';
import type { Feature } from './feature';
import { registerCommand } from '../util/commands';

/** Read-only scheme for notebooks as they are in Fabric (the left side of the compare commands' diffs). */
const REMOTE_SCHEME = 'fabric-supersat-remote';
const DIAGNOSTICS_DIR = 'diagnostics';

/**
 * Commands that look at a whole workspace (or one notebook in it) without changing it or `src/`:
 *
 * - "Refresh Workspace Information": everything readable about the workspace, saved as
 *   `.fabric-supersat/workspaces/<Workspace Name>/<Workspace Name>.md` and `.json`; with
 *   notebook details, also the notebook cache and the sync state of notebooks found the same.
 * - "Test Notebook Formats": checks the format conversions against every notebook as
 *   Fabric exports it; report in `.fabric-supersat/diagnostics/format-test.md`.
 * - "Compare All Notebooks with Workspace": which notebooks differ between `src/Notebooks`
 *   and the workspace as last fetched (the notebook cache), with a diff view of each.
 * - "Compare Notebook with Workspace": the open notebook against Fabric's current version.
 */
export const workspaceTools: Feature = {
  name: 'workspaceTools',
  activate(context, { auth, fabric, workspace: selected, notebookSettings }) {
    const remoteDocs = remoteDocuments;
    const refresh = (options?: RefreshOptions) => refreshInformation(auth, fabric, selected, notebookSettings, options);
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, remoteDocs),
      registerCommand(Commands.refreshWorkspaceInformation, 'Refresh Workspace Information', () =>
        run('Refresh Workspace Information', () => refresh()),
      ),
      registerCommand(Commands.testNotebookFormats, 'Test Notebook Formats', () =>
        run('Test Notebook Formats', () => testFormats(fabric, selected, notebookSettings)),
      ),
      registerCommand(Commands.compareAllNotebooksWithWorkspace, 'Compare All Notebooks with Workspace', () =>
        run('Compare All Notebooks with Workspace', () => compareAll(selected, notebookSettings, remoteDocs, refresh)),
      ),
      registerCommand(Commands.compareNotebookWithWorkspace, 'Compare Notebook with Workspace', (arg?: unknown) =>
        run('Compare Notebook with Workspace', () =>
          compareOne(fabric, selected, notebookSettings, remoteDocs, arg instanceof vscode.Uri ? arg : activeUri()),
        ),
      ),
    );
  },
};

/** Runs a command's task, with errors reported (the command itself is timed by `registerCommand`). */
async function run<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await task();
  } catch (err) {
    await reportError(title, err);
    return undefined;
  }
}

export function localNotebooks(root: vscode.Uri): Promise<LocalNotebooks> {
  return listLocalNotebooks(root).then((files) => ({
    names: files.map((f) => f.name),
    readPy: (name: string) => readTextIfExists(notebookFiles(root, name).py),
    readProperties: (name: string) => readNotebookProperties(notebookFiles(root, name)),
  }));
}

function activeUri(): vscode.Uri | undefined {
  return vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
}

/** A cancellable progress notification. */
export function withCancellableProgress<T>(
  title: string,
  task: (report: (message: string) => void, isCancelled: () => boolean) => Promise<T>,
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: ${title}`, cancellable: true },
    (progress, token) => task((message) => progress.report({ message }), () => token.isCancellationRequested),
  );
}

/**
 * Records in the sync state what a comparison with Fabric found: a notebook the same as
 * Fabric's counts as synced (so "Upload Changed" skips it), and one no longer in Fabric is
 * forgotten (so it counts as changed). Other statuses leave the sync state as it is: a
 * different notebook may have been changed in Fabric, not locally. Returns whether it recorded anything.
 */
export async function recordComparison(
  root: vscode.Uri,
  workspaceName: string,
  local: LocalNotebooks,
  name: string,
  status: CompareStatus,
): Promise<boolean> {
  const localName = local.names.find((n) => n === name) ?? local.names.find((n) => n.toLowerCase() === name.toLowerCase());
  if (localName === undefined) {
    return false;
  }
  if (status === ONLY_LOCAL) {
    await forgetSync(root, workspaceName, localName);
    return true;
  }
  const py = status === 'Same' ? await local.readPy(localName) : undefined;
  if (py === undefined) {
    return false;
  }
  await recordSync(root, workspaceName, localName, py, 'compare');
  return true;
}

// ---------------------------------------------------------------------------------------
// Refresh Workspace Information

interface RefreshOptions {
  /** Ask which options to use (otherwise notebook details are fetched). Default true. */
  ask?: boolean;
  /** Open the Markdown page when done. Default true. */
  open?: boolean;
}

async function refreshInformation(
  auth: FabricAuth,
  fabric: FabricClient,
  selected: WorkspaceService,
  notebookSettings: NotebookSettings,
  { ask = true, open = true }: RefreshOptions = {},
): Promise<vscode.Uri | undefined> {
  const root = requireProjectRoot('save workspace information in');
  const workspace = await selected.resolve();
  if (!workspace) {
    return undefined;
  }
  let notebookDetails = true;
  if (ask) {
    const options = await vscode.window.showQuickPick(
      [
        {
          label: 'Notebook details',
          description: 'slower: fetches each notebook',
          detail:
            'Language, lakehouse, environment and warehouses of each notebook, and how it compares with src/Notebooks. ' +
            'Also caches the notebooks for Compare All Notebooks with Workspace, and updates the sync state for Upload Changed.',
          picked: true,
          id: 'notebookDetails',
        },
      ],
      {
        title: `Fabric: Refresh Workspace Information (${workspace.name})`,
        placeHolder: 'Press Enter to refresh. Untick what you don’t need.',
        canPickMany: true,
      },
    );
    if (!options) {
      return undefined;
    }
    notebookDetails = options.some((o) => o.id === 'notebookDetails');
  }
  const config = getConfig();
  const settings = await notebookSettings.read();
  const local = await localNotebooks(root);
  const started = Date.now();
  const { metadata, notebooks } = await withCancellableProgress(`Refreshing information for ${workspace.name}`, async (report, isCancelled) =>
    collectWorkspaceMetadata(fabric, workspace, {
      notebookDetails,
      memberRoles: config.metadata.includeMemberRoles,
      concurrency: BULK_CONCURRENCY,
      account: await signedInAccount(auth),
      local,
      currentWorkspace: settings.currentWorkspace,
      onProgress: report,
      isCancelled,
    }),
  );
  const jsonFile = workspaceInfoFileName(workspace.name, 'json');
  await writeWorkspaceFile(root, workspace.name, jsonFile, `${JSON.stringify(metadata, undefined, 2)}\n`);
  const md = await writeWorkspaceFile(root, workspace.name, workspaceInfoFileName(workspace.name, 'md'), renderMetadataMarkdown(metadata, jsonFile));

  let synced = 0;
  let cache: CacheWriteResult = { kept: [], missing: [] };
  if (notebooks) {
    cache = await writeNotebookCache(root, workspace.name, notebooks);
    for (const n of metadata.notebooks) {
      if (n.local === 'Same' && (await recordComparison(root, workspace.name, local, n.name, n.local))) {
        synced++;
      }
    }
    for (const name of metadata.onlyLocal ?? []) {
      await recordComparison(root, workspace.name, local, name, ONLY_LOCAL);
    }
  }

  const items = metadata.summary.itemTypes.reduce((sum, t) => sum + t.count, 0);
  const cached = notebooks ? `, ${notebooks.length} notebooks cached, ${synced} the same as local recorded as synced` : '';
  getLogger().info(
    `Refreshed information for ${workspace.name} (${items} items, ${metadata.unavailable.length} sections not available${cached}) in ${duration(Date.now() - started)}: ${vscode.workspace.asRelativePath(md)}`,
  );
  if (open) {
    await vscode.commands.executeCommand('markdown.showPreview', md);
  }
  if (metadata.summary.notebooksCancelled) {
    const message =
      `Refreshed information for ${workspace.name}, but cancelled: ${metadata.summary.notebooksCancelled} notebook(s) weren't fetched.` +
      (cache.kept.length ? ` The notebook cache keeps the previous version of ${nameList(cache.kept)}, which may be out of date.` : '') +
      (cache.missing.length ? ` The notebook cache has no version of ${nameList(cache.missing)} (Not Fetched).` : '') +
      ' Run Refresh Workspace Information again to update them.';
    getLogger().warn(message);
    void vscode.window.showWarningMessage(message);
  } else if (metadata.unavailable.length) {
    void vscode.window.showWarningMessage(
      `Refreshed information for ${workspace.name}. ${metadata.unavailable.length} section(s) weren't available; they're listed at the end.`,
    );
  }
  return md;
}

/** Notebook names for a message: quoted, and at most `max` before "and N more". */
function nameList(names: readonly string[], max = 5): string {
  const shown = names.slice(0, max).map((n) => `"${n}"`).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

/** The signed-in account's name, from the Fabric token, for the information page's header. */
async function signedInAccount(auth: FabricAuth): Promise<string | undefined> {
  try {
    return accountLabel(decodeJwt(await auth.getToken('fabric', 'Fabric Supersat needs to sign in to read your workspace.')));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// Test Notebook Formats

async function testFormats(
  fabric: FabricClient,
  selected: WorkspaceService,
  notebookSettings: NotebookSettings,
): Promise<NotebookFormatResult[] | undefined> {
  const root = requireProjectRoot('save the format test report in');
  const workspace = await selected.resolve();
  if (!workspace) {
    return undefined;
  }
  const notebooks = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
  if (!notebooks.length) {
    void vscode.window.showInformationMessage(`No notebooks in "${workspace.name}".`);
    return undefined;
  }
  notebooks.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const settings = await notebookSettings.read();
  const references = referenceMapperFor((id, type) => fabric.listItems(id, type), workspace.id, settings);
  const results = await withCancellableProgress(`Testing notebook formats in ${workspace.name}`, async (report, isCancelled) => {
    const remote = await fetchNotebookSources(fabric, workspace.id, notebooks, {
      source: 'both',
      concurrency: BULK_CONCURRENCY,
      isCancelled,
      onProgress: (name, done, total) => report(`${done}/${total} fetched (${name})`),
    });
    const checked: NotebookFormatResult[] = [];
    for (const r of remote) {
      checked.push(await checkNotebookFormats(r, references));
    }
    return { checked, remote };
  });

  const time = new Date().toISOString();
  const report = await writeLocalStateFile(root, [DIAGNOSTICS_DIR, 'format-test.md'], renderFormatReport(workspace.name, time, results.checked));
  await writeLocalStateFile(
    root,
    [DIAGNOSTICS_DIR, 'format-test.json'],
    `${JSON.stringify({ workspace: workspace.name, time, results: results.checked }, undefined, 2)}\n`,
  );
  const cancelled = results.checked.filter((r) => r.cancelled).length;
  // A cancelled run keeps the previous run's samples, rather than replacing them with a partial set.
  if (!cancelled) {
    await saveFailingSamples(root, results.remote, results.checked);
  }

  const failing = results.checked.filter(hasFailure).length;
  const checked = results.checked.length - cancelled;
  const message = cancelled
    ? `Format test cancelled: ${checked} of ${results.checked.length} notebooks in ${workspace.name} checked, ${failing} failed a check.`
    : failing
      ? `Format test: ${failing} of ${results.checked.length} notebooks in ${workspace.name} failed a check.`
      : `Format test: all ${results.checked.length} notebooks in ${workspace.name} passed.`;
  getLogger().info(`${message} Report: ${vscode.workspace.asRelativePath(report)}`);
  const show = failing || cancelled ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  void show(message, 'Open Report').then((choice) => choice && vscode.commands.executeCommand('markdown.showPreview', report));
  return results.checked;
}

/** Saves both Fabric exports of each failing notebook in `diagnostics/samples/<Name>/`, with IDs replaced. */
async function saveFailingSamples(root: vscode.Uri, remote: readonly RemoteNotebook[], results: readonly NotebookFormatResult[]): Promise<void> {
  await deleteLocalStatePath(root, [DIAGNOSTICS_DIR, 'samples']);
  for (const result of results.filter(hasFailure)) {
    const source = remote.find((r) => r.notebook.displayName === result.name);
    if (!source?.gitText || !source.gitPath) {
      continue;
    }
    // The notebook's folder name: the same rules as its src/Notebooks folder (encoded if it can't be one).
    const folder = safeFolderName(result.name);
    const [git, ipynb] = replaceIds([source.gitText, source.ipynbText ?? '']);
    await writeLocalStateFile(root, [DIAGNOSTICS_DIR, 'samples', folder, source.gitPath], git);
    if (source.ipynbText !== undefined) {
      await writeLocalStateFile(root, [DIAGNOSTICS_DIR, 'samples', folder, 'notebook-content.ipynb'], ipynb);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Compare All Notebooks with Workspace, Compare Notebook with Workspace

/** Notebooks as fetched from Fabric, served read-only for diffs. */
export class RemoteDocuments implements vscode.TextDocumentContentProvider {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  set(workspace: ResolvedWorkspace, name: string, path: string, text: string): vscode.Uri {
    const extension = path.split('.').pop() ?? 'py';
    const uri = vscode.Uri.from({
      scheme: REMOTE_SCHEME,
      path: `/${encodeURIComponent(workspace.name)}/${encodeURIComponent(name)}.${extension}`,
    });
    this.texts.set(uri.toString(), text);
    this.changed.fire(uri);
    return uri;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }
}

/** The one provider for the remote scheme, shared by the compare commands and "Sync Workspace" (registered by this feature). */
export const remoteDocuments = new RemoteDocuments();

export interface CompareItem extends vscode.QuickPickItem {
  name?: string;
  status?: CompareStatus;
  remote?: RemoteNotebook;
  /** How its description and folder compare with `notebook.yaml`. */
  properties?: PropertyComparison;
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

/** The list button that opens a notebook's `notebook.yaml` comparison. */
export const PROPERTIES_BUTTON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('symbol-property'),
  tooltip: 'Compare description and folder (notebook.yaml)',
};

/** Compares `src/Notebooks` with the workspace's notebooks as last fetched (the notebook cache): no requests to Fabric. */
async function compareAll(
  selected: WorkspaceService,
  notebookSettings: NotebookSettings,
  remoteDocs: RemoteDocuments,
  refresh: (options: RefreshOptions) => Promise<unknown>,
): Promise<void> {
  const root = requireProjectRoot('compare notebooks in');
  const workspace = await selected.resolve();
  if (!workspace) {
    return;
  }
  let cache = await readNotebookCache(root, workspace.name);
  if (!cache) {
    const action = 'Refresh Now';
    const choice = await vscode.window.showInformationMessage(
      `No notebooks cached for ${workspace.name} yet. Compare All Notebooks with Workspace uses the notebooks fetched by Refresh Workspace Information (with notebook details).`,
      action,
    );
    if (choice !== action) {
      return;
    }
    await refresh({ ask: false, open: false });
    cache = await readNotebookCache(root, workspace.name);
    if (!cache) {
      return;
    }
  }
  const local = await localNotebooks(root);
  const settings = await notebookSettings.read();
  const remote = cachedSources(cache, workspace.id);

  const items: CompareItem[] = [];
  for (const r of remote) {
    const status = await compareWithLocal(r, local, workspace.id, settings.currentWorkspace);
    const properties = status === 'Same' || status === 'Different' ? await comparePropertiesWithLocal(r, local) : undefined;
    items.push({ label: '', name: r.notebook.displayName, status, remote: r, properties });
  }
  const remoteNames = new Set(remote.map((r) => r.notebook.displayName.toLowerCase()));
  for (const name of local.names.filter((n) => !remoteNames.has(n.toLowerCase()))) {
    items.push({ label: '', name, status: ONLY_LOCAL });
  }
  items.sort((a, b) => STATUS_ORDER.indexOf(a.status!) - STATUS_ORDER.indexOf(b.status!) || a.name!.localeCompare(b.name!));
  const counts = STATUS_ORDER.map((s) => [s, items.filter((i) => i.status === s).length] as const).filter(([, n]) => n);
  const cancelled = remote.filter((r) => r.cancelled).length;
  const propertiesDiffer = items.filter((i) => describePropertyDifferences(i.properties ?? { differences: [] })).length;
  const summary =
    counts.map(([s, n]) => `${n} ${s}`).join(', ') +
    (propertiesDiffer ? `; ${propertiesDiffer} with a different description or folder` : '') +
    (cancelled ? ` (cancelled: ${cancelled} not fetched)` : '');
  const asOf = cache.asOf ? ` (cached from Fabric as of ${new Date(cache.asOf).toLocaleString()})` : '';
  getLogger().info(`Compared src/Notebooks with ${workspace.name}${cache.asOf ? ` as cached ${cache.asOf}` : ''}: ${summary}`);

  const picker = vscode.window.createQuickPick<CompareItem>();
  picker.title = `Fabric: Compare All Notebooks with ${workspace.name}${asOf}`;
  picker.placeholder = `${summary}. Pick one to open it (diffs: Fabric on the left).`;
  picker.ignoreFocusOut = true;
  picker.matchOnDescription = true;
  const refreshButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('refresh'),
    tooltip: 'Refresh Workspace Information, then compare again',
  };
  picker.buttons = [refreshButton];
  picker.items = items.map((i) => {
    const properties = i.properties && describePropertyDifferences(i.properties);
    return {
      ...i,
      label: `${STATUS_ICONS[i.status!]} ${i.name}`,
      description: i.remote?.cancelled
        ? 'Not Fetched (cancelled)'
        : i.status === 'Not Fetched' && i.remote?.error
          ? `Not Fetched: ${i.remote.error}`
          : `${i.status}${properties ? ` · ${properties}` : ''}`,
      buttons: i.properties?.differences.length ? [PROPERTIES_BUTTON] : [],
    };
  });
  picker.onDidAccept(() => void openComparison(picker.selectedItems[0], root, workspace, remoteDocs, settings.currentWorkspace));
  picker.onDidTriggerItemButton(({ item }) => void openPropertiesComparison(root, workspace, remoteDocs, item.name!, item.remote));
  picker.onDidTriggerButton((button) => {
    if (button === refreshButton) {
      picker.hide();
      void run('Compare All Notebooks with Workspace', async () => {
        await refresh({ ask: false, open: false });
        await compareAll(selected, notebookSettings, remoteDocs, refresh);
      });
    }
  });
  picker.onDidHide(() => picker.dispose());
  picker.show();
}

/**
 * Compares the open notebook with its current version in Fabric (one request, so it is up
 * to date), and opens a diff if they differ. Updates the notebook cache and the sync state
 * with what it found.
 */
async function compareOne(
  fabric: FabricClient,
  selected: WorkspaceService,
  notebookSettings: NotebookSettings,
  remoteDocs: RemoteDocuments,
  uri: vscode.Uri | undefined,
): Promise<CompareStatus | undefined> {
  const root = requireProjectRoot('compare notebooks in');
  const match = uri && notebookFilesFor(root, uri);
  if (!match) {
    throw new ActionNeededError('Open a notebook from src/Notebooks or .fabric-supersat/Notebooks first.');
  }
  const { files } = match;
  const workspace = await selected.resolve();
  if (!workspace) {
    return undefined;
  }
  const settings = await notebookSettings.read();
  const local = oneLocalNotebook(files);
  const source = await withProgress(`Comparing "${files.name}" with ${workspace.name}…`, async () => {
    const notebook = findByName(await fabric.listNotebooks(workspace.id), files.name);
    const sources = notebook ? await fetchNotebookSources(fabric, workspace.id, [notebook]) : [];
    const folders = new WorkspaceFolders(fabric, workspace.id);
    await addFolderPaths(sources, (folderId) => folders.pathOf(folderId));
    return sources[0];
  });
  if (!source) {
    await updateCachedNotebook(root, workspace.name, files.name, undefined);
    await recordComparison(root, workspace.name, local, files.name, ONLY_LOCAL);
    const message = `"${files.name}" is ${ONLY_LOCAL}: there is no notebook with that name in ${workspace.name}.`;
    getLogger().info(message);
    void vscode.window.showInformationMessage(message);
    return ONLY_LOCAL;
  }
  await updateCachedNotebook(root, workspace.name, source.notebook.displayName, cacheEntry(source));
  const status = await compareWithLocal(source, local, workspace.id, settings.currentWorkspace);
  await recordComparison(root, workspace.name, local, files.name, status);
  const detail =
    status === 'Not Fetched'
      ? `: ${source.error ?? 'Fabric returned no notebook content.'}`
      : status === 'Not Supported'
        ? `: ${source.unsupported ?? `Fabric stores it as ${source.gitPath}.`}`
        : '.';
  const properties = status === 'Same' || status === 'Different' ? await comparePropertiesWithLocal(source, local) : undefined;
  const propertiesNote = properties && describePropertyDifferences(properties);
  const message = `"${files.name}" compared with ${workspace.name}: ${status}${detail}${propertiesNote ? ` Its ${propertiesNote}${properties.error ? `: ${properties.error}` : ''}.` : ''}`;
  getLogger().info(message);
  const item: CompareItem = { label: '', name: files.name, status, remote: source, properties };
  if (status === 'Same' && !propertiesNote) {
    void vscode.window.showInformationMessage(`"${files.name}" is the same in src/Notebooks and ${workspace.name}, description and folder included.`);
  } else if (status === 'Same' && properties?.error) {
    void vscode.window.showWarningMessage(message);
  } else if (status === 'Same') {
    void vscode.window.showInformationMessage(`"${files.name}" has the same content in src/Notebooks and ${workspace.name}, but its ${propertiesNote}.`);
    await openComparison(item, root, workspace, remoteDocs, settings.currentWorkspace);
  } else if (status === 'Not Fetched' || status === 'Not Supported') {
    void vscode.window.showWarningMessage(message);
  } else {
    await openComparison(item, root, workspace, remoteDocs, settings.currentWorkspace);
    if (properties?.differences.length) {
      const button = 'Compare notebook.yaml';
      void vscode.window
        .showInformationMessage(`"${files.name}": its ${propertiesNote} too.`, button)
        .then((choice) => (choice === button ? openPropertiesComparison(root, workspace, remoteDocs, files.name, source) : undefined));
    }
  }
  return status;
}

/** One local notebook, for comparing just it. */
function oneLocalNotebook(files: NotebookFiles): LocalNotebooks {
  return { names: [files.name], readPy: () => readTextIfExists(files.py), readProperties: () => readNotebookProperties(files) };
}

export async function openComparison(
  item: CompareItem | undefined,
  root: vscode.Uri,
  workspace: ResolvedWorkspace,
  remoteDocs: RemoteDocuments,
  currentWorkspace: Parameters<typeof expectedLocalPy>[2],
): Promise<void> {
  if (!item?.name) {
    return;
  }
  const localPy = notebookFiles(root, item.name).py;
  const options: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: true };
  // The content is the same, so the differences worth showing are the properties.
  if (item.status === 'Same' && item.properties?.differences.length) {
    await openPropertiesComparison(root, workspace, remoteDocs, item.name, item.remote);
    return;
  }
  try {
    const source = item.remote;
    if (source?.gitText === undefined || !source.gitPath) {
      await vscode.commands.executeCommand('vscode.open', localPy, options);
      return;
    }
    // The Fabric side as downloading would write it, so "current workspace" settings don't show as differences.
    const text = source.gitPath.endsWith('.py') ? expectedLocalPy(source.gitText, workspace.id, currentWorkspace) : source.gitText;
    const remoteUri = remoteDocs.set(workspace, item.name, source.gitPath, text);
    if (item.status === 'Different' || item.status === 'Same') {
      // Asked for as text (`override: 'default'`, VS Code's text editor), not the notebook editor, so the diff shows every line.
      await vscode.commands.executeCommand(
        'vscode.diff',
        remoteUri,
        localPy,
        `${item.name}: ${workspace.name} ↔ src/Notebooks`,
        { ...options, override: 'default' },
      );
    } else {
      await vscode.commands.executeCommand('vscode.open', remoteUri, options);
    }
  } catch (err) {
    await reportError(`Open "${item.name}"`, err);
  }
}

/**
 * Opens a diff of a notebook's `notebook.yaml`: on the left as downloading it would write it
 * (Fabric's description and folder in your file), on the right your file (empty if it has none).
 */
export async function openPropertiesComparison(
  root: vscode.Uri,
  workspace: ResolvedWorkspace,
  remoteDocs: RemoteDocuments,
  name: string,
  source: RemoteNotebook | undefined,
): Promise<void> {
  try {
    if (!source?.properties) {
      throw new ActionNeededError(`"${name}"'s description and folder in ${workspace.name} aren't known yet. Run Refresh Workspace Information.`);
    }
    const files = notebookFiles(root, name);
    const existing = await readTextIfExists(files.properties);
    const fabricText = notebookPropertiesText(files.properties, existing, source.properties) ?? '';
    const left = remoteDocs.set(workspace, `${name} notebook`, 'notebook.yaml', fabricText);
    const right = existing === undefined ? remoteDocs.set(workspace, `${name} (no local notebook)`, 'notebook.yaml', '') : files.properties;
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name}/notebook.yaml: ${workspace.name} ↔ src/Notebooks`, {
      preview: true,
      preserveFocus: true,
    });
  } catch (err) {
    await reportError(`Compare "${name}" notebook.yaml`, err);
  }
}
