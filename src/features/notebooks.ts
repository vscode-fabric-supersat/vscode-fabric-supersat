import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { FabricClient, Notebook } from '../fabric/client';
import { BULK_CONCURRENCY } from '../fabric/requestLimiter';
import type { ResolvedWorkspace } from '../workspace/service';
import {
  checkNotebookName,
  createNotebookFiles,
  deleteNotebookFiles,
  hasLocalCopy,
  listLocalNotebooks,
  type NewNotebookType,
  type NotebookFiles,
  notebookFiles,
  notebookFilesFor,
  notebookFolders,
  NOTEBOOKS_DIR,
  SOURCE_DIR,
  syncNotebookFiles,
} from '../notebooks/files';
import { type ReferenceMapper, referenceMapperFor, type ReferenceSettings, uploadChangesReferences } from '../notebooks/references';
import { FABRIC_NOTEBOOK_TYPE, FabricNotebookSerializer } from '../notebooks/serializer';
import { folderLabel } from '../notebooks/folders';
import {
  type BulkOptions,
  type BulkResult,
  changesDescription,
  type PlannedUpload,
  deleteNotebooks,
  downloadNotebook,
  downloadNotebooks,
  movesNotebook,
  type Placement,
  planUploads,
  runUploads,
  uploadNotebook,
} from '../notebooks/transfer';
import { ActionNeededError } from '../util/errorFix';
import { reportError } from '../util/errors';
import { changedSinceSync, readSyncState } from '../workspace/state';
import { ensureLocalStateDir, exists, localStateDir, projectRoot, requireProjectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { findByName } from '../util/names';
import { withProgress } from '../util/progress';
import type { Feature } from './feature';
import { openDocument, saveForCommand, saveNotebook } from './notebookSync';
import { registerCommand } from '../util/commands';

/**
 * Notebooks as local files, identified by name:
 *
 * - "Download Notebook": pick a notebook in the selected workspace to download it to
 *   `src/Notebooks/<Name>/<Name>.py` and `.fabric-supersat/Notebooks/<Name>/<Name>.ipynb`.
 * - "Download All Notebooks" / "Upload All Notebooks": the same for every notebook.
 * - "Delete All Notebooks in Workspace": deletes every notebook in the selected workspace
 *   (in Fabric only; local files stay), after a modal and typing the workspace name.
 * - "Delete Notebook": deletes one notebook locally, in the selected workspace, or both, as chosen.
 * - "Create New Fabric Notebook": creates both files for a new notebook and opens it.
 * - Either file opens in the notebook editor; keeping the two in sync is `notebookSync.ts`.
 * - "Save and Upload Notebook" (notebook toolbar): saves, then uploads to the selected
 *   workspace, replacing the notebook with the same name or creating it.
 * - "Switch Between .py and .ipynb" (notebook toolbar): opens the notebook's other file in
 *   place of the one open.
 */
export const notebooks: Feature = {
  name: 'notebooks',
  activate(context, { fabric, workspace: selected, notebookSettings }) {
    context.subscriptions.push(
      vscode.workspace.registerNotebookSerializer(FABRIC_NOTEBOOK_TYPE, new FabricNotebookSerializer(), {
        transientOutputs: true,
      }),

      registerCommand(Commands.downloadNotebook, 'Download Notebook', async () => {
        try {
          const workspace = await selected.resolve();
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
          const settings = await notebookSettings.read();
          const files = await withProgress(`Downloading "${picked.displayName}"…`, () =>
            downloadNotebook(fabric, root, workspace.id, picked, confirmReplace, {
              currentWorkspace: settings.currentWorkspace,
              workspaceName: workspace.name,
            }),
          );
          if (files) {
            await notebookSettings.createFile();
            getLogger().info(`Downloaded notebook "${files.name}" from ${workspace.name}`);
            await vscode.commands.executeCommand('vscode.open', files.ipynb);
          }
          return files;
        } catch (err) {
          await reportError('Download Notebook', err);
          return undefined;
        }
      }),

      registerCommand(Commands.downloadAllNotebooks, 'Download All Notebooks', async () => {
        try {
          const root = requireProjectRoot('download notebooks into');
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
          if (!items.length) {
            void vscode.window.showInformationMessage(`No notebooks in "${workspace.name}".`);
            return undefined;
          }
          items.sort((a, b) => a.displayName.localeCompare(b.displayName));
          const hasCopy = await Promise.all(items.map((item) => hasLocalCopy(notebookFiles(root, item.displayName))));
          const existing = items.filter((_, i) => hasCopy[i]).map((item) => item.displayName);
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
          // Before the loop, so creating .fabric-supersat is asked about once.
          await ensureLocalStateDir(localStateDir(root));
          await notebookSettings.createFile();
          const settings = await notebookSettings.read();
          const result = await withBulkProgress(`Downloading notebooks from ${workspace.name}`, (options) =>
            downloadNotebooks(fabric, root, workspace.id, items, replaceExisting, {
              ...options,
              currentWorkspace: settings.currentWorkspace,
              workspaceName: workspace.name,
            }),
          );
          await reportBulk('Downloaded', 'from', workspace, result);
          return result;
        } catch (err) {
          await reportError('Download All Notebooks', err);
          return undefined;
        }
      }),

      registerCommand(Commands.uploadAllNotebooks, 'Upload All Notebooks', async () => {
        try {
          const root = requireProjectRoot('upload notebooks from');
          const local = await listLocalNotebooks(root);
          if (!local.length) {
            void vscode.window.showInformationMessage('No notebooks in src/Notebooks to upload.');
            return undefined;
          }
          // Before saving, so creating .fabric-supersat is asked about once.
          await ensureLocalStateDir(localStateDir(root));
          await notebookSettings.createFile();
          const settings = await notebookSettings.read();
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
          const workspace = await selected.resolve();
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
          const create = plan.uploads.filter((u) => !u.existing).map((u) => inFolder(u.files.name, u.placement));
          const move = plan.uploads.filter((u) => movesNotebook(u.placement)).map((u) => `${u.files.name}" to "${u.placement?.to || '/'}`);
          // Notebooks changed locally since they were last downloaded from or uploaded to this
          // workspace, or in another folder or with another description than notebook.yaml says.
          const state = await readSyncState(root, workspace.name);
          const changed: PlannedUpload[] = [];
          for (const upload of plan.uploads) {
            if (movesNotebook(upload.placement) || changesDescription(upload) || (await changedSinceSync(state, upload.files.name, upload.py))) {
              changed.push(upload);
            }
          }
          const all = `Upload All (${plan.uploads.length})`;
          const onlyChanged = `Upload Changed (${changed.length})`;
          const offerChanged = changed.length > 0 && changed.length < plan.uploads.length;
          const choice = await vscode.window.showWarningMessage(
            `Upload ${plan.uploads.length} notebooks to ${workspace.name}?`,
            {
              modal: true,
              detail: [
                overwrite.length ? `Overwrite ${overwrite.length}: ${nameList(overwrite)}.` : '',
                create.length ? `Create ${create.length}: ${nameList(create)}.` : '',
                move.length ? `Move ${move.length} to the folder in their notebook.yaml ("/" is the workspace root): ${nameList(move)}.` : '',
                skipped.length ? `Skip ${skipped.length} that can't be uploaded: ${nameList(skipped.map((s) => s.name))}.` : '',
                offerChanged
                  ? `Changed here since last downloaded from or uploaded to ${workspace.name}: ${nameList(changed.map((u) => u.files.name))}. ` +
                    'Upload Changed doesn\'t see changes made in Fabric since; Upload All overwrites them.'
                  : '',
                uploadChangesReferences(settings) ? REFERENCES_NOTE : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
            ...(offerChanged ? [onlyChanged, all] : ['Upload']),
          );
          if (!choice) {
            return undefined;
          }
          const uploads = choice === onlyChanged ? changed : plan.uploads;
          if (choice === onlyChanged) {
            skipped.push(
              ...plan.uploads.filter((u) => !changed.includes(u)).map((u) => ({ name: u.files.name, reason: 'unchanged since last synced' })),
            );
          }
          const references = referenceMapper(fabric, workspace, settings);
          const result = await withBulkProgress(`Uploading notebooks to ${workspace.name}`, (options) =>
            runUploads(fabric, workspace.id, uploads, { ...options, references, workspaceName: workspace.name }),
          );
          result.skipped.push(...skipped);
          await reportBulk('Uploaded', 'to', workspace, result);
          reportKeptReferences(references, workspace);
          return result;
        } catch (err) {
          await reportError('Upload All Notebooks', err);
          return undefined;
        }
      }),

      registerCommand(Commands.deleteAllNotebooks, 'Delete All Notebooks', async () => {
        try {
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
          if (!items.length) {
            void vscode.window.showInformationMessage(`No notebooks in "${workspace.name}".`);
            return undefined;
          }
          items.sort((a, b) => a.displayName.localeCompare(b.displayName));
          if (!(await confirmDeleteAll(workspace, items.map((n) => n.displayName)))) {
            return undefined;
          }
          const result = await withBulkProgress(`Deleting notebooks from ${workspace.name}`, (options) =>
            deleteNotebooks(fabric, workspace.id, items, { ...options, root: projectRoot(), workspaceName: workspace.name }),
          );
          await reportBulk('Deleted', 'from', workspace, result);
          return result;
        } catch (err) {
          await reportError('Delete All Notebooks', err);
          return undefined;
        }
      }),

      registerCommand(Commands.deleteNotebook, 'Delete Notebook', async (arg?: unknown) => {
        try {
          const root = requireProjectRoot('delete notebooks in');
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const remoteNotebooks = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
          const uri = arg instanceof vscode.Uri ? arg : activeUri();
          const name = (uri && notebookNameFor(root, uri)) ?? (await pickNotebookToDelete(root, remoteNotebooks, workspace));
          if (!name) {
            return undefined;
          }
          const files = notebookFiles(root, name);
          const local = (await hasLocalCopy(files)) || (await exists(notebookFolders(files)[0]));
          const remote = findByName(remoteNotebooks, name);
          const scope = await confirmDeleteNotebook(files, workspace, local, remote);
          if (!scope) {
            return undefined;
          }
          if (scope !== 'Workspace Only') {
            await closeNotebookEditors(files);
          }
          const result = await deleteNotebook(fabric, files, workspace, remote, scope);
          if (result.failed) {
            const message = `Couldn't delete notebook "${name}" in ${workspace.name}: ${result.failed}${scope === 'Both' ? ' Its local files weren\'t deleted.' : ''}`;
            getLogger().warn(message);
            void vscode.window.showWarningMessage(message);
          } else {
            const where = scope === 'Both' ? `locally and in ${workspace.name}` : scope === 'Local Only' ? 'locally' : `in ${workspace.name}`;
            const message = `Deleted notebook "${name}" ${where}.`;
            getLogger().info(message);
            void vscode.window.showInformationMessage(message);
          }
          return result;
        } catch (err) {
          await reportError('Delete Notebook', err);
          return undefined;
        }
      }),

      registerCommand(Commands.newNotebook, 'Create New Fabric Notebook', async (name?: string, type?: NewNotebookType) => {
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
          await notebookSettings.createFile();
          getLogger().info(`Created ${NOTEBOOK_TYPES[type].label} notebook "${name}": ${vscode.workspace.asRelativePath(files.py)}`);
          await vscode.commands.executeCommand('vscode.open', files.py);
          return files;
        } catch (err) {
          await reportError('Create New Fabric Notebook', err);
          return undefined;
        }
      }),

      registerCommand(Commands.switchNotebookFile, 'Switch Between .py and .ipynb', async (arg?: unknown) => {
        try {
          return await switchNotebookFile(requireProjectRoot('switch notebook files in'), arg instanceof vscode.Uri ? arg : activeUri());
        } catch (err) {
          await reportError('Switch Between .py and .ipynb', err);
          return undefined;
        }
      }),

      registerCommand(Commands.uploadNotebook, 'Save and Upload Notebook', async (arg?: unknown) => {
        try {
          return await saveAndUpload(arg instanceof vscode.Uri ? arg : activeUri());
        } catch (err) {
          await reportError('Save and Upload Notebook', err);
          return undefined;
        }
      }),

    );

    async function saveAndUpload(uri: vscode.Uri | undefined): Promise<string | undefined> {
      const root = requireProjectRoot('upload notebooks from');
      const match = uri && notebookFilesFor(root, uri);
      if (!match) {
        throw new ActionNeededError('Open a notebook from src/Notebooks or .fabric-supersat/Notebooks first.');
      }
      const { files, kind } = match;
      const other = kind === 'py' ? files.ipynb : files.py;
      if (openDocument(other)?.isDirty) {
        throw new ActionNeededError(`${vscode.workspace.asRelativePath(other)} has unsaved changes. Save or revert it first.`);
      }
      const doc = openDocument(kind === 'py' ? files.py : files.ipynb);
      if (doc?.isDirty && !(await saveForCommand(doc))) {
        return undefined;
      }
      await notebookSettings.createFile();
      const settings = await notebookSettings.read();
      await syncNotebookFiles(files, kind);

      const workspace = await selected.resolve();
      if (!workspace) {
        return undefined;
      }
      const references = referenceMapper(fabric, workspace, settings);
      const result = await withProgress(`Uploading "${files.name}"…`, () =>
        uploadNotebook(
          fabric,
          files,
          workspace.id,
          (existing, placement) => confirmUpload(files, existing, placement, workspace.name, uploadChangesReferences(settings)),
          { references, workspaceName: workspace.name },
        ),
      );
      if (result) {
        const message = `${result === 'created' ? 'Created' : 'Updated'} notebook "${files.name}" in ${workspace.name}.`;
        getLogger().info(message);
        void vscode.window.showInformationMessage(message);
        reportKeptReferences(references, workspace);
      }
      return result;
    }
  },
};

export const REFERENCES_NOTE =
  "Lakehouse and environment IDs are pointed at the workspace's items of the same name, and written to the local files first " +
  '(see notebooks.upload in src/fabric-supersat.yaml).';


/** Points references at the workspace's items on upload, as the `notebooks.upload.*` settings say. */
export function referenceMapper(
  fabric: FabricClient,
  workspace: ResolvedWorkspace,
  settings: ReferenceSettings,
): ReferenceMapper | undefined {
  return referenceMapperFor((id, type) => fabric.listItems(id, type), workspace.id, settings);
}

/** Warns when uploaded notebooks still point at lakehouses or environments outside the workspace. */
export function reportKeptReferences(references: ReferenceMapper | undefined, workspace: ResolvedWorkspace): void {
  if (!references?.kept.length) {
    return;
  }
  const count = references.kept.length;
  void vscode.window
    .showWarningMessage(
      `${count} lakehouse or environment reference${count === 1 ? '' : 's'} couldn't be matched to an item in ` +
        `${workspace.name} and ${count === 1 ? 'was' : 'were'} uploaded unchanged.`,
      'Show Log',
    )
    .then((choice) => choice && getLogger().show());
}

/** Runs a bulk operation with a cancellable progress notification counting notebooks. */
export function withBulkProgress(title: string, run: (options: BulkOptions) => Promise<BulkResult>): Thenable<BulkResult> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: ${title}`, cancellable: true },
    (progress, token) =>
      run({
        isCancelled: () => token.isCancellationRequested,
        onProgress: (name, done, total) => progress.report({ message: `${done}/${total} done (${name})`, increment: 100 / total }),
        // More notebooks than request slots, as most of each one's time is waiting on Fabric: the client's limiter decides how many requests actually run.
        concurrency: BULK_CONCURRENCY,
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

export type DeleteScope = 'Local Only' | 'Workspace Only' | 'Both';

/** The delete choices that apply: local only if it has local files, workspace only if it's in the workspace. */
export function deleteScopes(local: boolean, remote: boolean): DeleteScope[] {
  return local && remote ? ['Both', 'Local Only', 'Workspace Only'] : local ? ['Local Only'] : remote ? ['Workspace Only'] : [];
}

/**
 * Deletes a notebook as `scope` says. The workspace's copy goes first (recorded in the
 * history, and forgotten in the sync state and notebook cache); if Fabric refuses, the
 * local files are left alone and `failed` says why. Local files are moved to the trash where possible.
 */
export async function deleteNotebook(
  client: FabricClient,
  files: NotebookFiles,
  workspace: { id: string; name: string },
  remote: Pick<Notebook, 'id' | 'displayName'> | undefined,
  scope: DeleteScope,
): Promise<{ failed?: string; deletedFolders: vscode.Uri[] }> {
  // Checked before anything is deleted, so "Both" doesn't stop halfway.
  if (scope !== 'Workspace Only') {
    for (const uri of [files.py, files.ipynb, files.properties]) {
      if (openDocument(uri)?.isDirty) {
        throw new ActionNeededError(`${vscode.workspace.asRelativePath(uri)} has unsaved changes. Save or revert it first.`);
      }
    }
  }
  if (scope !== 'Local Only') {
    if (!remote) {
      throw new ActionNeededError(`Notebook "${files.name}" isn't in ${workspace.name}.`);
    }
    const result = await deleteNotebooks(client, workspace.id, [remote], { root: files.root, workspaceName: workspace.name });
    // A refusal the user can see to (e.g. 403) counts as skipped, not failed: either way it wasn't deleted.
    if (!result.done.length) {
      return { failed: result.failed[0]?.reason ?? result.skipped[0]?.reason ?? 'Not deleted.', deletedFolders: [] };
    }
  }
  if (scope === 'Workspace Only') {
    return { deletedFolders: [] };
  }
  return { deletedFolders: await deleteNotebookFiles(files) };
}

