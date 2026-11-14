import * as vscode from 'vscode';
import { accountLabel, decodeJwt } from '../auth/jwt';
import type { FabricAuth } from '../auth/service';
import { Commands } from '../constants';
import type { FabricClient, Notebook } from '../fabric/client';
import { listLocalNotebooks, notebookFiles, readTextIfExists } from '../notebooks/files';
import {
  checkNotebookFormats,
  hasFailure,
  type NotebookFormatResult,
  renderFormatReport,
  replaceIds,
} from '../notebooks/formatTest';
import { ReferenceMapper } from '../notebooks/references';
import { fetchNotebookSources, type RemoteNotebook } from '../notebooks/remote';
import { getConfig } from '../util/config';
import { duration, withActivity } from '../util/diagnostics';
import { reportError } from '../util/errors';
import { projectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { withProgress } from '../util/progress';
import {
  collectWorkspaceMetadata,
  compareWithLocal,
  expectedLocalPy,
  type LocalNotebooks,
  type LocalStatus,
  renderMetadataMarkdown,
} from '../workspace/metadata';
import type { ResolvedWorkspace, WorkspaceService } from '../workspace/service';
import { deleteLocalStatePath, writeLocalStateFile, writeWorkspaceFile } from '../workspace/state';
import type { Feature } from './feature';

/** Read-only scheme for notebooks as they are in Fabric (the left side of Compare with Workspace's diffs). */
const REMOTE_SCHEME = 'fabric-supersat-remote';
const DIAGNOSTICS_DIR = 'diagnostics';

/**
 * Commands that look at a whole workspace without changing it or `src/`:
 *
 * - "Download Workspace Metadata": everything readable about the workspace, saved as
 *   `.fabric-supersat/workspaces/<Workspace Name>/metadata.md` and `metadata.json`.
 * - "Test Notebook Formats": checks the format conversions against every notebook as
 *   Fabric exports it; report in `.fabric-supersat/diagnostics/format-test.md`.
 * - "Compare with Workspace": which notebooks differ between `src/Notebooks` and the
 *   workspace, with a diff view of each.
 */
export const workspaceTools: Feature = {
  name: 'workspaceTools',
  activate(context, { auth, fabric, workspace: current }) {
    const remoteDocs = new RemoteDocuments();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(REMOTE_SCHEME, remoteDocs),
      vscode.commands.registerCommand(Commands.downloadWorkspaceMetadata, () =>
        run('Download Workspace Metadata', () => downloadMetadata(auth, fabric, current)),
      ),
      vscode.commands.registerCommand(Commands.testNotebookFormats, () =>
        run('Test Notebook Formats', () => testFormats(fabric, current)),
      ),
      vscode.commands.registerCommand(Commands.compareWithWorkspace, () =>
        run('Compare with Workspace', () => compare(fabric, current, remoteDocs)),
      ),
    );
  },
};

/** Runs a command: timed (see `util/diagnostics.ts`), with errors reported. */
async function run<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withActivity(title, task, (_summary, line) => getLogger().info(line));
  } catch (err) {
    await reportError(title, err);
    return undefined;
  }
}

function requireRoot(purpose: string): vscode.Uri {
  const root = projectRoot();
  if (!root) {
    throw new Error(`Open a project folder (that can be written to) to ${purpose}.`);
  }
  return root;
}

function localNotebooks(root: vscode.Uri): Promise<LocalNotebooks> {
  return listLocalNotebooks(root).then((files) => ({
    names: files.map((f) => f.name),
    readPy: (name: string) => readTextIfExists(notebookFiles(root, name).py),
  }));
}

