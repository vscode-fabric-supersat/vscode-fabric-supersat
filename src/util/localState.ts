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

/** Creates the local state folder, with the `.gitignore` that keeps it out of git. */
export async function ensureLocalStateDir(dir: vscode.Uri): Promise<void> {
  const gitignore = vscode.Uri.joinPath(dir, '.gitignore');
  await assertSafeWritePath(vscode.Uri.joinPath(dir, '..'), gitignore);
  await vscode.workspace.fs.createDirectory(dir);
  if (!(await exists(gitignore))) {
    await vscode.workspace.fs.writeFile(gitignore, new TextEncoder().encode(LOCAL_GITIGNORE));
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
