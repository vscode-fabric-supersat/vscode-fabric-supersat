import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import type { FabricClient, Workspace } from '../fabric/client';
import { getConfig } from '../util/config';
import { getLogger } from '../util/logger';
import { withProgress } from '../util/progress';
import { readYamlFile, updateYamlFile, YamlFileError } from '../util/yamlFile';

/** Hidden folder, in the project root, for this extension's local (per-user) state. */
export const LOCAL_DIR_NAME = '.fabric-supersat';
/** Local settings for the project, for people to read and edit. */
export const SETTINGS_FILE_NAME = 'settings.yaml';
/** Makes git ignore the whole folder, including this file, without touching the project's own `.gitignore`. */
export const LOCAL_GITIGNORE = '# Local Fabric Supersat state, not for source control.\n*\n';

/** Contents of a new `settings.yaml`; the placeholders keep each comment next to its value. */
export const NEW_SETTINGS_FILE = `# Fabric Supersat settings for this project.
# They are yours only: this folder is ignored by git. Edit them here or with
# Fabric Supersat commands; your comments and layout are kept.

# Fabric workspace that commands work in.
# Change it with "Fabric Supersat: Select Workspace".
workspace:
  id: ""
  name: ""
`;

const WORKSPACE_ID = ['workspace', 'id'] as const;
const WORKSPACE_NAME = ['workspace', 'name'] as const;

/** The current Fabric workspace. */
export interface SavedWorkspace {
  readonly id: string;
  /** Display name at the time it was picked; falls back to the ID. */
  readonly name: string;
}

/** Shows a picker of Fabric workspaces; `currentId` is marked with a check. */
export type WorkspacePicker = (currentId: string | undefined) => Promise<Workspace | undefined>;

export interface WorkspaceServiceOptions {
  pick: WorkspacePicker;
  /**
   * Folder for local state, or `undefined` when there is none. Defaults to
   * `.fabric-supersat` in the first folder of the VS Code workspace.
   */
  localDir?: () => vscode.Uri | undefined;
}

/**
 * The current Fabric workspace, shared by every feature that needs one.
 *
 * With a folder open it is kept in `.fabric-supersat/settings.yaml` in that folder, which
 * git ignores, so each person picks their own and nothing is committed. Without a folder
 * (or when the folder is on a read-only file system, e.g. some virtual workspaces) it is
 * kept in the `workspace.id` and `workspace.name` user settings. Only one of the two is
 * ever used: user settings are never read while a writable folder is open.
 */
export class WorkspaceService implements vscode.Disposable {
  private readonly pick: WorkspacePicker;
  private readonly localDir: () => vscode.Uri | undefined;
  private readonly changed = new vscode.EventEmitter<SavedWorkspace | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.FileSystemWatcher | undefined;
  private cached: SavedWorkspace | undefined;
  private readonly ready: Promise<unknown>;

  /** Fires when the current workspace changes, including edits made outside the extension. */
  readonly onDidChange = this.changed.event;

