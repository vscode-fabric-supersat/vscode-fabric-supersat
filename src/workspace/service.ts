import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import type { Workspace } from '../fabric/client';
import { getConfig } from '../util/config';
import type { ErrorFix, FixableError, WarningError } from '../util/errorFix';
import { getLogger } from '../util/logger';
import { ProjectSettings, type ProjectSettingsOptions, SETTINGS_FILE_NAME } from './projectSettings';

export { NEW_SETTINGS_FILE, SETTINGS_FILE_NAME } from './projectSettings';

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

/** Shows a picker of the given workspaces; the selected one (named `selectedName`) is marked. */
export type WorkspacePicker = (
  workspaces: readonly Workspace[],
  selectedName: string | undefined,
) => Promise<Workspace | undefined>;

/** The saved workspace name matches no workspace in Fabric. A warning (see `WarningError`). */
export class WorkspaceNameError extends Error implements FixableError, WarningError {
  readonly fix: ErrorFix = { selectWorkspace: true };
  readonly warning = true;

  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceNameError';
  }
}

export interface WorkspaceServiceOptions extends ProjectSettingsOptions {
  /** Lists the workspaces the signed-in user can access in Fabric. */
  list: () => Promise<Workspace[]>;
  pick: WorkspacePicker;
  /**
   * The project's settings file, where the workspace name is saved (see `ProjectSettings`).
   * Without one, the service makes its own from `localDir` and `isTrusted`.
   */
  settings?: ProjectSettings;
  /**
   * Whether this window has focus, so a change seen here was made here; defaults to
   * `vscode.window.state.focused`. Only such changes are synced (see `WorkspaceService`).
   */
  isFocused?: () => boolean;
}

/**
 * The workspaces in `all` named `name`. Fabric compares workspace names ignoring case, so
 * this does too; more than one result means the name can't identify a workspace.
 */
export function workspacesNamed(all: readonly Workspace[], name: string): Workspace[] {
  const key = name.toLowerCase();
  return all.filter((w) => w.displayName.toLowerCase() === key);
}

/**
 * The selected Fabric workspace, shared by every feature that needs one.
 *
 * Only the workspace's name is saved. With a folder open it is read from
 * `.fabric-supersat/settings.yaml` in that folder, which git ignores, so each person picks
 * their own and nothing is committed. Without a folder (or when the folder is on a
 * read-only file system, e.g. some virtual workspaces) it is read from the
 * `workspace.name` user setting.
 *
 * Changing the workspace by any means keeps the file and the user setting in sync:
 * "Select Workspace" writes both, a change to the file is copied to the setting, and a
 * change to the setting is copied to the file (if the file exists). The user setting is
 * shared by every VS Code window, so only changes made in this window (it has focus) are
 * synced; other windows keep their own folder's workspace. Opening a folder copies the
 * workspace named in its file to the setting (a folder with none leaves the setting alone).
 *
 * In Restricted Mode (an untrusted folder) the folder's settings file is neither read nor
 * written, since whoever supplied the folder could have chosen its workspace; user
 * settings are used until the folder is trusted.
 *
 * Commands get the workspace's ID from `resolve()`, which looks the name up in Fabric once
 * per session. A name that matches more than one workspace is never guessed: the user
 * picks one of them by ID (in "Select Workspace", or the picker `resolve()` shows), and
 * that one is used for the rest of the session.
 */
export class WorkspaceService implements vscode.Disposable {
  private readonly list: () => Promise<Workspace[]>;
  private readonly pick: WorkspacePicker;
  private readonly isFocused: () => boolean;
  /** Where the workspace name is saved when a trusted, writable folder is open. */
  readonly settings: ProjectSettings;
  /** Workspace IDs found in Fabric, or picked by the user, this session, by lower-cased name. */
  private readonly ids = new Map<string, ResolvedWorkspace>();
  /** Lookups in progress, by lower-cased name, so commands at the same time share one (and one picker). */
  private readonly lookups = new Map<string, Promise<ResolvedWorkspace | undefined>>();
  private readonly changed = new vscode.EventEmitter<SavedWorkspace | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private cached: SavedWorkspace | undefined;
  private readonly ready: Promise<unknown>;

