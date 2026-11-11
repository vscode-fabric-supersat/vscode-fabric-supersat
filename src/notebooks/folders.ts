/**
 * Workspace folders, by path: a notebook's `folder` in its `<Name>.yaml` is a path of folder
 * names such as `Bronze/Ingest`, matched by name in each workspace (as lakehouses are), never by
 * ID. `""` is the workspace root. No `vscode` dependency.
 *
 * Notebook names are unique across the whole workspace, whatever folder they are in, so a
 * folder is only where a notebook is, never part of how it's found.
 */
import type { FabricClient, Folder } from '../fabric/client';
import { findByName } from '../util/names';

/** Fabric allows at most 10 levels of nested folders. */
export const MAX_FOLDER_DEPTH = 10;
/** Fabric's limit for a folder name. */
export const MAX_FOLDER_NAME_LENGTH = 255;

/** Characters Fabric doesn't allow in folder names (C0 and C1 control codes too). `/` separates them in a path. */
const FOLDER_NAME_CHARACTER = /[~"#.&*:<>?/{|}\u0000-\u001f\u007f-\u009f]/;
/** Names Fabric reserves for itself. */
const RESERVED_FOLDER_NAME = /^(\$recycle\.bin|recycled|recycler)$/i;

/** Why `name` can't be a Fabric folder name (to finish 'The folder name "…" '), or `undefined` if it can. */
export function folderNameProblem(name: string): string | undefined {
  if (name === '') {
    return 'is empty';
  }
  if (FOLDER_NAME_CHARACTER.test(name)) {
    return 'contains a character Fabric doesn\'t allow in folder names (~ " # . & * : < > ? / { | })';
  }
  if (name !== name.trim()) {
    return 'starts or ends with a space';
  }
  if (RESERVED_FOLDER_NAME.test(name)) {
    return 'is a name Fabric reserves';
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return `is ${name.length} characters; Fabric allows at most ${MAX_FOLDER_NAME_LENGTH}`;
  }
  return undefined;
}

/**
 * The folder names in a path such as `Bronze/Ingest` (`[]` for `""`, the workspace root). A
 * leading or trailing `/` is ignored. Throws an `Error` saying what's wrong (to follow "<file>: ").
 */
export function parseFolderPath(path: string): string[] {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    return [];
  }
  const names = trimmed.split('/');
  for (const name of names) {
    const problem = folderNameProblem(name);
    if (problem) {
      throw new Error(name === '' ? `the folder "${path}" has an empty folder name (//).` : `in the folder "${path}", the name "${name}" ${problem}.`);
    }
  }
  if (names.length > MAX_FOLDER_DEPTH) {
    throw new Error(`the folder "${path}" is ${names.length} levels deep; Fabric allows at most ${MAX_FOLDER_DEPTH}.`);
  }
  return names;
}

/** A folder path as written in `<Name>.yaml`: names joined with `/`, `""` for the workspace root. */
export function formatFolderPath(names: readonly string[]): string {
  return names.join('/');
}

/** Whether two folder paths name the same folder (ignoring case, as names are matched). */
export function sameFolderPath(a: string, b: string): boolean {
  return formatFolderPath(parseFolderPath(a)).toLowerCase() === formatFolderPath(parseFolderPath(b)).toLowerCase();
}

/** For messages: `folder "Bronze/Ingest"`, or `the workspace root`. */
export function folderLabel(path: string): string {
  return path ? `folder "${path}"` : 'the workspace root';
}

/** Each folder's path (`A/B`), by folder ID. A broken `parentFolderId` chain ends the path there. */
export function folderPathsOf(folders: readonly Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const pathOf = (folder: Folder, seen = new Set<string>()): string => {
    const known = paths.get(folder.id);
    if (known) {
      return known;
    }
    const parent = folder.parentFolderId ? byId.get(folder.parentFolderId) : undefined;
    const path = parent && !seen.has(parent.id) ? `${pathOf(parent, seen.add(folder.id))}/${folder.displayName}` : folder.displayName;
    paths.set(folder.id, path);
    return path;
  };
  folders.forEach((f) => pathOf(f));
  return paths;
}

/** Whether two folder IDs are the same folder; `undefined` is the workspace root. */
export function sameFolderId(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
}

/**
 * A workspace's folders, listed from Fabric the first time they're needed (so commands that
 * never meet a folder send no folder requests), then kept for the command: shared by its
 * notebooks, and updated with the folders it creates.
 */
export class WorkspaceFolders {
  private folders?: Promise<Folder[]>;
  /** Creating folders runs one path at a time, so two notebooks never create the same folder. */
  private creating: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: FabricClient,
    private readonly workspaceId: string,
  ) {}

  /** The path of the folder with this ID (`""` for none: the workspace root). Throws if Fabric has no such folder. */
  async pathOf(folderId: string | undefined): Promise<string> {
    if (!folderId) {
      return '';
    }
    const folders = await this.list();
    const folder = folders.find((f) => sameFolderId(f.id, folderId));
    const path = folder && folderPathsOf(folders).get(folder.id);
    if (path === undefined) {
      throw new Error(`Fabric didn't list the folder ${folderId}; it may have just been deleted.`);
    }
    return path;
  }

  /**
   * The ID of the folder at `path` (`undefined` for the workspace root), creating any of its
   * folders that don't exist yet. Names are matched as item names are: exactly, then ignoring case.
   */
  ensure(path: string): Promise<string | undefined> {
    const names = parseFolderPath(path);
    if (!names.length) {
      return Promise.resolve(undefined);
    }
    const run = this.creating.then(async () => {
      const folders = await this.list();
      let parentId: string | undefined;
      for (const name of names) {
        const existing = findByName(
          folders.filter((f) => sameFolderId(f.parentFolderId, parentId)),
          name,
        );
        if (existing) {
          parentId = existing.id;
          continue;
        }
        const created = await this.client.createFolder(this.workspaceId, name, parentId);
        folders.push({ id: created.id, displayName: created.displayName ?? name, parentFolderId: parentId });
        parentId = created.id;
      }
      return parentId;
    });
    // A failure is the caller's to report; the next path still gets its turn.
    this.creating = run.catch(() => undefined);
    return run;
  }

  private list(): Promise<Folder[]> {
    if (!this.folders) {
      const listing = this.client.listFolders(this.workspaceId).then((folders) => [...folders]);
      // A failed listing is tried again next time, rather than remembered.
      listing.catch(() => {
        if (this.folders === listing) {
          this.folders = undefined;
        }
      });
      this.folders = listing;
    }
    return this.folders;
  }
}
