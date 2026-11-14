import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import type { Workspace } from '../fabric/client';
import {
  type ReferenceKind,
  type ReferenceSettings,
  type WorkspaceReferenceKind,
} from '../notebooks/references';
import { getConfig } from '../util/config';
import {
  assertSafeWritePath,
  ensureLocalStateDir,
  exists,
  localStateDir,
  onLocalStateDirCreated,
} from '../util/localState';
import { getLogger } from '../util/logger';
import { readYamlFile, updateYamlFile, type YamlFile, YamlFileError, type YamlPath } from '../util/yamlFile';

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

# Notebook lakehouse and environment references. These override the VS Code settings
# of the same names (fabric-supersat.notebooks.*), which supplied the values below
# when this file was created. A setting removed from here uses the VS Code setting.
notebooks:
  # On upload: "replace" points each reference at the item with the same name in the
  # workspace you upload to (writing the new ID to the local files); "keep" leaves it.
  upload:
    defaultLakehouse: "replace"
    otherLakehouses: "replace"
    environment: "replace"
  # true saves the workspace as "same workspace" (all zeros) where it is the notebook's
  # own: in downloaded notebooks, and when upload writes new IDs to the local files.
  sameWorkspace:
    defaultLakehouse: false
    environment: false
`;

const WORKSPACE_NAME = ['workspace', 'name'] as const;
const UPLOAD_KINDS: readonly ReferenceKind[] = ['defaultLakehouse', 'otherLakehouses', 'environment'];
const SAME_WORKSPACE_KINDS: readonly WorkspaceReferenceKind[] = ['defaultLakehouse', 'environment'];
const uploadPath = (kind: ReferenceKind) => ['notebooks', 'upload', kind] as const;
const sameWorkspacePath = (kind: WorkspaceReferenceKind) => ['notebooks', 'sameWorkspace', kind] as const;
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
 * per session and refuses a name that matches more than one workspace, unless the user
 * picked one of them by ID in "Select Workspace" this session.
 */
export class WorkspaceService implements vscode.Disposable {
  private readonly list: () => Promise<Workspace[]>;
  private readonly pick: WorkspacePicker;
  private readonly localDir: () => vscode.Uri | undefined;
  private readonly isTrusted: () => boolean;
  private readonly isFocused: () => boolean;
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
      // A new .fabric-supersat folder gets its settings file straight away, showing the settings in effect.
      onLocalStateDirCreated(async (created) => {
        const dir = this.writableLocalDir();
        if (dir && dir.toString() === created.toString()) {
          await createSettingsFile(dir);
        }
      }),
    );
    this.watch();
    this.ready = this.opened();
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
    } else if (dir) {
      await writeLocal(dir, workspace, { fillNotebookSettings: true });
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
    const dir = this.writableLocalDir();
    if (dir) {
      try {
        const local = await readLocalStrict(dir);
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
    const dir = this.writableLocalDir();
    if (dir && this.isFocused()) {
      try {
        const local = await readLocalStrict(dir);
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
    const dir = this.writableLocalDir();
    if (dir && this.isFocused() && (await exists(vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME)))) {
      try {
        const name = readSettings()?.name ?? '';
        if (((await readLocalStrict(dir))?.name ?? '') !== name) {
          await (name ? writeLocal(dir, { name }) : clearLocal(dir));
          getLogger().info(`Copied the workspace from the user setting to ${SETTINGS_FILE_NAME}: "${name}"`);
        }
      } catch (err) {
        getLogger().warn(`Couldn't copy the workspace setting to ${SETTINGS_FILE_NAME}`, err);
      }
    }
    await this.refresh();
  }

  /**
   * The notebook reference settings: the folder's `settings.yaml` values, which override
   * the VS Code settings (`fabric-supersat.notebooks.*`); a value missing from the file
   * comes from the VS Code setting. Without a writable, trusted folder, the VS Code
   * settings are used. Throws `YamlFileError` for an invalid file or value, rather than
   * guessing. Never writes: the values are written when the file is created.
   */
  async notebookSettings(): Promise<ReferenceSettings> {
    await this.ready;
    const base = getConfig().notebooks.references;
    const dir = this.writableLocalDir();
    if (!dir) {
      return base;
    }
    const file = vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
    return readNotebookSettings(await readYamlFile(file), file, base);
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
    const sync = () => void this.syncFromFile();
    this.watcher.onDidCreate(sync);
    this.watcher.onDidChange(sync);
    // Deleting the file (e.g. git clean) isn't choosing a workspace: the setting is kept.
    this.watcher.onDidDelete(() => void this.refresh());
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

/** The workspace in the folder's settings file. Throws `YamlFileError` if the file isn't valid. */
async function readLocalStrict(dir: vscode.Uri): Promise<SavedWorkspace | undefined> {
  const file = await readYamlFile(vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME));
  const name = file?.getString(WORKSPACE_NAME);
  return name ? { name } : undefined;
}