  /** Fires when the selected workspace changes, including edits made outside the extension. */
  readonly onDidChange = this.changed.event;

  constructor(options: WorkspaceServiceOptions) {
    this.list = options.list;
    this.pick = options.pick;
    this.settings = options.settings ?? new ProjectSettings(options);
    this.isFocused = options.isFocused ?? (() => vscode.window.state.focused);
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${ID_PREFIX}.workspace`)) {
          void this.syncFromSetting();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.watch();
        void this.opened();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.watch();
        void this.opened();
      }),
      { dispose: () => this.watcher?.dispose() },
    );
    this.watch();
    this.ready = this.opened();
  }

  /** The saved workspace, or `undefined` if none has been selected. */
  get selected(): SavedWorkspace | undefined {
    return this.cached;
  }

  /** The local file the workspace is saved in, or `undefined` when user settings are used instead. */
  get localFile(): vscode.Uri | undefined {
    return this.settings.file;
  }

  /**
   * The selected workspace's ID and name in Fabric; if none is saved, asks the user to pick
   * one and saves it. The ID is looked up by name once per session (or is the one the user
   * picked this session). If several workspaces have the saved name, asks which one
   * (`undefined` if the user cancels). Throws `WorkspaceNameError` if none has it.
   */
  async resolve(): Promise<ResolvedWorkspace | undefined> {
    await this.ready;
    const saved = this.selected;
    if (!saved) {
      return this.select();
    }
    const key = saved.name.toLowerCase();
    const known = this.ids.get(key);
    if (known) {
      return known;
    }
    let lookup = this.lookups.get(key);
    if (!lookup) {
      lookup = this.lookUp(saved.name).finally(() => this.lookups.delete(key));
      this.lookups.set(key, lookup);
    }
    return lookup;
  }

  /** Finds the workspace named `name` in Fabric (asking which one if several share it), and remembers it. */
  private async lookUp(name: string): Promise<ResolvedWorkspace | undefined> {
    const saved = { name };
    const matches = workspacesNamed(await this.list(), saved.name);
    if (matches.length === 0) {
      throw new WorkspaceNameError(
        `No Fabric workspace you can access is named "${saved.name}". It may have been renamed or deleted, ` +
          'or belong to another tenant. Run "Fabric Supersat: Select Workspace".',
      );
    }
    if (matches.length > 1) {
      return this.pickShared(saved.name, matches);
    }
    const resolved = { id: matches[0].id, name: matches[0].displayName };
    this.ids.set(saved.name.toLowerCase(), resolved);
    getLogger().info(`Fabric workspace "${resolved.name}" is ${resolved.id}`);
    return resolved;
  }

  /**
   * The saved name matches several workspaces: asks the user to pick one of them (the
   * picker shows their IDs), and uses it for the rest of the session. `undefined` if they cancel.
   */
  private async pickShared(name: string, matches: readonly Workspace[]): Promise<ResolvedWorkspace | undefined> {
    getLogger().info(`${matches.length} Fabric workspaces are named "${name}" (${matches.map((w) => w.id).join(', ')}): asking which one`);
    const picked = await this.pick(matches, name);
    if (!picked) {
      return undefined;
    }
    const resolved: ResolvedWorkspace = { id: picked.id, name: picked.displayName, nameShared: true };
    this.ids.set(name.toLowerCase(), resolved);
    getLogger().info(`Using Fabric workspace "${resolved.name}" (${resolved.id}) for this session`);
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
    const picked = await this.pick(all, this.selected?.name);
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
    if (!workspace) {
      await this.settings.clearWorkspaceName();
    } else {
      await this.settings.writeWorkspaceName(workspace.name);
    }
    await writeSettings(workspace);
    await this.refresh();
  }

  /**
   * When a folder is opened (at startup, when folders change, or when it becomes trusted):
   * reads its workspace, and copies a workspace named in its `settings.yaml` to the user
   * setting. A folder with no workspace named leaves the setting alone.
   */
  private async opened(): Promise<SavedWorkspace | undefined> {
    if (this.settings.dir()) {
      try {
        const local = saved(await this.settings.readWorkspaceNameStrict());
        if (local && local.name !== readSettings()?.name) {
          await writeSettings(local);
          getLogger().info(`Copied the workspace from ${SETTINGS_FILE_NAME} to the user setting: "${local.name}"`);
        }
      } catch (err) {
        getLogger().debug(`Not synced from ${SETTINGS_FILE_NAME}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return this.refresh();
  }

