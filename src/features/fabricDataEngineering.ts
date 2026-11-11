/**
 * "Use Fabric Data Engineering" and "Stop Using Fabric Data Engineering" (experimental):
 * points Microsoft's Fabric Data Engineering extension (FDE) at this project's
 * `.fabric-supersat/fabric-de` folder and copies the project's notebooks there, so FDE can
 * run them on Fabric. Desktop only: FDE's work folder is a local path. While it's on, each
 * copy is its notebook's `.ipynb` (see `src/fde/copies.ts`).
 *
 * "Log Fabric Data Engineering Structure" is a diagnostic: it writes FDE's work folder, as FDE
 * made it, to `.fabric-supersat/diagnostics/`, with IDs, names and text obscured for sharing.
 *
 * Everything about FDE's internals is in `src/fde/`; this file is only the commands.
 */

import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { FabricClient } from '../fabric/client';
import { FdeCopies } from '../fde/copies';
import {
  FDE_CHECKED_VERSIONS,
  FDE_WORK_FOLDER_SETTING,
  type FdeNotebook,
  type FdeWorkspace,
  isOwnWorkFolder,
} from '../fde/layout';
import {
  fdeFolder,
  readWorkFolderSetting,
  refreshFde,
  requireFde,
  writeWorkFolderInfo,
  writeWorkFolderSetting,
} from '../fde/workFolder';
import { Obscurer, obscureJson, summarizeIpynb } from '../fde/structureLog';
import { listLocalNotebooks, notebookFilesFor, readTextIfExists } from '../notebooks/files';
import { registerCommand } from '../util/commands';
import { ActionNeededError } from '../util/errorFix';
import { reportError } from '../util/errors';
import { notify } from '../util/notify';
import { nonEmptyString } from '../util/json';
import { ensureLocalStateDir, localStateDir, projectRoot, requireProjectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { findByName } from '../util/names';
import { withProgress } from '../util/progress';
import type { WorkspaceService } from '../workspace/service';
import { changedSinceSync, readSyncState, writeLocalStateFile } from '../workspace/state';
import type { Feature } from './feature';

/** Extension state: FDE's work folder before "Use Fabric Data Engineering" changed it (`''` if unset). */
export const PREVIOUS_WORK_FOLDER_KEY = 'fde.previousWorkFolder';

const USE_TITLE = 'Use Fabric Data Engineering';
const STOP_TITLE = 'Stop Using Fabric Data Engineering';
const LOG_TITLE = 'Log Fabric Data Engineering Structure';

export const fabricDataEngineering: Feature = {
  name: 'fabricDataEngineering',
  activate(context, { fabric, workspace }) {
    const copies = new FdeCopies({ workspace });
    context.subscriptions.push(
      copies,
      registerCommand(Commands.useFabricDataEngineering, USE_TITLE, async () => {
        try {
          return await useFabricDataEngineering(context, fabric, workspace, copies);
        } catch (err) {
          await reportError(USE_TITLE, err);
          return undefined;
        }
      }),
      registerCommand(Commands.stopUsingFabricDataEngineering, STOP_TITLE, async () => {
        try {
          await stopUsingFabricDataEngineering(context, copies);
        } catch (err) {
          await reportError(STOP_TITLE, err);
        }
      }),
      registerCommand(Commands.logFabricDataEngineeringStructure, LOG_TITLE, async () => {
        try {
          return await logFabricDataEngineeringStructure();
        } catch (err) {
          await reportError(LOG_TITLE, err);
          return undefined;
        }
      }),
    );
  },
};

/** A notebook copied into FDE's work folder. */
interface Copied {
  readonly name: string;
  readonly uri: vscode.Uri;
}

async function useFabricDataEngineering(
  context: vscode.ExtensionContext,
  fabric: FabricClient,
  selected: WorkspaceService,
  copies: FdeCopies,
): Promise<Copied[] | undefined> {
  const root = requireProjectRoot('use Fabric Data Engineering with');
  if (root.scheme !== 'file') {
    throw new ActionNeededError(
      'Fabric Data Engineering needs the project in a folder on disk (VS Code Desktop), since its work folder is a local path.',
    );
  }
  const fdeVersion = requireFde();
  const workspace = await selected.resolve();
  if (!workspace) {
    return undefined;
  }
  const localDir = localStateDir(root);
  const folder = fdeFolder(localDir);
  const current = readWorkFolderSetting();
  const changesSetting = current !== folder.fsPath;

  const detail = [
    changesSetting
      ? 'Fabric Data Engineering has one work folder for every project on this computer ' +
        `(the ${FDE_WORK_FOLDER_SETTING} user setting), so this changes it everywhere. ` +
        `It is currently ${current ? `"${current}"` : 'not set'}. "${STOP_TITLE}" puts it back.`
      : 'Fabric Data Engineering already uses this folder.',
    `Each notebook in this project that is also in "${workspace.name}" is copied there, or its copy is brought up to date. ` +
      'From then on, a notebook\'s copy is its .ipynb: saving the copy updates the .py, and the .py updates the copy. Your .py files are not changed.',
    'To run the copies, sign in to Fabric Data Engineering (you needn\'t select a workspace in it) and use only its Fabric kernel: ' +
      'its other actions, such as updating a copy from Fabric or publishing, break the link with your .py.',
    FDE_CHECKED_VERSIONS.includes(fdeVersion)
      ? `Experimental: checked with Fabric Data Engineering ${fdeVersion}, the version installed.`
      : `Experimental: checked with Fabric Data Engineering ${FDE_CHECKED_VERSIONS.join(' and ')}; ${fdeVersion} is installed.`,
  ].join('\n\n');
  const choice = await vscode.window.showWarningMessage(
    `Copy notebooks to ${vscode.workspace.asRelativePath(folder, false)} for Fabric Data Engineering?`,
    { modal: true, detail },
    USE_TITLE,
  );
  if (choice !== USE_TITLE) {
    return undefined;
  }

  await ensureLocalStateDir(localDir);
  const [items, info] = await withProgress('Loading notebooks…', () =>
    Promise.all([fabric.listNotebooks(workspace.id), fabric.getWorkspace(workspace.id)]),
  );
  const capacityId = nonEmptyString(info.capacityId);
  if (!capacityId) {
    throw new ActionNeededError(
      `"${workspace.name}" has no capacity, and Fabric Data Engineering runs notebooks on the workspace's capacity. Assign one in Fabric.`,
    );
  }
  const fdeWorkspace: FdeWorkspace = { id: workspace.id, name: workspace.name, capacityId, personal: info.type === 'Personal' };

  await writeWorkFolderInfo(root, folder);
  // What Supersat last knew about each notebook in this workspace (as "Upload Changed" does).
  const syncState = await readSyncState(root, workspace.name);
  const copied: Copied[] = [];
  const differ: string[] = [];
  const notInWorkspace: string[] = [];
  await copies.ready;
  for (const files of await listLocalNotebooks(root)) {
    const item = findByName(items, files.name);
    if (!item) {
      notInWorkspace.push(files.name);
      continue;
    }
    const notebook: FdeNotebook = { workspaceId: workspace.id, capacityId, itemId: item.id, displayName: item.displayName };
    // Same as Fabric if the .py is what was last downloaded, uploaded or found the same by
    // comparing. Otherwise FDE is told it differs, so it shows the copy as modified.
    const py = await readTextIfExists(files.py);
    const sameAsFabric = py !== undefined && !(await changedSinceSync(syncState, files.name, py));
    const uri = await copies.ensureCopy(root, fdeWorkspace, notebook, files.name, sameAsFabric);
    if (!uri) {
      continue; // No .py or .ipynb left to copy (e.g. deleted while this ran).
    }
    if (!sameAsFabric) {
      differ.push(files.name);
    }
    copied.push({ name: files.name, uri });
    getLogger().info(
      `Copied "${files.name}" to Fabric Data Engineering's work folder (item ${item.id}), ` +
        (sameAsFabric ? 'the same as in Fabric' : 'shown as modified: it differs from Fabric, or isn\'t known to be the same'),
    );
  }

  if (changesSetting) {
    if (!isOwnWorkFolder(current)) {
      await context.globalState.update(PREVIOUS_WORK_FOLDER_KEY, current ?? '');
    }
    await writeWorkFolderSetting(folder.fsPath);
    getLogger().info(`Set ${FDE_WORK_FOLDER_SETTING} to ${folder.fsPath} (was ${current ?? 'not set'})`);
  }
  // The copies are now the notebooks' .ipynb files.
  await copies.rebuild();
  await refreshFde();

  if (notInWorkspace.length) {
    getLogger().info(`Not in ${workspace.name}, so not copied: ${notInWorkspace.join(', ')}`);
  }
  offerToOpen(root, copied, notInWorkspace, differ, workspace.name);
  return copied;
}

/** Says what was copied, and opens the copy of the notebook open now (or one picked). */
function offerToOpen(
  root: vscode.Uri,
  copied: readonly Copied[],
  notInWorkspace: readonly string[],
  differ: readonly string[],
  workspaceName: string,
) {
  const skipped = notInWorkspace.length
    ? ` ${notInWorkspace.length} not in "${workspaceName}" were skipped: upload them first, then run this again.`
    : '';
  const modified = differ.length
    ? ` ${differ.length} differ from "${workspaceName}" (or aren't known to be the same), so Fabric Data Engineering shows them as modified.`
    : '';
  if (!copied.length) {
    void vscode.window.showWarningMessage(`No notebooks were copied for Fabric Data Engineering.${skipped}`);
    return;
  }
  const active = vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
  const activeName = active && notebookFilesFor(root, active)?.files.name;
  const activeCopy = copied.find((c) => c.name === activeName);
  const open = activeCopy ? `Open "${activeCopy.name}" Copy` : 'Open a Copy…';
  notify(
    'info',
    `Copied ${copied.length} notebook(s) for Fabric Data Engineering.${modified}${skipped} Open a copy, then pick a Fabric kernel to run it. ` +
      'Sign in to Fabric Data Engineering first (without it, the kernel keeps spinning); there\'s no need to select a workspace in it. ' +
      'Use only its kernel: download and upload with Fabric Supersat.',
    [open],
    async () => {
      const target =
        activeCopy ??
        (await vscode.window.showQuickPick(
          copied.map((c) => ({ label: c.name, copy: c })),
          { title: 'Open a Notebook Copy in Fabric Data Engineering\'s Work Folder' },
        ))?.copy;
      if (target) {
        await vscode.commands.executeCommand('vscode.open', target.uri);
      }
    },
  );
}

async function stopUsingFabricDataEngineering(context: vscode.ExtensionContext, copies: FdeCopies): Promise<void> {
  requireFde();
  const current = readWorkFolderSetting();
  if (!isOwnWorkFolder(current)) {
    void vscode.window.showInformationMessage(
      `Fabric Data Engineering's work folder isn't a Fabric Supersat folder (it's ${current ? `"${current}"` : 'not set'}), so nothing was changed.`,
    );
    return;
  }
  // Outputs follow the notebooks back to .fabric-supersat/Notebooks (only this project's copies).
  const root = projectRoot();
  if (root && copies.enabled(root)) {
    await copies.ready;
    const back = await copies.copyBack(root);
    if (back) {
      getLogger().info(`Copied ${back} Fabric Data Engineering copies back to .fabric-supersat/Notebooks, where newer`);
    }
  }
  const previous = context.globalState.get<string>(PREVIOUS_WORK_FOLDER_KEY) || undefined;
  await writeWorkFolderSetting(previous);
  await context.globalState.update(PREVIOUS_WORK_FOLDER_KEY, undefined);
  getLogger().info(`Set ${FDE_WORK_FOLDER_SETTING} back to ${previous ?? 'not set'} (was ${current})`);
  await refreshFde();
  void vscode.window.showInformationMessage(
    `Fabric Data Engineering's work folder is ${previous ? `back to "${previous}"` : 'no longer set'}. ` +
      `The copies in "${current}" were kept; delete that folder if you don't need them.`,
  );
}

/** The structure log goes in `.fabric-supersat/diagnostics/`, next to the other diagnostic reports. */
const DIAGNOSTICS_DIR = 'diagnostics';

/** Limits that keep the structure log readable (and the walk quick) on a big work folder. */
const MAX_DEPTH = 10;
const MAX_ENTRIES = 3000;
const MAX_JSON_BYTES = 2_000_000;

interface WalkState {
  entries: number;
  truncated: boolean;
}

/**
 * Writes FDE's work folder (from its setting), as FDE made it, to a new file in
 * `.fabric-supersat/diagnostics/`: every folder and file, and the contents of its JSON files
 * (`.ipynb` files as a summary without cells' code), obscured (see `src/fde/structureLog.ts`).
 * Reads FDE's folder only: writes nothing there and changes no setting.
 */
async function logFabricDataEngineeringStructure(): Promise<string[] | undefined> {
  const root = requireProjectRoot('write the structure log into');
  const fdeVersion = requireFde();
  const setting = vscode.workspace.getConfiguration().get<string>(FDE_WORK_FOLDER_SETTING);
  if (!setting) {
    throw new ActionNeededError(
      `Fabric Data Engineering's work folder (${FDE_WORK_FOLDER_SETTING}) isn't set. ` +
        'Set it with Fabric Data Engineering and download a notebook with it, then run this again.',
    );
  }
  const folder = vscode.Uri.file(setting);
  const obscurer = new Obscurer();
  const lines = [
    `Fabric Data Engineering work folder structure (Fabric Data Engineering ${fdeVersion}; IDs, names and text obscured)`,
    `Work folder: ${isOwnWorkFolder(setting) ? 'a Fabric Supersat folder (.fabric-supersat/fabric-de)' : '<work folder>'}/`,
  ];
  const state: WalkState = { entries: 0, truncated: false };
  await withProgress('Reading Fabric Data Engineering\'s work folder…', () => walk(folder, 0, '  ', lines, obscurer, state));
  const fileName = `fde-structure-${new Date().toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')}.txt`;
  const file = await writeLocalStateFile(root, [DIAGNOSTICS_DIR, fileName], `${lines.join('\n')}\n`);
  getLogger().info(`Wrote Fabric Data Engineering's work folder structure (${state.entries} entries) to ${file.toString(true)}`);
  const open = 'Open';
  const copy = 'Copy';
  notify(
    'info',
    `Wrote Fabric Data Engineering's work folder structure (${state.entries} entries, IDs, names and text obscured) to ` +
      `${vscode.workspace.asRelativePath(file, false)}.`,
    [open, copy],
    (choice) =>
      choice === open ? vscode.commands.executeCommand('vscode.open', file) : vscode.env.clipboard.writeText(lines.join('\n')),
  );
  return lines;
}

async function walk(dir: vscode.Uri, depth: number, indent: string, lines: string[], obscurer: Obscurer, state: WalkState): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    lines.push(`${indent}<can't be read>`);
    return;
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  for (const [name, type] of entries) {
    if (++state.entries > MAX_ENTRIES) {
      if (!state.truncated) {
        lines.push(`${indent}… stopped after ${MAX_ENTRIES} entries`);
        state.truncated = true;
      }
      return;
    }
    const shown = obscurer.pathSegment(name);
    const uri = vscode.Uri.joinPath(dir, name);
    if (type & vscode.FileType.SymbolicLink) {
      lines.push(`${indent}${shown} (symbolic link, not followed)`);
    } else if (type & vscode.FileType.Directory) {
      if (SHALLOW_FOLDERS.has(name)) {
        lines.push(`${indent}${shown}/ (listed one level deep, without contents)`);
        await listShallow(uri, `${indent}  `, lines, obscurer, state);
      } else if (depth >= MAX_DEPTH) {
        lines.push(`${indent}${shown}/ (deeper folders not listed)`);
      } else {
        lines.push(`${indent}${shown}/`);
        await walk(uri, depth + 1, `${indent}  `, lines, obscurer, state);
      }
    } else {
      lines.push(`${indent}${shown}${await describeFile(name, uri, obscurer)}`);
    }
  }
}

