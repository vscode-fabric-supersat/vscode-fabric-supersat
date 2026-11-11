/**
 * Environment commands: "Download Environment" and "Download All Environments" write each
 * environment's definition into `src/Environments/<Name>/`; "Upload Environment" and
 * "Upload All Environments" send it back (to Fabric's saved state); "Publish Environment"
 * publishes the saved state, and watches it (see `src/environments/`).
 */
import * as vscode from 'vscode';
import { Commands } from '../constants';
import { type EnvironmentFiles, environmentFiles, environmentFilesFor, listLocalEnvironments } from '../environments/files';
import { publishEnvironment } from '../environments/publish';
import {
  downloadEnvironment,
  downloadEnvironments,
  type EnvironmentInfo,
  type PlannedEnvironmentUpload,
  planEnvironmentUploads,
  uploadEnvironment,
  uploadEnvironments,
} from '../environments/transfer';
import type { FabricClient } from '../fabric/client';
import { folderLabel } from '../notebooks/folders';
import { ActionNeededError } from '../util/errorFix';
import { itemChangedSinceSync, readSyncState } from '../workspace/state';
import type { BulkResult } from '../items/bulk';
import { registerCommand } from '../util/commands';
import { reportError } from '../util/errors';
import { exists, requireProjectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { notify } from '../util/notify';
import { withProgress } from '../util/progress';
import type { ResolvedWorkspace } from '../workspace/service';
import type { Feature } from './feature';
import { nameList, withBulkProgress } from './notebooks';

export const environments: Feature = {
  name: 'environments',
  activate(context, { fabric, workspace: selected }) {
    context.subscriptions.push(
      registerCommand(Commands.downloadEnvironment, 'Download Environment', async () => {
        try {
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading environments…', () => fabric.listEnvironments(workspace.id));
          const picked = await pickEnvironment(items, workspace.name);
          if (!picked) {
            return undefined;
          }
          const root = requireProjectRoot('download environments into');
          const files = await withProgress(`Downloading "${picked.displayName}"…`, () =>
            downloadEnvironment(fabric, root, workspace.id, picked, confirmReplace, { workspaceName: workspace.name }),
          );
          if (files) {
            getLogger().info(`Downloaded environment "${files.name}" from ${workspace.name}`);
            await vscode.commands.executeCommand('revealInExplorer', files.folder);
          }
          return files;
        } catch (err) {
          await reportError('Download Environment', err);
          return undefined;
        }
      }),

      registerCommand(Commands.downloadAllEnvironments, 'Download All Environments', async () => {
        try {
          const root = requireProjectRoot('download environments into');
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading environments…', () => fabric.listEnvironments(workspace.id));
          if (!items.length) {
            void vscode.window.showInformationMessage(`No environments in "${workspace.name}".`);
            return undefined;
          }
          items.sort((a, b) => a.displayName.localeCompare(b.displayName));
          const hasCopy = await Promise.all(items.map((item) => exists(environmentFiles(root, item.displayName).folder)));
          const existing = items.filter((_, i) => hasCopy[i]).map((item) => item.displayName);
          let replaceExisting = false;
          if (existing.length) {
            const choice = await vscode.window.showWarningMessage(
              `Download ${items.length} environments from ${workspace.name}?`,
              {
                modal: true,
                detail: `${existing.length} already have local copies: ${nameList(existing)}.\n\nReplacing them loses local changes.`,
              },
              'Replace Existing',
              'Skip Existing',
            );
            if (!choice) {
              return undefined;
            }
            replaceExisting = choice === 'Replace Existing';
          }
          const result = await withBulkProgress(`Downloading environments from ${workspace.name}`, (options) =>
            downloadEnvironments(fabric, root, workspace.id, items, replaceExisting, { ...options, workspaceName: workspace.name }),
          );
          reportBulk(workspace, result);
          return result;
        } catch (err) {
          await reportError('Download All Environments', err);
          return undefined;
        }
      }),

      registerCommand(Commands.uploadEnvironment, 'Upload Environment', async (arg?: unknown) => {
        try {
          const root = requireProjectRoot('upload environments from');
          const files = await environmentToUpload(root, arg);
          if (!files) {
            return undefined;
          }
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          await saveEnvironmentFiles([files]);
          const plan = await withProgress('Checking the workspace…', () => planEnvironmentUploads(fabric, workspace.id, [files]));
          if (plan.skipped.length) {
            throw new ActionNeededError(plan.skipped[0].reason);
          }
          const [upload] = plan.uploads;
          if (!(await confirmUpload(upload, workspace.name))) {
            return undefined;
          }
          const { result, id } = await withProgress(`Uploading "${files.name}"…`, () =>
            uploadEnvironment(fabric, workspace.id, upload, { workspaceName: workspace.name }),
          );
          getLogger().info(`Uploaded environment "${files.name}" to ${workspace.name} (${result})`);
          offerToPublish(fabric, workspace, id ? [{ id, name: files.name }] : [], `${result === 'created' ? 'Created' : 'Uploaded'} environment "${files.name}" in ${workspace.name}.`);
          return result;
        } catch (err) {
          await reportError('Upload Environment', err);
          return undefined;
        }
      }),

      registerCommand(Commands.uploadAllEnvironments, 'Upload All Environments', async () => {
        try {
          const root = requireProjectRoot('upload environments from');
          const local = await listLocalEnvironments(root);
          if (!local.length) {
            void vscode.window.showInformationMessage('No environments in src/Environments. Download one first.');
            return undefined;
          }
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          await saveEnvironmentFiles(local);
          const plan = await withProgress('Checking the workspace…', () => planEnvironmentUploads(fabric, workspace.id, local));
          if (!plan.uploads.length) {
            throw new ActionNeededError(`No environments can be uploaded: ${plan.skipped.map((s) => `"${s.name}": ${s.reason}`).join(' ')}`);
          }
          const state = await readSyncState(root, workspace.name);
          const changed = plan.uploads.filter((u) => changesInFabric(u) || itemChangedSinceSync(state, 'environment', u.files.name, u.hash));
          const overwrite = plan.uploads.filter((u) => u.existing).map((u) => u.files.name);
          const create = plan.uploads.filter((u) => !u.existing).map((u) => u.files.name);
          const all = `Upload All (${plan.uploads.length})`;
          const onlyChanged = `Upload Changed (${changed.length})`;
          const offerChanged = changed.length > 0 && changed.length < plan.uploads.length;
          const warnings = plan.uploads.filter((u) => u.warning).map((u) => `"${u.files.name}": ${u.warning}`);
          const choice = await vscode.window.showWarningMessage(
            `Upload ${plan.uploads.length} environments to ${workspace.name}?`,
            {
              modal: true,
              detail: [
                overwrite.length ? `Overwrite ${overwrite.length}: ${nameList(overwrite)}.` : '',
                create.length ? `Create ${create.length}: ${nameList(create)}.` : '',
                plan.uploads.some((u) => u.moves)
                  ? `Move to the folder in their .yaml file ("/" is the workspace root): ${nameList(plan.uploads.filter((u) => u.moves).map((u) => u.files.name))}.`
                  : '',
                plan.skipped.length ? `Skip ${plan.skipped.length} that can't be uploaded: ${nameList(plan.skipped.map((s) => s.name))}.` : '',
                offerChanged ? `Changed here since last downloaded from or uploaded to ${workspace.name}: ${nameList(changed.map((u) => u.files.name))}.` : '',
                ...warnings,
                SAVED_NOT_PUBLISHED,
              ]
                .filter(Boolean)
                .join('\n\n'),
            },
            all,
            ...(offerChanged ? [onlyChanged] : []),
          );
          if (!choice) {
            return undefined;
          }
          const uploads = choice === onlyChanged ? changed : plan.uploads;
          let ids = new Map<string, string>();
          const result = await withBulkProgress(`Uploading environments to ${workspace.name}`, async (options) => {
            const uploaded = await uploadEnvironments(fabric, workspace.id, uploads, { ...options, workspaceName: workspace.name });
            ids = uploaded.ids;
            return uploaded;
          });
          plan.skipped.forEach(({ name, reason }) => result.skipped.push({ name, reason }));
          reportBulk(workspace, result, 'Uploaded', 'to');
          const uploaded = [...ids].map(([name, id]) => ({ name, id }));
          if (uploaded.length) {
            offerToPublish(fabric, workspace, uploaded, `Uploaded ${uploaded.length} environment${uploaded.length === 1 ? '' : 's'} to ${workspace.name}.`);
          }
          return result;
        } catch (err) {
          await reportError('Upload All Environments', err);
          return undefined;
        }
      }),

      registerCommand(Commands.publishEnvironment, 'Publish Environment', async () => {
        try {
          const workspace = await selected.resolve();
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading environments…', () => fabric.listEnvironments(workspace.id));
          const picked = await pickEnvironment(items, workspace.name, 'Publish');
          if (!picked) {
            return undefined;
          }
          const choice = await vscode.window.showWarningMessage(
            `Publish environment "${picked.displayName}" in ${workspace.name}?`,
            {
              modal: true,
              detail:
                'Its saved changes take effect for every notebook that uses it, for everyone using the workspace. ' +
                'Publishing can take many minutes; you can stop watching it, and it goes on in Fabric.',
            },
            'Publish',
          );
          if (choice !== 'Publish') {
            return undefined;
          }
          return await publishAndReport(fabric, workspace, [{ id: picked.id, name: picked.displayName }]);
        } catch (err) {
          await reportError('Publish Environment', err);
          return undefined;
        }
      }),
    );
  },
};

const SAVED_NOT_PUBLISHED =
  'Uploading saves the changes in Fabric, as editing an environment there does: they take effect for notebooks once the environment is published (offered after uploading).';

/** The environment to upload: the one `arg` (an Explorer or editor URI) or the active editor is in, or one picked. */
async function environmentToUpload(root: vscode.Uri, arg: unknown): Promise<EnvironmentFiles | undefined> {
  const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
  const found = uri && environmentFilesFor(root, uri);
  if (found) {
    return found;
  }
  const local = await listLocalEnvironments(root);
  if (!local.length) {
    void vscode.window.showInformationMessage('No environments in src/Environments. Download one first.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    local.map((files) => ({ label: files.name, files })),
    { title: 'Upload an Environment from src/Environments' },
  );
  return picked?.files;
}

/** Saves open files with unsaved changes in these environments' folders, so what's uploaded is what's on screen. */
export async function saveEnvironmentFiles(environments: readonly EnvironmentFiles[]): Promise<void> {
  const folders = environments.map((e) => `${e.folder.toString()}/`);
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && folders.some((f) => doc.uri.toString().startsWith(f)) && !(await doc.save())) {
      throw new ActionNeededError(`${vscode.workspace.asRelativePath(doc.uri)} couldn't be saved, so nothing was uploaded.`);
    }
  }
}

