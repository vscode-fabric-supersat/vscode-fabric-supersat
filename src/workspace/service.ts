import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import type { Workspace } from '../fabric/client';
import { getConfig } from '../util/config';
import { assertSafeWritePath, ensureLocalStateDir, exists, localStateDir } from '../util/localState';
import { getLogger } from '../util/logger';
import { readYamlFile, updateYamlFile, YamlFileError } from '../util/yamlFile';

/** Local settings for the project, for people to read and edit. */
export const SETTINGS_FILE_NAME = 'settings.yaml';

/** Contents of a new `settings.yaml`; the placeholder keeps the comment next to its value. */
export const NEW_SETTINGS_FILE = `# Fabric Supersat settings for this project.
# They are yours only: this folder is ignored by git. Edit them here or with
# Fabric Supersat commands; your comments and layout are kept.

# Name of the Fabric workspace that commands work in.
# Change it with "Fabric Supersat: Select Workspace".
workspace:
  name: ""
`;

const WORKSPACE_NAME = ['workspace', 'name'] as const;
/** Saved by earlier versions; removed whenever the file is saved, and never read. */
const LEGACY_WORKSPACE_ID = ['workspace', 'id'] as const;

/**
 * The saved workspace: only its name. The ID is never saved; it is looked up in Fabric
 * by name (see `WorkspaceService.resolve`), so a settings file can't point commands at a
 * workspace by an ID the user never sees.
 */
export interface SavedWorkspace {
  readonly name: string;
}

/** A workspace found in Fabric: the ID to work in, and Fabric's name for it. */
export interface ResolvedWorkspace {
  readonly id: string;
  readonly name: string;
  /**
   * Set when other workspaces share the name, so the user picked this one by ID in
   * "Select Workspace". The choice lasts for the session only, since only the name is saved.
   */
  readonly nameShared?: true;
}

/** Shows a picker of the given workspaces; the one named `currentName` is marked. */
export type WorkspacePicker = (
  workspaces: readonly Workspace[],
  currentName: string | undefined,
) => Promise<Workspace | undefined>;

/** The saved workspace name matches no workspace, or more than one, in Fabric. */
export class WorkspaceNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceNameError';
  }
}

export interface WorkspaceServiceOptions {
  /** Lists the workspaces the signed-in user can access in Fabric. */
  list: () => Promise<Workspace[]>;
  pick: WorkspacePicker;
  /**
   * Folder for local state, or `undefined` when there is none. Defaults to
   * `.fabric-supersat` in the first folder of the VS Code workspace.
   */
  localDir?: () => vscode.Uri | undefined;
  /** Whether the VS Code workspace is trusted; defaults to `vscode.workspace.isTrusted`. */
  isTrusted?: () => boolean;
}

/**
 * The workspaces in `all` named `name`. Fabric compares workspace names ignoring case, so
 * this does too; more than one result means the name can't identify a workspace.
 */
export function workspacesNamed(all: readonly Workspace[], name: string): Workspace[] {
  const key = name.toLowerCase();
  return all.filter((w) => w.displayName.toLowerCase() === key);
}

function ambiguous(name: string, matches: readonly Workspace[]): WorkspaceNameError {
  return new WorkspaceNameError(
    `${matches.length} Fabric workspaces are named "${name}" (${matches.map((w) => w.id).join(', ')}), ` +
      'so the name can\'t identify one. Run "Fabric Supersat: Select Workspace" and pick the one you want by its ID ' +
      '(for this session), or rename one of them in Fabric.',
  );
}

/**
 * The current Fabric workspace, shared by every feature that needs one.
 *
 * Only the workspace's name is saved. With a folder open it is kept in
 * `.fabric-supersat/settings.yaml` in that folder, which git ignores, so each person picks
 * their own and nothing is committed. Without a folder (or when the folder is on a
 * read-only file system, e.g. some virtual workspaces) it is kept in the `workspace.name`
 * user setting. Only one of the two is ever used: user settings are never read while a
 * writable folder is open.
 *
 * In Restricted Mode (an untrusted folder) the folder's settings file is neither read nor
 * written, since whoever supplied the folder could have chosen its workspace; user
 * settings are used until the folder is trusted.
 *
 * Commands get the workspace's ID from `resolve()`, which looks the name up in Fabric once
 * per session and refuses a name that matches more than one workspace, unless the user
 * picked one of them by ID in "Select Workspace" this session.
 */