/**
 * FDE folders that the local work folder route doesn't use: the virtual workspace's file
 * cache (`.vfscache`) and metadata (`.vfsmeta`), and PySpark type stubs (`.stubs`). Only
 * their direct contents are listed: names (obscured), sizes and file counts.
 */
const SHALLOW_FOLDERS = new Set(['.vfscache', '.vfsmeta', '.stubs']);

/** Lists a folder's direct contents: files with sizes, folders with file counts, nothing deeper and no file contents. */
async function listShallow(dir: vscode.Uri, indent: string, lines: string[], obscurer: Obscurer, state: WalkState): Promise<void> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    lines.push(`${indent}<can't be read>`);
    return;
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  for (const [name, type] of entries) {
    if (++state.entries > MAX_ENTRIES) {
      if (!state.truncated) {
        lines.push(`${indent}… stopped after ${MAX_ENTRIES} entries`);
        state.truncated = true;
      }
      return;
    }
    const shown = obscurer.pathSegment(name);
    const uri = vscode.Uri.joinPath(dir, name);
    if (type & vscode.FileType.SymbolicLink) {
      lines.push(`${indent}${shown} (symbolic link, not followed)`);
    } else if (type & vscode.FileType.Directory) {
      const { files, bytes } = await countFiles(uri);
      lines.push(`${indent}${shown}/ (${files} files, ${bytes} bytes; not listed)`);
    } else {
      const size = await vscode.workspace.fs.stat(uri).then((s) => s.size, () => undefined);
      lines.push(`${indent}${shown} (${size === undefined ? "can't be read" : `${size} bytes`})`);
    }
  }
}

