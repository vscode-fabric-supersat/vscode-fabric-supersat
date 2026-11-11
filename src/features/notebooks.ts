import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { Notebook } from '../fabric/client';
import type { ResolvedWorkspace } from '../workspace/service';
import {
  checkNotebookName,
  createNotebookFiles,
  hasLocalCopy,
  listLocalNotebooks,
  type NewNotebookType,
  type NotebookFiles,
  notebookFiles,
  notebookFilesFor,
  NotFabricNotebookError,
  refreshIpynbIfStale,
  syncNotebookFiles,
  wasWrittenByExtension,
} from '../notebooks/files';
import { FABRIC_NOTEBOOK_TYPE, FabricNotebookSerializer } from '../notebooks/serializer';
import {
  type BulkOptions,
  type BulkResult,
  downloadNotebook,
  downloadNotebooks,
  planUploads,
  runUploads,
  uploadNotebook,
} from '../notebooks/transfer';
import { reportError } from '../util/errors';
import { exists, projectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { withProgress } from '../util/progress';
import type { Feature } from './feature';

/**
 * Notebooks as local files, identified by name:
 *
 * - "Download Notebook": pick a notebook in the current workspace to download it to
 *   `src/Notebooks/<Name>/<Name>.py` and `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`.
 * - "Download All Notebooks" / "Upload All Notebooks": the same for every notebook.
 * - "Create New Fabric Notebook": creates both files for a new notebook and opens it.
 * - Either file opens in the notebook editor; saving one updates the other.
 * - The `.py` is the source of truth: when it changes on disk by other means (git discard,
 *   checkout, pull), or is newer at startup, the `.ipynb` is regenerated from it.
 * - "Save and Upload Notebook" (notebook toolbar): saves, then uploads to the current
 *   workspace, replacing the notebook with the same name or creating it.
 */
export const notebooks: Feature = {
  name: 'notebooks',
  activate(context, { fabric, workspace: current }) {
    context.subscriptions.push(
      vscode.workspace.registerNotebookSerializer(FABRIC_NOTEBOOK_TYPE, new FabricNotebookSerializer(), {
        transientOutputs: true,
      }),

      vscode.commands.registerCommand(Commands.downloadNotebook, async () => {
        try {
          const workspace = await current.resolve();
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
          getLogger().info(`Workspace ${workspace.name} (${workspace.id}): ${items.length} notebook(s)`);
          const picked = await pickNotebook(items, workspace.name);
          if (!picked) {
            return undefined;
          }
          const root = requireProjectRoot('download notebooks into');
          const files = await withProgress(`Downloading "${picked.displayName}"…`, () =>
            downloadNotebook(fabric, root, workspace.id, picked, confirmReplace),
          );
          if (files) {
            getLogger().info(`Downloaded notebook "${files.name}" from ${workspace.name}`);
            await vscode.commands.executeCommand('vscode.open', files.ipynb);
          }
          return files;
        } catch (err) {
          await reportError('Download notebook', err);
          return undefined;
        }
      }),

      vscode.commands.registerCommand(Commands.downloadAllNotebooks, async () => {
        try {
          const root = requireProjectRoot('download notebooks into');
          const workspace = await current.resolve();
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
          if (!items.length) {
            void vscode.window.showInformationMessage(`No notebooks in "${workspace.name}".`);
            return undefined;
          }
          items.sort((a, b) => a.displayName.localeCompare(b.displayName));
          const existing: string[] = [];
          for (const item of items) {
            if (await hasLocalCopy(notebookFiles(root, item.displayName))) {
              existing.push(item.displayName);
            }
          }
          let replaceExisting = false;
          if (existing.length) {
            const choice = await vscode.window.showWarningMessage(
              `Download ${items.length} notebooks from ${workspace.name}?`,
              {
                modal: true,
                detail:
                  `${existing.length} already have local copies: ${nameList(existing)}.\n\n` +
                  'Replacing them loses changes you haven\'t uploaded.',
              },
              'Replace Existing',
              'Skip Existing',
            );
            if (!choice) {
              return undefined;
            }
            replaceExisting = choice === 'Replace Existing';
          }
          const result = await withBulkProgress(`Downloading notebooks from ${workspace.name}`, (options) =>
            downloadNotebooks(fabric, root, workspace.id, items, replaceExisting, options),
          );
          await reportBulk('Downloaded', 'from', workspace, result);
          return result;
        } catch (err) {
          await reportError('Download all notebooks', err);
          return undefined;
        }
      }),

      vscode.commands.registerCommand(Commands.uploadAllNotebooks, async () => {
        try {
          const root = requireProjectRoot('upload notebooks from');
          const local = await listLocalNotebooks(root);
          if (!local.length) {
            void vscode.window.showInformationMessage('No notebooks in src/Notebooks to upload.');
            return undefined;
          }
          // Upload what's on screen: save open notebooks first (which also syncs their other file).
          const ready: NotebookFiles[] = [];
          const notSaved: { name: string; reason: string }[] = [];
          for (const files of local) {
            try {
              await saveNotebook(files);
              ready.push(files);
            } catch (err) {
              notSaved.push({ name: files.name, reason: err instanceof Error ? err.message : String(err) });
            }
          }
          const workspace = await current.resolve();
          if (!workspace) {
            return undefined;
          }
          const plan = await withProgress('Checking notebooks…', () => planUploads(fabric, workspace.id, ready));
          const skipped = [...notSaved, ...plan.skipped];
          if (!plan.uploads.length) {
            await reportBulk('Uploaded', 'to', workspace, { done: [], skipped, failed: [], cancelled: false });
            return undefined;
          }
          const overwrite = plan.uploads.filter((u) => u.existing).map((u) => u.files.name);
          const create = plan.uploads.filter((u) => !u.existing).map((u) => u.files.name);
          const choice = await vscode.window.showWarningMessage(
            `Upload ${plan.uploads.length} notebooks to ${workspace.name}?`,
            {
              modal: true,
              detail: [
                overwrite.length ? `Overwrite ${overwrite.length}: ${nameList(overwrite)}.` : '',
                create.length ? `Create ${create.length}: ${nameList(create)}.` : '',
                skipped.length ? `Skip ${skipped.length} that can't be uploaded: ${nameList(skipped.map((s) => s.name))}.` : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
            'Upload',
          );
          if (choice !== 'Upload') {
            return undefined;
          }
          const result = await withBulkProgress(`Uploading notebooks to ${workspace.name}`, (options) =>
            runUploads(fabric, workspace.id, plan.uploads, options),
          );
          result.skipped.push(...skipped);
          await reportBulk('Uploaded', 'to', workspace, result);
          return result;
        } catch (err) {
          await reportError('Upload all notebooks', err);
          return undefined;
        }
      }),

      vscode.commands.registerCommand(Commands.newNotebook, async (name?: string, type?: NewNotebookType) => {
        try {
          const root = requireProjectRoot('create notebooks in');
          type ??= await pickNotebookType();
          if (!type) {
            return undefined;
          }
          name ??= await vscode.window.showInputBox({
            title: `Fabric: Create New Fabric Notebook (${NOTEBOOK_TYPES[type].label})`,
            prompt: 'Notebook name. It is also the folder and file name, and the name used in Fabric on upload.',
            placeHolder: 'e.g. Load Sales',
            validateInput: async (value) => {
              try {
                checkNotebookName(value);
              } catch (err) {
                return err instanceof Error ? err.message.replace(/ Rename it in Fabric\.$/, '') : String(err);
              }
              const files = notebookFiles(root, value);
              return (await exists(files.py)) || (await exists(files.ipynb))
                ? `A notebook named "${value}" already exists in this project.`
                : undefined;
            },
          });
          if (!name) {
            return undefined;
          }
          const files = notebookFiles(root, name);
          await createNotebookFiles(files, type);
          getLogger().info(`Created ${NOTEBOOK_TYPES[type].label} notebook "${name}": ${vscode.workspace.asRelativePath(files.py)}`);
          await vscode.commands.executeCommand('vscode.open', files.py);
          return files;
        } catch (err) {
          await reportError('Create notebook', err);
          return undefined;
        }
      }),

      vscode.commands.registerCommand(Commands.uploadNotebook, async (arg?: unknown) => {
        try {
          return await saveAndUpload(arg instanceof vscode.Uri ? arg : activeUri());
        } catch (err) {
          await reportError('Upload notebook', err);
          return undefined;
        }
      }),

      vscode.workspace.onDidSaveNotebookDocument((doc) => void syncAfterSave(doc.uri)),
      vscode.workspace.onDidSaveTextDocument((doc) => void syncAfterSave(doc.uri)),
      ...watchSourceNotebooks(),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshStaleNotebooks()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => void refreshStaleNotebooks()),
    );
    void refreshStaleNotebooks();

    async function saveAndUpload(uri: vscode.Uri | undefined): Promise<string | undefined> {
      const root = requireProjectRoot('upload notebooks from');
      const match = uri && notebookFilesFor(root, uri);
      if (!match) {
        throw new Error('Open a notebook from src/Notebooks or .fabric-supersat/Notebooks first.');
      }
      const { files, kind } = match;
      const other = kind === 'py' ? files.ipynb : files.py;
      if (openDocument(other)?.isDirty) {
        throw new Error(`${vscode.workspace.asRelativePath(other)} has unsaved changes. Save or revert it first.`);
      }
      const doc = openDocument(kind === 'py' ? files.py : files.ipynb);
      if (doc?.isDirty && !(await doc.save())) {
        return undefined;
      }
      await syncNotebookFiles(files, kind);

      const workspace = await current.resolve();
      if (!workspace) {
        return undefined;
      }
      const result = await withProgress(`Uploading "${files.name}"…`, () =>
        uploadNotebook(fabric, files, workspace.id, (existing) => confirmUpload(files, existing, workspace.name)),
      );
      if (result) {
        const message = `${result === 'created' ? 'Created' : 'Updated'} notebook "${files.name}" in ${workspace.name}.`;
        getLogger().info(message);
        void vscode.window.showInformationMessage(message);
      }
      return result;
    }
  },
};

/**
 * Watches each `src/Notebooks/<Name>/<Name>.py` so a `.py` changed outside the editor (git discard,
 * checkout, pull, another tool) regenerates its `.ipynb`. The extension's own writes are
 * ignored, and changes are debounced so a burst (e.g. a branch switch) syncs each file once.
 */
function watchSourceNotebooks(): vscode.Disposable[] {
  const watcher = vscode.workspace.createFileSystemWatcher('**/src/Notebooks/*/*.py');
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const onChange = (uri: vscode.Uri) => {
    if (wasWrittenByExtension(uri)) {
      return;
    }
    clearTimeout(pending.get(uri.toString()));
    pending.set(
      uri.toString(),
      setTimeout(() => {
        pending.delete(uri.toString());
        void syncFromDisk(uri);
      }, 300),
    );
  };
  return [
    watcher,
    watcher.onDidChange(onChange),
    watcher.onDidCreate(onChange),
    { dispose: () => pending.forEach((timer) => clearTimeout(timer)) },
  ];
}

/** Regenerates a notebook's `.ipynb` from its `.py` after the `.py` changed on disk. */
async function syncFromDisk(uri: vscode.Uri): Promise<void> {
  // Nothing is written automatically in Restricted Mode: the folder's files may not be the user's.
  if (!vscode.workspace.isTrusted) {
    return;
  }
  const root = projectRoot();
  const match = root && notebookFilesFor(root, uri);
  if (match?.kind !== 'py') {
    return;
  }
  const { files } = match;
  if (openDocument(files.ipynb)?.isDirty) {
    void vscode.window.showWarningMessage(
      `${vscode.workspace.asRelativePath(files.py)} changed on disk, but ${vscode.workspace.asRelativePath(files.ipynb)} has unsaved changes, so it wasn't updated.`,
    );
    return;
  }
  try {
    if (await syncNotebookFiles(files, 'py')) {
      getLogger().info(`Updated ${vscode.workspace.asRelativePath(files.ipynb)}: ${vscode.workspace.asRelativePath(files.py)} changed on disk`);
    }
  } catch (err) {
    // A plain Python file at a notebook's path, or a half-written file: nothing to sync.
    getLogger().debug(`Not synced from disk: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** At startup (and when folders change or become trusted): regenerate each `.ipynb` whose `.py` is newer, or missing. */
async function refreshStaleNotebooks(): Promise<void> {
  const root = projectRoot();
  // Not in Restricted Mode; runs again when the folder is trusted.
  if (!root || !vscode.workspace.isTrusted) {
    return;
  }
  try {
    for (const files of await listLocalNotebooks(root)) {
      if (openDocument(files.ipynb)?.isDirty) {
        continue;
      }
      try {
        if (await refreshIpynbIfStale(files)) {
          getLogger().info(`Updated ${vscode.workspace.asRelativePath(files.ipynb)} from ${vscode.workspace.asRelativePath(files.py)}`);
        }
      } catch (err) {
        getLogger().debug(`Not refreshed: ${files.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    getLogger().warn('Checking notebooks at startup failed', err);
  }
}

/**
 * Saves a notebook's open, unsaved file (if any) and updates its other file. Throws if both
 * files have unsaved changes, since one would overwrite the other.
 */
async function saveNotebook(files: NotebookFiles): Promise<void> {
  const py = openDocument(files.py);
  const ipynb = openDocument(files.ipynb);
  if (py?.isDirty && ipynb?.isDirty) {
    throw new Error('both of its files have unsaved changes. Save one and revert the other');
  }
  const [doc, kind] = py?.isDirty ? [py, 'py' as const] : ipynb?.isDirty ? [ipynb, 'ipynb' as const] : [];
  if (doc && kind) {
    if (!(await doc.save())) {
      throw new Error('its unsaved changes couldn\'t be saved');
    }
    await syncNotebookFiles(files, kind);
  }
}

/** Runs a bulk operation with a cancellable progress notification counting notebooks. */
function withBulkProgress(title: string, run: (options: BulkOptions) => Promise<BulkResult>): Thenable<BulkResult> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: ${title}`, cancellable: true },
    (progress, token) =>
      run({
        isCancelled: () => token.isCancellationRequested,
        onProgress: (name, index, total) =>
          progress.report({ message: `${index + 1}/${total}: ${name}`, increment: index ? 100 / total : 0 }),
      }),
  );
}

/** Logs a bulk result notebook by notebook and shows a summary, with the log a click away if anything was left out. */
async function reportBulk(verb: string, preposition: string, workspace: ResolvedWorkspace, result: BulkResult): Promise<void> {
  const log = getLogger();
  result.done.forEach((name) => log.info(`${verb} notebook "${name}" ${preposition} ${workspace.name}`));
  result.skipped.forEach(({ name, reason }) => log.warn(`Skipped notebook "${name}": ${reason}`));
  result.failed.forEach(({ name, reason }) => log.error(`Notebook "${name}" failed: ${reason}`));
  const parts = [
    `${verb} ${result.done.length} notebook${result.done.length === 1 ? '' : 's'} ${preposition} ${workspace.name}.`,
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

/** Names for a dialog: all of them, or the first few and a count. */
function nameList(names: readonly string[], max = 12): string {
  const shown = names.slice(0, max).map((n) => `"${n}"`);
  return names.length > max ? `${shown.join(', ')} and ${names.length - max} more` : shown.join(', ');
}

/** After one of a notebook's files is saved, updates the other one. */
async function syncAfterSave(uri: vscode.Uri): Promise<void> {
  const root = projectRoot();
  const match = root && notebookFilesFor(root, uri);
  if (!match) {
    return;
  }
  const other = match.kind === 'py' ? match.files.ipynb : match.files.py;
  if (openDocument(other)?.isDirty) {
    void vscode.window.showWarningMessage(
      `${vscode.workspace.asRelativePath(other)} has unsaved changes, so it wasn't updated from the file you saved.`,
    );
    return;
  }
  try {
    await syncNotebookFiles(match.files, match.kind);
    getLogger().debug(`Updated ${vscode.workspace.asRelativePath(other)}`);
  } catch (err) {
    if (err instanceof NotFabricNotebookError) {
      getLogger().warn(`Not synced: ${err.message}`);
      void vscode.window.showWarningMessage(`Not synced: ${err.message}`);
      return;
    }
    await reportError(`Update ${vscode.workspace.asRelativePath(other)}`, err);
  }
}

/** The notebook types offered by "Create New Fabric Notebook": those using Fabric's .py format. */
const NOTEBOOK_TYPES: Readonly<Record<NewNotebookType, { label: string; description: string }>> = {
  pyspark: { label: 'PySpark', description: 'Python on Spark, Fabric’s default' },
  python: { label: 'Python', description: 'Python without Spark, lighter and quicker to start' },
};

async function pickNotebookType(): Promise<NewNotebookType | undefined> {
  const picked = await vscode.window.showQuickPick(
    (Object.keys(NOTEBOOK_TYPES) as NewNotebookType[]).map((type) => ({
      label: NOTEBOOK_TYPES[type].label,
      description: NOTEBOOK_TYPES[type].description,
      type,
    })),
    {
      title: 'Fabric: Create New Fabric Notebook',
      placeHolder: 'Notebook type (Spark SQL, Scala and SparkR notebooks aren’t supported yet)',
    },
  );
  return picked?.type;
}

async function pickNotebook(items: Notebook[], workspaceName: string): Promise<Notebook | undefined> {
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`No notebooks in "${workspaceName}".`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    items
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((nb) => ({ label: nb.displayName, description: nb.description, nb })),
    {
      title: `Fabric: Notebooks in ${workspaceName} (${items.length})`,
      placeHolder: 'Select a notebook to download',
      matchOnDescription: true,
    },
  );
  return picked?.nb;
}