/** Whether uploading changes an existing environment's description or folder in Fabric (so it counts as changed). */
function changesInFabric({ existing, description, moves }: PlannedEnvironmentUpload): boolean {
  return !!existing && ((description !== undefined && description !== (existing.description ?? '')) || !!moves);
}

async function confirmUpload(upload: PlannedEnvironmentUpload, workspaceName: string): Promise<boolean> {
  const { files, existing, folder, moves } = upload;
  const action = existing ? 'Overwrite' : 'Create';
  const folderNote = moves
    ? `It will be moved from ${folderLabel(moves.from)} to ${folderLabel(moves.to)}, as its ${files.name}.yaml says.`
    : !existing && folder
      ? `It will be created in ${folderLabel(folder)} (and any of its folders that don't exist yet), as its ${files.name}.yaml says.`
      : '';
  const choice = await vscode.window.showWarningMessage(
    existing ? `Overwrite environment "${files.name}" in ${workspaceName}?` : `Create environment "${files.name}" in ${workspaceName}?`,
    {
      modal: true,
      detail: [
        existing
          ? `Its settings and libraries in Fabric are replaced with ${vscode.workspace.asRelativePath(files.folder)}'s.`
          : `It's created from ${vscode.workspace.asRelativePath(files.folder)}.`,
        folderNote,
        upload.warning ? `Note: ${upload.warning}` : '',
        SAVED_NOT_PUBLISHED,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    action,
  );
  return choice === action;
}

/** After an upload: says so, and offers to publish what was uploaded. */
export function offerToPublish(fabric: FabricClient, workspace: ResolvedWorkspace, uploaded: readonly { id: string; name: string }[], message: string): void {
  if (!uploaded.length) {
    void vscode.window.showInformationMessage(`${message} Publish it in Fabric for notebooks to use the changes.`);
    return;
  }
  const publish = uploaded.length === 1 ? 'Publish' : `Publish ${uploaded.length}`;
  notify('info', `${message} The changes are saved in Fabric, not yet published.`, [publish], async () => {
    try {
      await publishAndReport(fabric, workspace, uploaded);
    } catch (err) {
      await reportError('Publish Environment', err);
    }
  });
}

/**
 * Publishes environments (at once) and watches them in a progress notification, which can be
 * cancelled to stop watching (the publishes go on in Fabric). Reports how each ended.
 */
async function publishAndReport(fabric: FabricClient, workspace: ResolvedWorkspace, environments: readonly { id: string; name: string }[]) {
  const log = getLogger();
  const outcomes = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: Publishing in ${workspace.name}`, cancellable: true },
    (progress, token) =>
      Promise.all(
        environments.map(async ({ id, name }) => {
          try {
            return {
              name,
              outcome: await publishEnvironment(fabric, workspace.id, id, name, {
                isCancelled: () => token.isCancellationRequested,
                onState: (details) => {
                  log.debug(`Publishing environment "${name}": ${details.state ?? 'unknown'} ${JSON.stringify(details.components)}`);
                  progress.report({ message: `"${name}": ${details.state ?? '…'}` });
                },
              }),
            };
          } catch (err) {
            return { name, error: err };
          }
        }),
      ),
  );
  const lines: string[] = [];
  let problem = false;
  for (const result of outcomes) {
    if ('error' in result) {
      problem = true;
      const message = result.error instanceof Error ? result.error.message : String(result.error);
      log.warn(`Environment "${result.name}" wasn't published: ${message}`);
      lines.push(`"${result.name}" wasn't published: ${message}`);
      continue;
    }
    const { state, stoppedWatching } = result.outcome;
    log.info(`Publishing environment "${result.name}" in ${workspace.name}: ${state ?? 'started'}${stoppedWatching ? ` (stopped watching: ${stoppedWatching})` : ''}`);
    if (stoppedWatching) {
      lines.push(`"${result.name}" is still publishing in Fabric${state ? ` (${state})` : ''}; check it there.`);
    } else if (state === 'Success') {
      lines.push(`"${result.name}" is published.`);
    } else {
      problem = true;
      lines.push(
        state === 'Failed'
          ? `Publishing "${result.name}" failed in Fabric. Fabric's API doesn't say why: open the environment in Fabric to see.`
          : `Publishing "${result.name}" ended as ${state ?? 'unknown'}.`,
      );
    }
  }
  if (problem) {
    notify('warning', lines.join(' '), ['Show Log'], () => log.show());
  } else {
    void vscode.window.showInformationMessage(lines.join(' '));
  }
  return outcomes;
}