/** A cancellable progress notification. */
function withCancellableProgress<T>(
  title: string,
  task: (report: (message: string) => void, isCancelled: () => boolean) => Promise<T>,
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: ${title}`, cancellable: true },
    (progress, token) => task((message) => progress.report({ message }), () => token.isCancellationRequested),
  );
}

// ---------------------------------------------------------------------------------------
// Download Workspace Metadata

async function downloadMetadata(auth: FabricAuth, fabric: FabricClient, current: WorkspaceService): Promise<vscode.Uri | undefined> {
  const root = requireRoot('save workspace metadata in');
  const workspace = await current.resolve();
  if (!workspace) {
    return undefined;
  }
  const options = await vscode.window.showQuickPick(
    [
      {
        label: 'Notebook details',
        description: 'slower: fetches each notebook',
        detail: 'Language, lakehouse, environment and warehouses of each notebook, and how it compares with src/Notebooks.',
        picked: true,
        id: 'notebookDetails',
      },
    ],
    {
      title: `Fabric: Download Workspace Metadata (${workspace.name})`,
      placeHolder: 'Press Enter to download. Untick what you don’t need.',
      canPickMany: true,
    },
  );
  if (!options) {
    return undefined;
  }
  const config = getConfig();
  const settings = await current.notebookSettings();
  const started = Date.now();
  const metadata = await withCancellableProgress(`Downloading metadata for ${workspace.name}`, async (report, isCancelled) =>
    collectWorkspaceMetadata(fabric, workspace, {
      notebookDetails: options.some((o) => o.id === 'notebookDetails'),
      memberRoles: config.metadata.includeMemberRoles,
      concurrency: config.fabric.maxConcurrentRequests,
      account: await signedInAccount(auth),
      local: await localNotebooks(root),
      sameWorkspace: settings.sameWorkspace,
      onProgress: report,
      isCancelled,
    }),
  );
  await writeWorkspaceFile(root, workspace.name, 'metadata.json', `${JSON.stringify(metadata, undefined, 2)}\n`);
  const md = await writeWorkspaceFile(root, workspace.name, 'metadata.md', renderMetadataMarkdown(metadata));
  const items = metadata.summary.itemTypes.reduce((sum, t) => sum + t.count, 0);
  getLogger().info(
    `Saved metadata for ${workspace.name} (${items} items, ${metadata.unavailable.length} sections not available) in ${duration(Date.now() - started)}: ${vscode.workspace.asRelativePath(md)}`,
  );
  await vscode.commands.executeCommand('markdown.showPreview', md);
  if (metadata.unavailable.length) {
    void vscode.window.showWarningMessage(
      `Saved metadata for ${workspace.name}. ${metadata.unavailable.length} section(s) weren't available; they're listed at the end.`,
    );
  }
  return md;
}

/** The signed-in account's name, from the Fabric token, for the metadata header. */
async function signedInAccount(auth: FabricAuth): Promise<string | undefined> {
  try {
    return accountLabel(decodeJwt(await auth.getToken('fabric', 'Fabric Supersat needs to sign in to read your workspace.')));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// Test Notebook Formats

async function testFormats(fabric: FabricClient, current: WorkspaceService): Promise<NotebookFormatResult[] | undefined> {
  const root = requireRoot('save the format test report in');
  const workspace = await current.resolve();
  if (!workspace) {
    return undefined;
  }
  const notebooks = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
  if (!notebooks.length) {
    void vscode.window.showInformationMessage(`No notebooks in "${workspace.name}".`);
    return undefined;
  }
  notebooks.sort((a, b) => a.displayName.localeCompare(b.displayName));
  const settings = await current.notebookSettings();
  const references = Object.values(settings.upload).includes('replace')
    ? new ReferenceMapper((id, type) => fabric.listItems(id, type), workspace.id, settings)
    : undefined;
  const results = await withCancellableProgress(`Testing notebook formats in ${workspace.name}`, async (report, isCancelled) => {
    const remote = await fetchNotebookSources(fabric, workspace.id, notebooks, {
      source: 'both',
      concurrency: getConfig().fabric.maxConcurrentRequests,
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
  await saveFailingSamples(root, results.remote, results.checked);

  const failing = results.checked.filter(hasFailure).length;
  const message = failing
    ? `Format test: ${failing} of ${results.checked.length} notebooks in ${workspace.name} failed a check.`
    : `Format test: all ${results.checked.length} notebooks in ${workspace.name} passed.`;
  getLogger().info(`${message} Report: ${vscode.workspace.asRelativePath(report)}`);
  const show = failing ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
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
    const folder = result.name.replace(/[\\/:*?"<>|]/g, '_');
    const [git, ipynb] = replaceIds([source.gitText, source.ipynbText ?? '']);
    await writeLocalStateFile(root, [DIAGNOSTICS_DIR, 'samples', folder, source.gitPath], git);
    if (source.ipynbText !== undefined) {
      await writeLocalStateFile(root, [DIAGNOSTICS_DIR, 'samples', folder, 'notebook-content.ipynb'], ipynb);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Compare with Workspace

/** Notebooks as fetched from Fabric, served read-only for diffs. */
class RemoteDocuments implements vscode.TextDocumentContentProvider {
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

interface CompareItem extends vscode.QuickPickItem {
  name?: string;
  status?: LocalStatus | 'only local';
  remote?: RemoteNotebook;
}

const STATUS_ORDER: (LocalStatus | 'only local')[] = ['different', 'only in Fabric', 'only local', 'not supported', 'not fetched', 'same'];
const STATUS_ICONS: Record<LocalStatus | 'only local', string> = {
  different: '$(diff)',
  'only in Fabric': '$(cloud)',
  'only local': '$(file)',
  'not supported': '$(circle-slash)',
  'not fetched': '$(warning)',
  same: '$(check)',
};

async function compare(fabric: FabricClient, current: WorkspaceService, remoteDocs: RemoteDocuments): Promise<void> {
  const root = requireRoot('compare notebooks in');
  const workspace = await current.resolve();
  if (!workspace) {
    return;
  }
  const local = await localNotebooks(root);
  const notebooks: Notebook[] = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
  const settings = await current.notebookSettings();
  const remote = await withCancellableProgress(`Comparing with ${workspace.name}`, (report, isCancelled) =>
    fetchNotebookSources(fabric, workspace.id, notebooks, {
      concurrency: getConfig().fabric.maxConcurrentRequests,
      isCancelled,
      onProgress: (name, done, total) => report(`${done}/${total} fetched (${name})`),
    }),
  );

  const items: CompareItem[] = [];
  for (const r of remote) {
    const status = await compareWithLocal(r, local, workspace.id, settings.sameWorkspace);
    items.push({ label: '', name: r.notebook.displayName, status, remote: r });
  }
  const remoteNames = new Set(notebooks.map((n) => n.displayName.toLowerCase()));
  for (const name of local.names.filter((n) => !remoteNames.has(n.toLowerCase()))) {
    items.push({ label: '', name, status: 'only local' });
  }
  items.sort((a, b) => STATUS_ORDER.indexOf(a.status!) - STATUS_ORDER.indexOf(b.status!) || a.name!.localeCompare(b.name!));
  const counts = STATUS_ORDER.map((s) => [s, items.filter((i) => i.status === s).length] as const).filter(([, n]) => n);
  getLogger().info(`Compared src/Notebooks with ${workspace.name}: ${counts.map(([s, n]) => `${n} ${s}`).join(', ')}`);

  const picker = vscode.window.createQuickPick<CompareItem>();
  picker.title = `Fabric: Compare with ${workspace.name}`;
  picker.placeholder = `${counts.map(([s, n]) => `${n} ${s}`).join(', ')}. Pick one to open it (diffs: Fabric on the left).`;
  picker.ignoreFocusOut = true;
  picker.matchOnDescription = true;
  picker.items = items.map((i) => ({
    ...i,
    label: `${STATUS_ICONS[i.status!]} ${i.name}`,
    description: i.status === 'not fetched' && i.remote?.error ? `not fetched: ${i.remote.error}` : i.status,
  }));
  picker.onDidAccept(() => void openComparison(picker.selectedItems[0], root, workspace, remoteDocs, settings.sameWorkspace));
  picker.onDidHide(() => picker.dispose());
  picker.show();
}

async function openComparison(
  item: CompareItem | undefined,
  root: vscode.Uri,
  workspace: ResolvedWorkspace,
  remoteDocs: RemoteDocuments,
  sameWorkspace: Parameters<typeof expectedLocalPy>[2],
): Promise<void> {
  if (!item?.name) {
    return;
  }
  const localPy = notebookFiles(root, item.name).py;
  const options: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: true };
  try {
    const source = item.remote;
    if (source?.gitText === undefined || !source.gitPath) {
      await vscode.commands.executeCommand('vscode.open', localPy, options);
      return;
    }
    // The Fabric side as downloading would write it, so "same workspace" settings don't show as differences.
    const text = source.gitPath.endsWith('.py') ? expectedLocalPy(source.gitText, workspace.id, sameWorkspace) : source.gitText;
    const remoteUri = remoteDocs.set(workspace, item.name, source.gitPath, text);
    if (item.status === 'different' || item.status === 'same') {
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
