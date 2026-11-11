/**
 * The project's notebook settings file, `src/fabric-supersat.yaml`: the notebook reference
 * settings, which override the VS Code settings of the same names. It is committed with
 * the notebooks, so everyone working on the project uploads with the same rules.
 *
 * Like the notebook files themselves, it is used in every mode, Restricted Mode included.
 * It is created (with the settings in effect) when a command first writes or uploads
 * notebooks, and never changed by the extension after that.
 */
import * as vscode from 'vscode';
import { getConfig } from '../util/config';
import { assertSafeWritePath, exists, projectRoot } from '../util/localState';
import { getLogger } from '../util/logger';
import { readYamlFile, updateYamlFile, type YamlFile, YamlFileError, type YamlPath } from '../util/yamlFile';
import { SOURCE_DIR } from './files';
import type { ReferenceKind, ReferenceSettings, WorkspaceReferenceKind } from './references';

/** The notebook settings file's name, in `src`. */
export const NOTEBOOK_SETTINGS_FILE_NAME = 'fabric-supersat.yaml';

/** Contents of a new `src/fabric-supersat.yaml`; the placeholders keep each comment next to its value. */
export const NEW_NOTEBOOK_SETTINGS_FILE = `# Fabric Supersat notebook settings for this project.
# Commit this file with your notebooks: everyone using the project uploads with these
# settings. Edit them here; your comments and layout are kept.

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
  # true saves the workspace as "current workspace" (all zeros: the workspace the notebook
  # runs in) where it is the workspace downloaded from or uploaded to: in downloaded
  # notebooks, and when upload writes new IDs to the local files.
  currentWorkspace:
    defaultLakehouse: false
    environment: false
`;

const UPLOAD_KINDS: readonly ReferenceKind[] = ['defaultLakehouse', 'otherLakehouses', 'environment'];
const CURRENT_WORKSPACE_KINDS: readonly WorkspaceReferenceKind[] = ['defaultLakehouse', 'environment'];
const uploadPath = (kind: ReferenceKind) => ['notebooks', 'upload', kind] as const;
const currentWorkspacePath = (kind: WorkspaceReferenceKind) => ['notebooks', 'currentWorkspace', kind] as const;

export interface NotebookSettingsOptions {
  /** The project folder, or `undefined` when there is none; defaults to `projectRoot()`. */
  root?: () => vscode.Uri | undefined;
}

/** `src/fabric-supersat.yaml` in the project. */
export class NotebookSettings {
  private readonly root: () => vscode.Uri | undefined;

  constructor(options: NotebookSettingsOptions = {}) {
    this.root = options.root ?? projectRoot;
  }

  /** The settings file, or `undefined` when no project folder (that can be written to) is open. */
  get file(): vscode.Uri | undefined {
    const root = this.root();
    return root && vscode.Uri.joinPath(root, SOURCE_DIR, NOTEBOOK_SETTINGS_FILE_NAME);
  }

  /**
   * The notebook reference settings in effect: the file's values, which override the VS
   * Code settings (`fabric-supersat.notebooks.*`); a value missing from the file comes
   * from the VS Code setting. Without the file, the VS Code settings. Throws
   * `YamlFileError` for an invalid file or value, rather than guessing. Never writes.
   */
  async read(): Promise<ReferenceSettings> {
    const base = getConfig().notebooks.references;
    const file = this.file;
    return file ? readNotebookSettings(await readYamlFile(file), file, base) : base;
  }

  /**
   * Creates the file from the template, with the settings in effect (the current VS Code
   * settings, defaults included), unless it exists or there is no project folder. Called
   * by commands that write or upload notebooks.
   */
  async createFile(): Promise<void> {
    const root = this.root();
    const file = this.file;
    if (!root || !file || (await exists(file))) {
      return;
    }
    await assertSafeWritePath(root, file);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
    await updateYamlFile(file, notebookValues(), NEW_NOTEBOOK_SETTINGS_FILE);
    getLogger().info(`Created ${vscode.workspace.asRelativePath(file)} with the notebook settings in effect`);
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
  const currentWorkspace = { ...base.currentWorkspace };
  for (const kind of CURRENT_WORKSPACE_KINDS) {
    const path = currentWorkspacePath(kind);
    const value = file?.getString(path);
    if (value === 'true' || value === 'false') {
      currentWorkspace[kind] = value === 'true';
    } else if (value !== undefined) {
      throw new YamlFileError(uri, `"${path.join('.')}" should be true or false, not "${value}".`);
    }
  }
  return { upload, currentWorkspace };
}

/** The current VS Code notebook settings, as values for a new settings file. */
function notebookValues(): [YamlPath, string | boolean][] {
  const { upload, currentWorkspace } = getConfig().notebooks.references;
  return [
    ...UPLOAD_KINDS.map((kind): [YamlPath, string] => [uploadPath(kind), upload[kind]]),
    ...CURRENT_WORKSPACE_KINDS.map((kind): [YamlPath, boolean] => [currentWorkspacePath(kind), currentWorkspace[kind]]),
  ];
}