async function confirmReplace(files: NotebookFiles): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Replace your local copy of "${files.name}"?`,
    {
      modal: true,
      detail: `${vscode.workspace.asRelativePath(files.py)} and ${vscode.workspace.asRelativePath(files.ipynb)} will be replaced with the notebook from Fabric. Changes you haven't uploaded will be lost.`,
    },
    'Replace',
  );
  return choice === 'Replace';
}

async function confirmUpload(files: NotebookFiles, existing: Notebook | undefined, workspaceName: string): Promise<boolean> {
  const action = existing ? 'Overwrite' : 'Create';
  const choice = await vscode.window.showWarningMessage(
    existing
      ? `Overwrite notebook "${files.name}" in ${workspaceName}?`
      : `Create notebook "${files.name}" in ${workspaceName}?`,
    {
      modal: true,
      detail: existing
        ? `The notebook in Fabric will be replaced with ${vscode.workspace.asRelativePath(files.py)}.`
        : `There is no notebook named "${files.name}" in ${workspaceName} yet.`,
    },
    action,
  );
  return choice === action;
}

function requireProjectRoot(purpose: string): vscode.Uri {
  const root = projectRoot();
  if (!root) {
    throw new Error(`Open a project folder (that can be written to) to ${purpose}.`);
  }
  return root;
}

function activeUri(): vscode.Uri | undefined {
  return vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
}

/** The open notebook or text document for `uri`, if any. */
function openDocument(uri: vscode.Uri): vscode.NotebookDocument | vscode.TextDocument | undefined {
  const key = uri.toString();
  return (
    vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === key) ??
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === key)
  );
}