  constructor(options: WorkspaceServiceOptions) {
    this.pick = options.pick;
    this.localDir = options.localDir ?? defaultLocalDir;
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
      { dispose: () => this.watcher?.dispose() },
    );
    this.watch();
    this.ready = this.refresh();
  }

  /** The current workspace, or `undefined` if none has been selected. */
  get current(): SavedWorkspace | undefined {
    return this.cached;
  }

  /** The local file the workspace is saved in, or `undefined` when user settings are used instead. */
  get localFile(): vscode.Uri | undefined {
    const dir = this.writableLocalDir();
    return dir && vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
  }

  /** The current workspace; if there is none, asks the user to pick one and saves it. */
  async resolve(): Promise<SavedWorkspace | undefined> {
    await this.ready;
    return this.current ?? this.select();
  }

  /** Asks the user to pick a workspace and saves it. `undefined` if they cancel. */
  async select(): Promise<SavedWorkspace | undefined> {
    await this.ready;
    const picked = await this.pick(this.current?.id);
    if (!picked) {
      return undefined;
    }
    const saved = { id: picked.id, name: picked.displayName };
    await this.save(saved);
    getLogger().info(`Selected Fabric workspace ${saved.name} (${saved.id})`);
    return saved;
  }

  /**
   * Saves the workspace: in the local file when a folder is open, otherwise in user
   * settings. `undefined` clears both (blanking the values in the file, so its comments
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

  /** Re-reads the saved workspace and fires `onDidChange` if it changed. */
  async refresh(): Promise<SavedWorkspace | undefined> {
    const dir = this.writableLocalDir();
    const next = dir ? await readLocal(dir) : readSettings();
    if (next?.id !== this.cached?.id || next?.name !== this.cached?.name) {
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

  /** The local state folder, unless there is no folder open or it can't be written to. */
  private writableLocalDir(): vscode.Uri | undefined {
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
  return folder && vscode.Uri.joinPath(folder.uri, LOCAL_DIR_NAME);
}

function readSettings(): SavedWorkspace | undefined {
  const { id, name } = getConfig().workspace;
  return id ? { id, name: name || id } : undefined;
}

async function writeSettings(workspace: SavedWorkspace | undefined): Promise<void> {
  const config = vscode.workspace.getConfiguration(ID_PREFIX);
  // Name first, so the change event fired for the ID sees the matching name.
  await config.update('workspace.name', workspace?.name, vscode.ConfigurationTarget.Global);
  await config.update('workspace.id', workspace?.id, vscode.ConfigurationTarget.Global);
}

async function readLocal(dir: vscode.Uri): Promise<SavedWorkspace | undefined> {
  try {
    const file = await readYamlFile(vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME));
    const id = file?.getString(WORKSPACE_ID);
    return id ? { id, name: file?.getString(WORKSPACE_NAME) ?? id } : undefined;
  } catch (err) {
    // A hand edit gone wrong: treat as no workspace. Saving reports the error with its line.
    getLogger().warn(err instanceof YamlFileError ? `Ignoring invalid settings. ${err.message}` : 'Couldn\'t read local settings', err);
    return undefined;
  }
}

/** Saves the workspace in the settings file, creating it and the folder's `.gitignore` as needed. */
async function writeLocal(dir: vscode.Uri, workspace: SavedWorkspace): Promise<void> {
  await vscode.workspace.fs.createDirectory(dir);
  const gitignore = vscode.Uri.joinPath(dir, '.gitignore');
  if (!(await exists(gitignore))) {
    await vscode.workspace.fs.writeFile(gitignore, new TextEncoder().encode(LOCAL_GITIGNORE));
  }
  await updateYamlFile(
    vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME),
    [
      [WORKSPACE_ID, workspace.id],
      [WORKSPACE_NAME, workspace.name],
    ],
    NEW_SETTINGS_FILE,
  );
}

/** Blanks the workspace in the settings file, if there is one. */
async function clearLocal(dir: vscode.Uri): Promise<void> {
  const file = vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
  if (await exists(file)) {
    await updateYamlFile(
      file,
      [
        [WORKSPACE_ID, ''],
        [WORKSPACE_NAME, ''],
      ],
      NEW_SETTINGS_FILE,
    );
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** The default picker: lists the user's workspaces in a quick pick. */
export function createWorkspacePicker(client: FabricClient): WorkspacePicker {
  return async (currentId) => {
    const workspaces = await withProgress('Loading workspaces…', () => client.listWorkspaces());
    const picked = await vscode.window.showQuickPick(
      workspaces
        .sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map((ws) => ({ label: ws.id === currentId ? `$(check) ${ws.displayName}` : ws.displayName, ws })),
      {
        title: 'Fabric: Select a Workspace',
        placeHolder: workspaces.length ? 'Workspace to use for Fabric Supersat' : 'No workspaces found',
      },
    );
    return picked?.ws;
  };
}