/** The notebook a file or folder belongs to: either of its files, or its `src/Notebooks/<Name>` folder. */
function notebookNameFor(root: vscode.Uri, uri: vscode.Uri): string | undefined {
  const match = notebookFilesFor(root, uri);
  if (match) {
    return match.files.name;
  }
  const prefix = vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOKS_DIR).path + '/';
  const rest = uri.scheme === root.scheme && uri.authority === root.authority && uri.path.startsWith(prefix) ? uri.path.slice(prefix.length) : '';
  return rest && !rest.includes('/') ? rest : undefined;
}

/** Picks a notebook to delete from the local ones and the workspace's, saying where each is. */
async function pickNotebookToDelete(root: vscode.Uri, remoteNotebooks: readonly Notebook[], workspace: ResolvedWorkspace): Promise<string | undefined> {
  const localNames = (await listLocalNotebooks(root)).map((f) => f.name);
  const names = new Map<string, { local: boolean; remote: boolean }>();
  localNames.forEach((n) => names.set(n.toLowerCase(), { local: true, remote: false }));
  const display = new Map(localNames.map((n) => [n.toLowerCase(), n]));
  for (const n of remoteNotebooks) {
    const key = n.displayName.toLowerCase();
    names.set(key, { local: names.get(key)?.local ?? false, remote: true });
    if (!display.has(key)) {
      display.set(key, n.displayName);
    }
  }
  if (!names.size) {
    void vscode.window.showInformationMessage(`No notebooks in src/Notebooks or ${workspace.name}.`);
    return undefined;
  }
  const items = [...names].map(([key, where]) => ({
    label: display.get(key)!,
    description: where.local && where.remote ? `local and in ${workspace.name}` : where.local ? 'local only' : `in ${workspace.name} only`,
  }));
  items.sort((a, b) => a.label.localeCompare(b.label));
  const picked = await vscode.window.showQuickPick(items, { title: 'Fabric: Delete Notebook', placeHolder: 'Pick a notebook to delete', matchOnDescription: true });
  return picked?.label;
}

