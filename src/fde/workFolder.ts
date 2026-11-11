/**
 * The VS Code side of using Fabric Data Engineering (FDE, `SynapseVSCode.synapse`): whether
 * it's installed, its work folder setting, and writing files into the work folder. The
 * layout itself is in `layout.ts`; together they're the only code that knows about FDE.
 */

import * as vscode from 'vscode';
import { assertSafeWritePath, exists } from '../util/localState';
import { ActionNeededError, type ErrorFix, type FixableError, type WarningError } from '../util/errorFix';
import {
  FDE_EXTENSION_ID,
  FDE_FOLDER_NAME,
  FDE_WORK_FOLDER_SETTING,
  FDE_WORK_FOLDER_VERSION,
  type FdeFile,
  workFolderInfoFile,
} from './layout';

/** FDE isn't installed (or is disabled). */
export class FdeNotInstalledError extends Error implements FixableError, WarningError {
  readonly warning = true;
  readonly fix: ErrorFix = {
    link: { label: 'Show in Marketplace', url: `https://marketplace.visualstudio.com/items?itemName=${FDE_EXTENSION_ID}` },
  };

  constructor() {
    super(`Install and enable Microsoft's Fabric Data Engineering extension (${FDE_EXTENSION_ID}) first.`);
    this.name = 'FdeNotInstalledError';
  }
}

/** FDE's installed version; throws `FdeNotInstalledError` if it isn't installed. */
export function requireFde(): string {
  const extension = vscode.extensions.getExtension(FDE_EXTENSION_ID);
  if (!extension) {
    throw new FdeNotInstalledError();
  }
  const version = (extension.packageJSON as { version?: unknown }).version;
  return typeof version === 'string' ? version : 'unknown';
}

/** This project's FDE work folder: `.fabric-supersat/fabric-de`. */
export function fdeFolder(localDir: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(localDir, FDE_FOLDER_NAME);
}

/** FDE's work folder setting (user settings, since it has machine scope). */
export function readWorkFolderSetting(): string | undefined {
  const value = vscode.workspace.getConfiguration().inspect<string>(FDE_WORK_FOLDER_SETTING)?.globalValue;
  return value || undefined;
}

/** Sets FDE's work folder setting in user settings; `undefined` removes it. FDE must be installed. */
export async function writeWorkFolderSetting(path: string | undefined): Promise<void> {
  await vscode.workspace.getConfiguration().update(FDE_WORK_FOLDER_SETTING, path, vscode.ConfigurationTarget.Global);
}

/**
 * Writes `.work-folder-info`, unless the folder already has one from a different FDE layout
 * version: then FDE has changed how it lays out the folder, and this extension stops rather
 * than write files FDE would misread.
 */
export async function writeWorkFolderInfo(root: vscode.Uri, folder: vscode.Uri): Promise<void> {
  const file = workFolderInfoFile();
  const uri = vscode.Uri.joinPath(folder, ...file.path);
  if (await exists(uri)) {
    let version: unknown;
    try {
      version = (JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as { version?: unknown }).version;
    } catch {
      version = undefined;
    }
    if (version !== FDE_WORK_FOLDER_VERSION) {
      throw new ActionNeededError(
        `${uri.fsPath} says its layout is version ${String(version)}, but Fabric Supersat writes version ` +
          `${FDE_WORK_FOLDER_VERSION}. Fabric Data Engineering may have changed its work folder layout; ` +
          'Fabric Supersat needs an update before it can write there.',
      );
    }
    return;
  }
  await writeFdeFiles(root, folder, [file]);
}

/** Writes files into the work folder, refusing paths that leave the project or go through a symbolic link. */
export async function writeFdeFiles(root: vscode.Uri, folder: vscode.Uri, files: readonly FdeFile[]): Promise<void> {
  for (const file of files) {
    const uri = vscode.Uri.joinPath(folder, ...file.path);
    await assertSafeWritePath(root, uri);
    if (file.keepExisting && (await exists(uri))) {
      continue;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(file.text));
  }
}

/** Asks FDE to refresh its tree. Best effort: FDE's command IDs aren't an API, so failures are ignored. */
export async function refreshFde(): Promise<void> {
  try {
    await vscode.commands.executeCommand('synapse.refresh');
  } catch {
    // FDE renamed or removed the command; its tree refreshes on its own later.
  }
}
