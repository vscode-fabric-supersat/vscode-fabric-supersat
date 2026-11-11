/**
 * The project's local settings file, `.fabric-supersat/settings.yaml` (git-ignored, for
 * people to read and edit): the selected workspace's name. The notebook settings, which
 * are committed, are in `src/fabric-supersat.yaml` (see `notebooks/notebookSettings.ts`).
 *
 * In Restricted Mode (an untrusted folder), and without a writable folder, the file is
 * neither read nor written: whoever supplied the folder could have chosen its workspace.
 * The user setting is used instead.
 */
import * as vscode from 'vscode';
import { assertSafeWritePath, ensureLocalStateDir, exists, localStateDir } from '../util/localState';
import { getLogger } from '../util/logger';
import { readYamlFile, updateYamlFile, YamlFileError } from '../util/yamlFile';

/** The settings file's name, in `.fabric-supersat`. */
export const SETTINGS_FILE_NAME = 'settings.yaml';

/** Contents of a new `settings.yaml`; the placeholder keeps the comment next to its value. */
export const NEW_SETTINGS_FILE = `# Fabric Supersat settings for this project.
# They are yours only: this folder is ignored by git. Edit them here or with
# Fabric Supersat commands; your comments and layout are kept.

# Name of the selected Fabric workspace, which commands work in.
# Change it with "Fabric Supersat: Select Workspace".
workspace:
  name: ""
`;

const WORKSPACE_NAME = ['workspace', 'name'] as const;

export interface ProjectSettingsOptions {
  /**
   * Folder for local state, or `undefined` when there is none. Defaults to
   * `.fabric-supersat` in the first folder of the VS Code workspace.
   */
  localDir?: () => vscode.Uri | undefined;
  /** Whether the VS Code workspace is trusted; defaults to `vscode.workspace.isTrusted`. */
  isTrusted?: () => boolean;
}

/** `.fabric-supersat/settings.yaml` in the project, when it can be used. */
export class ProjectSettings {
  private readonly localDir: () => vscode.Uri | undefined;
  private readonly isTrusted: () => boolean;

  constructor(options: ProjectSettingsOptions = {}) {
    this.localDir = options.localDir ?? defaultLocalDir;
    this.isTrusted = options.isTrusted ?? (() => vscode.workspace.isTrusted);
  }

  /** The local state folder, unless there is no folder open, it can't be written to, or it isn't trusted. */
  dir(): vscode.Uri | undefined {
    if (!this.isTrusted()) {
      return undefined;
    }
    const dir = this.localDir();
    return dir && vscode.workspace.fs.isWritableFileSystem(dir.scheme) !== false ? dir : undefined;
  }

  /** The settings file, or `undefined` when it can't be used (see `dir`). */
  get file(): vscode.Uri | undefined {
    const dir = this.dir();
    return dir && vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
  }

  /** Whether the settings file can be used and exists. */
  async exists(): Promise<boolean> {
    const file = this.file;
    return !!file && (await exists(file));
  }

  /**
   * The workspace name in the file (`undefined` if none, or the file can't be used).
   * Throws `YamlFileError` if the file isn't valid.
   */
  async readWorkspaceNameStrict(): Promise<string | undefined> {
    const file = this.file;
    return file && (await readYamlFile(file))?.getString(WORKSPACE_NAME);
  }

  /** The workspace name in the file; an invalid file (a hand edit gone wrong) is logged and reads as none. */
  async readWorkspaceName(): Promise<string | undefined> {
    try {
      return await this.readWorkspaceNameStrict();
    } catch (err) {
      getLogger().warn(err instanceof YamlFileError ? `Ignoring invalid settings. ${err.message}` : 'Couldn\'t read local settings', err);
      return undefined;
    }
  }

  /**
   * Saves the workspace name in the file, creating the file and the folder's `.gitignore`
   * as needed. Does nothing when the file can't be used.
   */
  async writeWorkspaceName(name: string): Promise<void> {
    const dir = this.dir();
    if (!dir) {
      return;
    }
    await ensureLocalStateDir(dir);
    const file = vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
    await assertSafeWritePath(vscode.Uri.joinPath(dir, '..'), file);
    await updateYamlFile(file, [[WORKSPACE_NAME, name]], NEW_SETTINGS_FILE);
  }

  /** Blanks the workspace name in the file, if there is one (its comments stay). */
  async clearWorkspaceName(): Promise<void> {
    const dir = this.dir();
    const file = dir && vscode.Uri.joinPath(dir, SETTINGS_FILE_NAME);
    if (dir && file && (await exists(file))) {
      await assertSafeWritePath(vscode.Uri.joinPath(dir, '..'), file);
      await updateYamlFile(file, [[WORKSPACE_NAME, '']], NEW_SETTINGS_FILE);
    }
  }
}

function defaultLocalDir(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && localStateDir(folder.uri);
}