/** Asks where to delete a notebook, offering only the choices that apply. */
async function confirmDeleteNotebook(
  files: NotebookFiles,
  workspace: ResolvedWorkspace,
  local: boolean,
  remote: Notebook | undefined,
): Promise<DeleteScope | undefined> {
  const scopes = deleteScopes(local, !!remote);
  if (!scopes.length) {
    void vscode.window.showInformationMessage(`Notebook "${files.name}" isn't in src/Notebooks or ${workspace.name}.`);
    return undefined;
  }
  const [source, localDir] = notebookFolders(files);
  const detail = [
    local
      ? `Local: deletes ${vscode.workspace.asRelativePath(source)}/ (with everything in it) and ${vscode.workspace.asRelativePath(localDir)}/, ` +
        'moved to the trash where possible. Source control can restore committed files.'
      : `It has no local files.`,
    remote
      ? `Workspace: deletes it in ${workspace.name}, for everyone using the workspace. Fabric keeps it in the workspace's recycle bin only if it has one turned on.`
      : `It isn't in ${workspace.name}.`,
  ].join('\n\n');
  return vscode.window.showWarningMessage(`Delete notebook "${files.name}"?`, { modal: true, detail }, ...scopes);
}

/** Closes editors showing a notebook's files (they are about to be deleted). Unsaved ones are left for `deleteNotebook` to refuse. */
export async function closeNotebookEditors(files: NotebookFiles): Promise<void> {
  const folders = notebookFolders(files).map((f) => `${f.toString()}/`);
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => {
      const uri = tabUri(t);
      return uri && !openDocument(uri)?.isDirty && folders.some((f) => uri.toString().startsWith(f));
    });
  if (tabs.length) {
    await vscode.window.tabGroups.close(tabs, true);
  }
}