async function pickEnvironment(items: EnvironmentInfo[], workspaceName: string, verb = 'Download'): Promise<EnvironmentInfo | undefined> {
  if (!items.length) {
    void vscode.window.showInformationMessage(`No environments in "${workspaceName}".`);
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    [...items]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((item) => ({ label: item.displayName, description: item.description, item })),
    { title: `${verb} an Environment ${verb === 'Download' ? 'from' : 'in'} ${workspaceName}`, matchOnDescription: true },
  );
  return picked?.item;
}

async function confirmReplace(files: EnvironmentFiles): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    `Replace your local copy of "${files.name}"?`,
    {
      modal: true,
      detail:
        `${vscode.workspace.asRelativePath(files.folder)} will be replaced with the environment from Fabric: ` +
        'its files under Libraries/ and Setting/ that Fabric no longer has are deleted. Changes you made locally are lost.',
    },
    'Replace',
  );
  return choice === 'Replace';
}

/** Logs a bulk result environment by environment and shows a summary, with the log a click away if anything was left out. */
function reportBulk(workspace: ResolvedWorkspace, result: BulkResult, verb = 'Downloaded', preposition = 'from'): void {
  const log = getLogger();
  result.done.forEach((name) => log.info(`${verb} environment "${name}" ${preposition} ${workspace.name}`));
  result.skipped.forEach(({ name, reason }) => log.warn(`Skipped environment "${name}": ${reason}`));
  result.failed.forEach(({ name, reason }) => log.error(`Environment "${name}" failed: ${reason}`));
  const parts = [
    `${verb} ${result.done.length} environment${result.done.length === 1 ? '' : 's'} ${preposition} ${workspace.name}.`,
    result.skipped.length ? `${result.skipped.length} skipped.` : '',
    result.failed.length ? `${result.failed.length} failed.` : '',
    result.cancelled ? 'Cancelled before the rest.' : '',
  ].filter(Boolean);
  if (!result.skipped.length && !result.failed.length && !result.cancelled) {
    void vscode.window.showInformationMessage(parts.join(' '));
    return;
  }
  notify('warning', parts.join(' '), ['Show Log'], () => log.show());
}
