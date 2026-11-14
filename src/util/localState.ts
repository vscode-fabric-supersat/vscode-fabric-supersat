import * as vscode from 'vscode';

/** Hidden folder, in the project root, for this extension's local (per-person) files. */
export const LOCAL_DIR_NAME = '.fabric-supersat';

/** Makes git ignore the whole folder, including this file, without touching the project's own `.gitignore`. */
export const LOCAL_GITIGNORE = '# Local Fabric Supersat state, not for source control.\n*\n';

/**
 * The project folder: the first folder of the VS Code workspace, if one is open and its
 * file system can be written to.
 */
export function projectRoot(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder && vscode.workspace.fs.isWritableFileSystem(folder.scheme) !== false ? folder : undefined;
}

/** `.fabric-supersat` in the given project folder. */
export function localStateDir(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, LOCAL_DIR_NAME);
}

/** A write refused because its path leaves the project or goes through a symbolic link. */
export class UnsafePathError extends Error {
  constructor(readonly uri: vscode.Uri, reason: string) {
    super(`Refusing to write ${uri.toString(true)}: ${reason}`);
    this.name = 'UnsafePathError';
  }
}

/**
 * Throws `UnsafePathError` unless `target` is inside `root` and no part of the path below
 * `root` (folders and the file itself) is a symbolic link. A cloned project could
 * otherwise contain, say, a `.fabric-supersat` link that sends the extension's writes
 * anywhere on disk. Parts that don't exist yet are fine: they are created as real folders.
 */
export async function assertSafeWritePath(root: vscode.Uri, target: vscode.Uri): Promise<void> {
  const prefix = root.path.endsWith('/') ? root.path : `${root.path}/`;
  if (target.scheme !== root.scheme || target.authority !== root.authority || !target.path.startsWith(prefix)) {
    throw new UnsafePathError(target, `it is outside ${root.toString(true)}.`);
  }
  let uri = root;
  for (const part of target.path.slice(prefix.length).split('/').filter(Boolean)) {
    if (part === '.' || part === '..') {
      throw new UnsafePathError(target, 'the path is not normalized.');
    }
    uri = vscode.Uri.joinPath(uri, part);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return; // Doesn't exist yet, so neither does anything below it.
    }
    if (stat.type & vscode.FileType.SymbolicLink) {
      throw new UnsafePathError(target, `${uri.toString(true)} is a symbolic link.`);
    }
  }
}

/** The user chose not to create the local state folder. Logged, but not shown as an error. */
export class LocalStateDirDeclinedError extends Error {
  constructor(readonly dir: vscode.Uri) {
    super(`The ${LOCAL_DIR_NAME} folder wasn't created, so nothing was written to it.`);
    this.name = 'LocalStateDirDeclinedError';
  }
}

/** Asks the user whether to create the local state folder `dir`. */
export type ConfirmLocalStateDir = (dir: vscode.Uri) => Promise<boolean>;

let confirmCreate: ConfirmLocalStateDir | undefined;
/** Folders the user declined to create this session (only background writes respect this). */
const declined = new Set<string>();
/** The latest check-and-create per folder: writes at the same time wait their turn, so one question is asked. */
const creating = new Map<string, Promise<unknown>>();

/**
 * Set at activation, so the user is always asked before `.fabric-supersat` is created.
 * Without one (unit tests), folders are created without asking.
 */
export function setLocalStateDirConfirmation(confirm: ConfirmLocalStateDir | undefined): void {
  confirmCreate = confirm;
  declined.clear();
}

/** Called after `ensureLocalStateDir` creates a folder that didn't exist (e.g. to write its settings file). */
export type LocalStateDirCreated = (dir: vscode.Uri) => Promise<void>;

const createdListeners = new Set<LocalStateDirCreated>();

/** Runs `listener` each time a local state folder is created. Dispose to stop. */
export function onLocalStateDirCreated(listener: LocalStateDirCreated): vscode.Disposable {
  createdListeners.add(listener);
  return { dispose: () => createdListeners.delete(listener) };
}

export interface EnsureLocalStateDirOptions {
  /**
   * A write the user didn't ask for (e.g. refreshing `.ipynb` files at startup): once they
   * have declined to create the folder, it isn't asked again this session.
   */
  background?: boolean;
}

/**
 * Creates the local state folder, with the `.gitignore` that keeps it out of git. If it
 * doesn't exist yet, asks first (see `setLocalStateDirConfirmation`) and throws
 * `LocalStateDirDeclinedError` if the user says no; once created, runs the
 * `onLocalStateDirCreated` listeners (the workspace service writes `settings.yaml`).
 */
export async function ensureLocalStateDir(dir: vscode.Uri, options: EnsureLocalStateDirOptions = {}): Promise<void> {
  const key = dir.toString();
  const run = (creating.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => createLocalStateDir(dir, options.background === true));
  creating.set(key, run);
  try {
    await run;
  } finally {
    if (creating.get(key) === run) {
      creating.delete(key);
    }
  }
}

async function createLocalStateDir(dir: vscode.Uri, background: boolean): Promise<void> {
  const gitignore = vscode.Uri.joinPath(dir, '.gitignore');
  await assertSafeWritePath(vscode.Uri.joinPath(dir, '..'), gitignore);
  const isNew = !(await exists(dir));
  if (isNew) {
    await confirmLocalStateDir(dir, background);
  }
  await vscode.workspace.fs.createDirectory(dir);
  if (!(await exists(gitignore))) {
    await vscode.workspace.fs.writeFile(gitignore, new TextEncoder().encode(LOCAL_GITIGNORE));
  }
  if (isNew) {
    for (const listener of createdListeners) {
      await listener(dir);
    }
  }
}

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function confirmLocalStateDir(dir: vscode.Uri, background: boolean): Promise<void> {
  if (!confirmCreate) {
    return;
  }
  const key = dir.toString();
  if (background && declined.has(key)) {
    throw new LocalStateDirDeclinedError(dir);
  }
  if (!(await confirmCreate(dir))) {
    declined.add(key);
    throw new LocalStateDirDeclinedError(dir);
  }
  declined.delete(key);
}

/** The production confirmation: a modal warning naming the folder and what goes in it. */
export const askToCreateLocalStateDir: ConfirmLocalStateDir = async (dir) => {
  const project = vscode.workspace.asRelativePath(vscode.Uri.joinPath(dir, '..'), true) || 'this project';
  const choice = await vscode.window.showWarningMessage(
    `Create a ${LOCAL_DIR_NAME} folder in ${project}?`,
    {
      modal: true,
      detail:
        `Fabric Supersat keeps your local settings (${LOCAL_DIR_NAME}/settings.yaml) and each notebook's .ipynb copy, ` +
        'with its outputs, in this folder. It contains its own .gitignore, so git ignores it.',
    },
    'Create Folder',
  );
  return choice === 'Create Folder';
};