/**
 * Asks twice before deleting every notebook in a workspace: a modal listing them, then
 * typing the workspace's name, so a slip of the keyboard can't delete them.
 */
async function confirmDeleteAll(workspace: ResolvedWorkspace, names: readonly string[]): Promise<boolean> {
  const count = `${names.length} notebook${names.length === 1 ? '' : 's'}`;
  const button = `Delete ${count}`;
  const choice = await vscode.window.showWarningMessage(
    `Delete all ${count} in ${workspace.name}?`,
    {
      modal: true,
      detail:
        `${nameList(names)}.\n\n` +
        'They are deleted in Fabric, for everyone using the workspace. Fabric keeps them in the workspace\'s ' +
        'recycle bin only if it has one turned on. Your local files aren\'t changed, so you can upload them again.',
    },
    button,
  );
  if (choice !== button) {
    return false;
  }
  const typed = await vscode.window.showInputBox({
    title: `Fabric: Delete All Notebooks (${workspace.name})`,
    prompt: `Type the workspace name, ${workspace.name}, to delete its ${count}.`,
    placeHolder: workspace.name,
    ignoreFocusOut: true,
    validateInput: (value) => (value === workspace.name ? undefined : 'Type the workspace name exactly, or press Escape to cancel.'),
  });
  return typed === workspace.name;
}