  /**
   * After `settings.yaml` changed on disk (e.g. a hand edit): copies its workspace name to
   * the user setting, if the change was made in this window and the file is valid YAML.
   */
  async syncFromFile(): Promise<void> {
    await this.ready;
    if (this.settings.dir() && this.isFocused()) {
      try {
        const local = saved(await this.settings.readWorkspaceNameStrict());
        if ((local?.name ?? '') !== (readSettings()?.name ?? '')) {
          await writeSettings(local);
          getLogger().info(`Copied the workspace from ${SETTINGS_FILE_NAME} to the user setting: "${local?.name ?? ''}"`);
        }
      } catch (err) {
        getLogger().debug(`Not synced from ${SETTINGS_FILE_NAME}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.refresh();
  }

  /**
   * After the `workspace.name` user setting changed: copies it to the folder's
   * `settings.yaml`, if the change was made in this window and the file exists (a
   * project without one starts with no workspace, as before).
   */
  async syncFromSetting(): Promise<void> {
    await this.ready;
    if (this.isFocused() && (await this.settings.exists())) {
      try {
        const name = readSettings()?.name ?? '';
        if (((await this.settings.readWorkspaceNameStrict()) ?? '') !== name) {
          await (name ? this.settings.writeWorkspaceName(name) : this.settings.clearWorkspaceName());
          getLogger().info(`Copied the workspace from the user setting to ${SETTINGS_FILE_NAME}: "${name}"`);
        }
      } catch (err) {
        getLogger().warn(`Couldn't copy the workspace setting to ${SETTINGS_FILE_NAME}`, err);
      }
    }
    await this.refresh();
  }

  /** Forgets the IDs found this session, e.g. after the tenant or account changes. */
  forgetIds(): void {
    this.ids.clear();
  }

  /** Re-reads the saved workspace and fires `onDidChange` if it changed. */
  async refresh(): Promise<SavedWorkspace | undefined> {
    const next = this.settings.dir() ? saved(await this.settings.readWorkspaceName()) : readSettings();
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

  /** Watches the local file so hand edits (or `git clean`) update the status bar. */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const dir = this.settings.dir();
    if (!dir) {
      return;
    }
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, SETTINGS_FILE_NAME));
    const sync = () => void this.syncFromFile();
    this.watcher.onDidCreate(sync);
    this.watcher.onDidChange(sync);
    // Deleting the file (e.g. git clean) isn't choosing a workspace: the setting is kept.
    this.watcher.onDidDelete(() => void this.refresh());
  }
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

/** A saved workspace for a name read from somewhere, or `undefined` for none. */
function saved(name: string | undefined): SavedWorkspace | undefined {
  return name ? { name } : undefined;
}

/** The default picker: the given workspaces in a quick pick. */
export const showWorkspacePicker: WorkspacePicker = async (workspaces, selectedName) => {
  const selected = selectedName?.toLowerCase();
  const picked = await vscode.window.showQuickPick(
    [...workspaces]
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((ws) => {
        const sharing = workspacesNamed(workspaces, ws.displayName).length;
        return {
          label: ws.displayName.toLowerCase() === selected ? `$(check) ${ws.displayName}` : ws.displayName,
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