export class WorkspaceService implements vscode.Disposable {
  private readonly list: () => Promise<Workspace[]>;
  private readonly pick: WorkspacePicker;
  private readonly localDir: () => vscode.Uri | undefined;
  private readonly isTrusted: () => boolean;
  /** Workspace IDs found in Fabric, or picked by the user, this session, by lower-cased name. */
  private readonly ids = new Map<string, ResolvedWorkspace>();
  private readonly changed = new vscode.EventEmitter<SavedWorkspace | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private cached: SavedWorkspace | undefined;
  private readonly ready: Promise<unknown>;

  /** Fires when the current workspace changes, including edits made outside the extension. */
  readonly onDidChange = this.changed.event;

  constructor(options: WorkspaceServiceOptions) {
    this.list = options.list;
    this.pick = options.pick;
    this.localDir = options.localDir ?? defaultLocalDir;
    this.isTrusted = options.isTrusted ?? (() => vscode.workspace.isTrusted);
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${ID_PREFIX}.workspace`)) {
          void this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.watch();
        void this.refresh();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.watch();
        void this.refresh();
      }),
      { dispose: () => this.watcher?.dispose() },
    );
    this.watch();
    this.ready = this.refresh();
  }

  /** The saved workspace, or `undefined` if none has been selected. */
  get current(): SavedWorkspace | undefined {
    return this.cached;
  }

  /** The local file the workspace is saved in, or `undefined` when user settings are used instead. */
  get localFile(): vscode.Uri | undefined {
    const dir = this.writableLocalDir();
    return dir && vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
  }

  /**
   * The current workspace's ID and name in Fabric; if none is saved, asks the user to pick
   * one and saves it. The ID is looked up by name once per session (or is the one the user
   * picked this session). Throws `WorkspaceNameError` if no workspace, or more than one,
   * has the saved name.
   */
  async resolve(): Promise<ResolvedWorkspace | undefined> {
    await this.ready;
    const saved = this.current;
    if (!saved) {
      return this.select();
    }
    const known = this.ids.get(saved.name.toLowerCase());
    if (known) {
      return known;
    }
    const matches = workspacesNamed(await this.list(), saved.name);
    if (matches.length === 0) {
      throw new WorkspaceNameError(
        `No Fabric workspace you can access is named "${saved.name}". It may have been renamed or deleted, ` +
          'or belong to another tenant. Run "Fabric Supersat: Select Workspace".',
      );
    }
    if (matches.length > 1) {
      throw ambiguous(saved.name, matches);
    }
    const resolved = { id: matches[0].id, name: matches[0].displayName };
    this.ids.set(saved.name.toLowerCase(), resolved);
    getLogger().info(`Fabric workspace "${resolved.name}" is ${resolved.id}`);
    return resolved;
  }

  /**
   * Asks the user to pick a workspace and saves its name. `undefined` if they cancel.
   * If other workspaces share the name, the picker shows their IDs and the one picked is
   * used for the rest of the session (only the name is saved, so the next session asks again).
   */
  async select(): Promise<ResolvedWorkspace | undefined> {
    await this.ready;
    const all = await this.list();
    const picked = await this.pick(all, this.current?.name);
    if (!picked) {
      return undefined;
    }
    const shared = workspacesNamed(all, picked.displayName).length > 1;
    const resolved: ResolvedWorkspace = shared
      ? { id: picked.id, name: picked.displayName, nameShared: true }
      : { id: picked.id, name: picked.displayName };
    this.ids.set(resolved.name.toLowerCase(), resolved);
    await this.save({ name: resolved.name });
    getLogger().info(
      `Selected Fabric workspace "${resolved.name}" (${resolved.id})` +
        (shared ? '; other workspaces share this name, so this ID is used for this session only' : ''),
    );
    return resolved;
  }

  /**
   * Saves the workspace name: in the local file when a folder is open, otherwise in user
   * settings. `undefined` clears both (blanking the value in the file, so its comments
   * stay), since a workspace belongs to one tenant and this is used when the tenant changes.
   */
  async save(workspace: SavedWorkspace | undefined): Promise<void> {
    await this.ready;
    const dir = this.writableLocalDir();
    if (!workspace) {
      if (dir) {
        await clearLocal(dir);
      }
      await writeSettings(undefined);
    } else if (dir) {
      await writeLocal(dir, workspace);
    } else {
      await writeSettings(workspace);
    }
    await this.refresh();
  }

  /** Forgets the IDs found this session, e.g. after the tenant or account changes. */
  forgetIds(): void {
    this.ids.clear();
  }

  /** Re-reads the saved workspace and fires `onDidChange` if it changed. */
  async refresh(): Promise<SavedWorkspace | undefined> {
    const dir = this.writableLocalDir();
    const next = dir ? await readLocal(dir) : readSettings();
    if (next?.name !== this.cached?.name) {
      this.cached = next;
      this.changed.fire(next);
    }
    return next;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /** The local state folder, unless there is no folder open, it can't be written to, or it isn't trusted. */
  private writableLocalDir(): vscode.Uri | undefined {
    if (!this.isTrusted()) {
      return undefined;
    }
    const dir = this.localDir();
    return dir && vscode.workspace.fs.isWritableFileSystem(dir.scheme) !== false ? dir : undefined;
  }

  /** Watches the local file so hand edits (or `git clean`) update the status bar. */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const dir = this.writableLocalDir();
    if (!dir) {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, SETTINGS_FILE_NAME));
    const refresh = () => void this.refresh();
    this.watcher.onDidCreate(refresh);
    this.watcher.onDidChange(refresh);
    this.watcher.onDidDelete(refresh);
  }
}

function defaultLocalDir(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && localStateDir(folder.uri);
}

function readSettings(): SavedWorkspace | undefined {
  const { name } = getConfig().workspace;
  return name ? { name } : undefined;
}

async function writeSettings(workspace: SavedWorkspace | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration(ID_PREFIX)
    .update('workspace.name', workspace?.name, vscode.ConfigurationTarget.Global);
}

async function readLocal(dir: vscode.Uri): Promise<SavedWorkspace | undefined> {
  try {
    const file = await readYamlFile(vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME));
    const name = file?.getString(WORKSPACE_NAME);
    return name ? { name } : undefined;
  } catch (err) {
    // A hand edit gone wrong: treat as no workspace. Saving reports the error with its line.
    getLogger().warn(err instanceof YamlFileError ? `Ignoring invalid settings. ${err.message}` : 'Couldn\'t read local settings', err);
    return undefined;
  }
}

/** Saves the workspace name in the settings file, creating it and the folder's `.gitignore` as needed. */
async function writeLocal(dir: vscode.Uri, workspace: SavedWorkspace): Promise<void> {
  await ensureLocalStateDir(dir);
  const file = vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
  await assertSafeWritePath(vscode.Uri.joinPath(dir, '..'), file);
  await updateYamlFile(
    file,
    [
      [LEGACY_WORKSPACE_ID, undefined],
      [WORKSPACE_NAME, workspace.name],
    ],
    NEW_SETTINGS_FILE,
  );
}

/** Blanks the workspace in the settings file, if there is one. */
async function clearLocal(dir: vscode.Uri): Promise<void> {
  const file = vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
  if (await exists(file)) {
    await assertSafeWritePath(vscode.Uri.joinPath(dir, '..'), file);
    await updateYamlFile(
      file,
      [
        [LEGACY_WORKSPACE_ID, undefined],
        [WORKSPACE_NAME, ''],
      ],
      NEW_SETTINGS_FILE,
    );
  }
}

/** The default picker: the given workspaces in a quick pick. */
export const showWorkspacePicker: WorkspacePicker = async (workspaces, currentName) => {
  const current = currentName?.toLowerCase();
  const picked = await vscode.window.showQuickPick(
    [...workspaces]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((ws) => {
        const sharing = workspacesNamed(workspaces, ws.displayName).length;
        return {
          label: ws.displayName.toLowerCase() === current ? `$(check) ${ws.displayName}` : ws.displayName,
          // Workspaces that share a name are told apart, and picked, by ID.
          description: sharing > 1 ? `$(warning) ${sharing} workspaces share this name` : undefined,
          detail: sharing > 1 ? `ID ${ws.id}` : undefined,
          ws,
        };
      }),
    {
      title: 'Fabric: Select a Workspace',
      placeHolder: workspaces.length ? 'Workspace to use for Fabric Supersat' : 'No workspaces found',
      matchOnDetail: true,
    },
  );
  return picked?.ws;
};