async function readLocal(dir: vscode.Uri): Promise<SavedWorkspace | undefined> {
  try {
    return await readLocalStrict(dir);
  } catch (err) {
    // A hand edit gone wrong: treat as no workspace. Saving reports the error with its line.
    getLogger().warn(err instanceof YamlFileError ? `Ignoring invalid settings. ${err.message}` : 'Couldn\'t read local settings', err);
    return undefined;
  }
}

/** The notebook settings in effect: the file's values over `base` (the VS Code settings). */
function readNotebookSettings(file: YamlFile | undefined, uri: vscode.Uri, base: ReferenceSettings): ReferenceSettings {
  const upload = { ...base.upload };
  for (const kind of UPLOAD_KINDS) {
    const path = uploadPath(kind);
    const value = file?.getString(path);
    if (value === 'replace' || value === 'keep') {
      upload[kind] = value;
    } else if (value !== undefined) {
      throw new YamlFileError(uri, `"${path.join('.')}" should be "replace" or "keep", not "${value}".`);
    }
  }
  const sameWorkspace = { ...base.sameWorkspace };
  for (const kind of SAME_WORKSPACE_KINDS) {
    const path = sameWorkspacePath(kind);
    const value = file?.getString(path);
    if (value === 'true' || value === 'false') {
      sameWorkspace[kind] = value === 'true';
    } else if (value !== undefined) {
      throw new YamlFileError(uri, `"${path.join('.')}" should be true or false, not "${value}".`);
    }
  }
  return { upload, sameWorkspace };
}

/** The current VS Code notebook settings, as values for a new settings file. */
function notebookValues(): [YamlPath, string | boolean][] {
  const { upload, sameWorkspace } = getConfig().notebooks.references;
  return [
    ...UPLOAD_KINDS.map((kind): [YamlPath, string] => [uploadPath(kind), upload[kind]]),
    ...SAME_WORKSPACE_KINDS.map((kind): [YamlPath, boolean] => [sameWorkspacePath(kind), sameWorkspace[kind]]),
  ];
}

/**
 * Creates `settings.yaml` from the template, with the notebook settings in effect (the
 * current VS Code settings, defaults included), unless it already exists.
 */
async function createSettingsFile(dir: vscode.Uri): Promise<void> {
  const file = vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
  if (await exists(file)) {
    return;
  }
  await assertSafeWritePath(vscode.Uri.joinPath(dir, '..'), file);
  await updateYamlFile(file, notebookValues(), NEW_SETTINGS_FILE);
  getLogger().info(`Created ${vscode.workspace.asRelativePath(file)} with the notebook settings in effect`);
}

/**
 * Saves the workspace name in the settings file, creating it (with the notebook settings
 * in effect) and the folder's `.gitignore` as needed. With `fillNotebookSettings` ("Select
 * Workspace"), notebook settings missing from an existing file are added too.
 */
async function writeLocal(
  dir: vscode.Uri,
  workspace: SavedWorkspace,
  options: { fillNotebookSettings?: boolean } = {},
): Promise<void> {
  await ensureLocalStateDir(dir);
  await createSettingsFile(dir);
  const file = vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
  await assertSafeWritePath(vscode.Uri.joinPath(dir, '..'), file);
  const existing = options.fillNotebookSettings ? await readYamlFile(file) : undefined;
  const missing = existing ? notebookValues().filter(([path]) => existing.getString(path) === undefined) : [];
  await updateYamlFile(
    file,
    [
      [LEGACY_WORKSPACE_ID, undefined],
      [WORKSPACE_NAME, workspace.name],
      ...missing,
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