/** A new notebook's name for a list, with the folder it's created in (if not the workspace root). */
function inFolder(name: string, placement: Placement | undefined): string {
  return placement?.to ? `${name}" in "${placement.to}` : name;
}

/** Names for a dialog: all of them, or the first few and a count. */
export function nameList(names: readonly string[], max = 12): string {
  const shown = names.slice(0, max).map((n) => `"${n}"`);
  return names.length > max ? `${shown.join(', ')} and ${names.length - max} more` : shown.join(', ');
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
      placeHolder: 'Notebook type (Spark SQL, T-SQL, Scala and SparkR notebooks aren’t supported yet)',
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

async function confirmUpload(
  files: NotebookFiles,
  existing: Notebook | undefined,
  placement: Placement | undefined,
  workspaceName: string,
  changesReferences: boolean,
): Promise<boolean> {
  const action = existing ? 'Overwrite' : 'Create';
  const folderNote = movesNotebook(placement)
    ? `It will be moved from ${folderLabel(placement.from)} to ${folderLabel(placement.to)}, as its notebook.yaml says.`
    : !existing && placement?.to
      ? `It will be created in ${folderLabel(placement.to)} (and any of its folders that don't exist yet), as its notebook.yaml says.`
      : '';
  const choice = await vscode.window.showWarningMessage(
    existing
      ? `Overwrite notebook "${files.name}" in ${workspaceName}?`
      : `Create notebook "${files.name}" in ${workspaceName}?`,
    {
      modal: true,
      detail: [
        existing
          ? `The notebook in Fabric will be replaced with ${vscode.workspace.asRelativePath(files.py)}.`
          : `There is no notebook named "${files.name}" in ${workspaceName} yet.`,
        folderNote,
        changesReferences ? REFERENCES_NOTE : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    action,
  );
  return choice === action;
}

/**
 * Opens a notebook's other file (`.py` ↔ `.ipynb`) where the open one is, and closes the
 * open one unless it has unsaved changes. A missing other file is generated from this one
 * first (as saving would). Returns the file opened.
 */
export async function switchNotebookFile(root: vscode.Uri, uri: vscode.Uri | undefined): Promise<vscode.Uri> {
  const match = uri && notebookFilesFor(root, uri);
  if (!match) {
    throw new ActionNeededError('Open a notebook from src/Notebooks or .fabric-supersat/Notebooks first.');
  }
  const { files, kind } = match;
  const current = kind === 'py' ? files.py : files.ipynb;
  const other = kind === 'py' ? files.ipynb : files.py;
  if (!(await exists(other))) {
    if (!(await exists(current))) {
      throw new ActionNeededError(`Save ${vscode.workspace.asRelativePath(current)} first, so its ${kind === 'py' ? '.ipynb' : '.py'} can be created.`);
    }
    await syncNotebookFiles(files, kind);
  }
  const tab = vscode.window.tabGroups.activeTabGroup.tabs.find((t) => tabUri(t)?.toString() === current.toString());
  const viewColumn = tab?.group.viewColumn ?? vscode.ViewColumn.Active;
  await vscode.commands.executeCommand('vscode.open', other, { viewColumn, preview: false });
  const dirty = openDocument(current)?.isDirty;
  if (dirty) {
    void vscode.window.showInformationMessage(
      `${vscode.workspace.asRelativePath(current)} has unsaved changes, so it stays open. Save it to update ${vscode.workspace.asRelativePath(other)}.`,
    );
  } else if (tab) {
    await vscode.window.tabGroups.close(tab, true);
  }
  return other;
}

/** The file a tab shows, for text and notebook editors. */
function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  return input instanceof vscode.TabInputText || input instanceof vscode.TabInputNotebook || input instanceof vscode.TabInputCustom ? input.uri : undefined;
}

function activeUri(): vscode.Uri | undefined {
  return vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
}