/** A file's size and, for JSON files (`.json`, `.ipynb`, and FDE's `.<name>` info files), its obscured contents. */
async function describeFile(name: string, uri: vscode.Uri, obscurer: Obscurer): Promise<string> {
  let size: number;
  try {
    size = (await vscode.workspace.fs.stat(uri)).size;
  } catch {
    return ' <can\'t be read>';
  }
  const ipynb = name.endsWith('.ipynb');
  if (!(ipynb || name.endsWith('.json') || /^\.[\w-]+$/.test(name)) || name === '.gitignore') {
    return ` (${size} bytes)`;
  }
  if (size > MAX_JSON_BYTES) {
    return ` (${size} bytes; too big to show)`;
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch {
    return ` (${size} bytes; not JSON)`;
  }
  return ` (${size} bytes): ${JSON.stringify(ipynb ? summarizeIpynb(json, obscurer) : obscureJson(json, obscurer))}`;
}

/** How many files, and bytes, a folder holds (symbolic links not followed). */
async function countFiles(dir: vscode.Uri, limit = { left: 10000 }): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return { files, bytes };
  }
  for (const [name, type] of entries) {
    if (limit.left-- <= 0) {
      break;
    }
    const uri = vscode.Uri.joinPath(dir, name);
    if (type & vscode.FileType.SymbolicLink) {
      continue;
    }
    if (type & vscode.FileType.Directory) {
      const inner = await countFiles(uri, limit);
      files += inner.files;
      bytes += inner.bytes;
    } else {
      files++;
      bytes += await vscode.workspace.fs.stat(uri).then((s) => s.size, () => 0);
    }
  }
  return { files, bytes };
}
