/**
 * Each notebook in a workspace as last fetched from Fabric, so "Compare All Notebooks with
 * Workspace" needs no requests to Fabric. One folder per notebook:
 *
 *     .fabric-supersat/workspaces/<Workspace Name>/notebooks-cache/<Notebook Name>/
 *       notebook-content.py   Fabric's Git-format file, as fetched (LF line endings)
 *       cache-info.json       its ID, when it was fetched, why it couldn't be (if it couldn't), and its description and folder
 *
 * (A notebook name that can't be a folder name is encoded, as `safeFolderName` does.)
 *
 * "Refresh Workspace Information" (with notebook details) writes the whole cache: it creates
 * the `notebooks-cache` folder, and removes notebooks no longer in the workspace. After
 * that, download, upload, delete and "Compare Notebook with Workspace" keep the notebooks
 * they touch up to date. Without the folder they don't start one, since a partial cache
 * would look like the whole workspace. Changes made in Fabric by anyone else aren't seen
 * until the next refresh.
 *
 * Each notebook's folder is written on its own (one at a time per notebook), so bulk
 * commands need no shared file. Bookkeeping only: no command acts on an ID read from it.
 */
import * as vscode from 'vscode';
import type { Notebook } from '../fabric/client';
import { CANCELLED_ERROR, type FabricProperties, type RemoteNotebook, summarizeNotebook } from '../notebooks/remote';
import { mapLimit } from '../util/concurrency';
import { safeFolderName } from '../util/folderNames';
import { KeyedLock } from '../util/keyedLock';
import { toLf } from '../util/text';
import { createLocalStateDir, deleteLocalStatePath, WORKSPACES_DIR, workspaceFolderName, workspaceStateDir, writeLocalStateFile } from './state';

export const NOTEBOOKS_CACHE_DIR = 'notebooks-cache';
export const CACHE_INFO_FILE = 'cache-info.json';
/** The file a notebook's text is kept in when Fabric's file name can't be used. */
const DEFAULT_GIT_FILE = 'notebook-content.py';
/** How many notebooks' folders a refresh writes at once. */
const WRITE_CONCURRENCY = 8;

export interface CachedNotebook {
  /** The notebook's name, as Fabric shows it. */
  name: string;
  /** Fabric's item ID (missing for a notebook created by an upload that didn't report it). */
  id?: string;
  /** Fabric's Git-format file name, e.g. `notebook-content.py`. */
  gitPath?: string;
  /** Its text, with LF line endings (kept in its own file, not in `cache-info.json`). */
  gitText?: string;
  language?: string;
  unsupported?: string;
  /** Why it couldn't be fetched. */
  error?: string;
  /** When it was fetched (or uploaded). */
  fetched: string;
  /** Its description and folder in Fabric; missing in caches written before they were kept, or if not known. */
  properties?: FabricProperties;
}

export interface NotebookCache {
  /** When the oldest cached notebook was fetched: the cache is at least this up to date. */
  asOf?: string;
  notebooks: CachedNotebook[];
}

/** What a refresh did with notebooks it didn't reach before it was cancelled. */
export interface CacheWriteResult {
  /** Not fetched: their previous cached version is kept. */
  kept: string[];
  /** Not fetched, and with no previous cached version. */
  missing: string[];
}

const folderLock = new KeyedLock();

function cacheParts(workspaceName: string, ...rest: string[]): string[] {
  return [WORKSPACES_DIR, workspaceFolderName(workspaceName), NOTEBOOKS_CACHE_DIR, ...rest];
}

function cacheDir(root: vscode.Uri, workspaceName: string): vscode.Uri {
  return vscode.Uri.joinPath(workspaceStateDir(root, workspaceName), NOTEBOOKS_CACHE_DIR);
}

/** The notebooks' folder names in the cache, or `undefined` if there is no cache. */
async function cachedFolders(root: vscode.Uri, workspaceName: string): Promise<string[] | undefined> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(cacheDir(root, workspaceName));
    return entries.filter(([, type]) => type === vscode.FileType.Directory).map(([name]) => name);
  } catch {
    return undefined;
  }
}

/** The existing folder for a notebook, matched ignoring case (as Fabric matches names). */
function folderFor(folders: readonly string[], name: string): string | undefined {
  const folder = safeFolderName(name).toLowerCase();
  return folders.find((f) => f.toLowerCase() === folder);
}

/** A file name for Fabric's Git-format file: its own name if it's a plain, safe file name. */
function gitFileName(gitPath: string | undefined): string {
  return gitPath && !gitPath.includes('/') && safeFolderName(gitPath) === gitPath && gitPath !== CACHE_INFO_FILE ? gitPath : DEFAULT_GIT_FILE;
}

/** Replaces a notebook's folder (removing `replaces` first, if it's named differently) with `entry`. */
async function writeEntry(root: vscode.Uri, workspaceName: string, entry: CachedNotebook, replaces?: string): Promise<void> {
  const folder = safeFolderName(entry.name);
  await folderLock.run(`${workspaceName}\n${folder.toLowerCase()}`, async () => {
    await deleteLocalStatePath(root, cacheParts(workspaceName, replaces ?? folder));
    const { gitText, ...info } = entry;
    if (gitText !== undefined) {
      await writeLocalStateFile(root, cacheParts(workspaceName, folder, gitFileName(entry.gitPath)), gitText);
    }
    await writeLocalStateFile(root, cacheParts(workspaceName, folder, CACHE_INFO_FILE), `${JSON.stringify(info, undefined, 2)}\n`);
  });
}

async function readEntry(root: vscode.Uri, workspaceName: string, folder: string): Promise<CachedNotebook | undefined> {
  const dir = vscode.Uri.joinPath(cacheDir(root, workspaceName), folder);
  const read = async (file: string) => new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, file)));
  let info: CachedNotebook;
  try {
    info = JSON.parse(await read(CACHE_INFO_FILE)) as CachedNotebook;
    if (typeof info.name !== 'string' || typeof info.fetched !== 'string') {
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (info.gitPath && !info.error) {
    try {
      info.gitText = await read(gitFileName(info.gitPath));
    } catch {
      info.error = `The cached file ${gitFileName(info.gitPath)} is missing. Run Refresh Workspace Information again.`;
    }
  }
  return info;
}

/** A workspace's notebook cache, or `undefined` if there is none. */
export async function readNotebookCache(root: vscode.Uri, workspaceName: string): Promise<NotebookCache | undefined> {
  const folders = await cachedFolders(root, workspaceName);
  if (!folders) {
    return undefined;
  }
  const notebooks = (await Promise.all(folders.map((f) => readEntry(root, workspaceName, f)))).filter((n): n is CachedNotebook => !!n);
  const asOf = notebooks.map((n) => n.fetched).sort()[0];
  return { ...(asOf ? { asOf } : {}), notebooks: notebooks.sort((a, b) => a.name.localeCompare(b.name)) };
}

/** The cache entry for a fetched notebook. */
export function cacheEntry(source: RemoteNotebook, time = new Date().toISOString()): CachedNotebook {
  return {
    name: source.notebook.displayName,
    id: source.notebook.id,
    ...(source.gitPath ? { gitPath: source.gitPath } : {}),
    ...(source.gitText !== undefined ? { gitText: toLf(source.gitText) } : {}),
    ...(source.language ? { language: source.language } : {}),
    ...(source.unsupported ? { unsupported: source.unsupported } : {}),
    ...(source.error ? { error: source.error } : {}),
    fetched: time,
    ...(source.properties ? { properties: { ...source.properties } } : {}),
  };
}

/** The cache entry for a notebook's Git-format file just downloaded or uploaded (a supported notebook). */
export function transferredEntry(
  name: string,
  id: string | undefined,
  gitPath: string,
  gitText: string,
  properties?: FabricProperties,
): CachedNotebook {
  return {
    name,
    ...(id ? { id } : {}),
    gitPath,
    gitText: toLf(gitText),
    language: summarizeNotebook(gitPath, gitText).language,
    fetched: new Date().toISOString(),
    ...(properties ? { properties } : {}),
  };
}

/**
 * Writes the whole cache from a refresh: one folder per notebook in the workspace, and
 * removes folders of notebooks no longer in it. A notebook not reached before the refresh
 * was cancelled keeps its previous folder, if it has one; the result lists those, and the
 * ones with none, for the caller to warn about.
 */
export async function writeNotebookCache(root: vscode.Uri, workspaceName: string, sources: readonly RemoteNotebook[]): Promise<CacheWriteResult> {
  const time = new Date().toISOString();
  const previous = (await cachedFolders(root, workspaceName)) ?? [];
  await createLocalStateDir(root, cacheParts(workspaceName));
  const result: CacheWriteResult = { kept: [], missing: [] };
  const current = new Set<string>();
  await mapLimit(sources, WRITE_CONCURRENCY, async (source) => {
    const name = source.notebook.displayName;
    const old = folderFor(previous, name);
    if (source.cancelled && old) {
      result.kept.push(name);
      current.add(old.toLowerCase());
      return;
    }
    if (source.cancelled) {
      result.missing.push(name);
    }
    current.add(safeFolderName(name).toLowerCase());
    await writeEntry(root, workspaceName, cacheEntry(source, time), old);
  });
  for (const folder of previous.filter((f) => !current.has(f.toLowerCase()))) {
    await deleteLocalStatePath(root, cacheParts(workspaceName, folder));
  }
  result.kept.sort((a, b) => a.localeCompare(b));
  result.missing.sort((a, b) => a.localeCompare(b));
  return result;
}

/**
 * Updates one notebook in an existing cache (`entry`), or removes it (`undefined`, e.g.
 * deleted from Fabric). Names match ignoring case, as Fabric matches them. Does nothing if
 * the workspace has no cache.
 */
export async function updateCachedNotebook(root: vscode.Uri, workspaceName: string, name: string, entry: CachedNotebook | undefined): Promise<void> {
  const folders = await cachedFolders(root, workspaceName);
  if (!folders) {
    return;
  }
  const old = folderFor(folders, name);
  if (!entry) {
    if (old) {
      await deleteLocalStatePath(root, cacheParts(workspaceName, old));
    }
    return;
  }
  // An upload that created the notebook may not report its ID: keep the one cached, if any.
  const id = entry.id ?? (old ? (await readEntry(root, workspaceName, old))?.id : undefined);
  await writeEntry(root, workspaceName, { ...entry, ...(id ? { id } : {}) }, old);
}

/** The cached notebooks as fetched notebooks, for comparing with local files. */
export function cachedSources(cache: NotebookCache, workspaceId: string): RemoteNotebook[] {
  return cache.notebooks.map((entry): RemoteNotebook => {
    const notebook: Notebook = { id: entry.id ?? '', displayName: entry.name, type: 'Notebook', workspaceId };
    return {
      notebook,
      gitPath: entry.gitPath,
      gitText: entry.gitText,
      language: entry.language,
      unsupported: entry.unsupported,
      error: entry.error,
      ...(entry.error === CANCELLED_ERROR ? { cancelled: true as const } : {}),
      ...(isProperties(entry.properties) ? { properties: { ...entry.properties } } : {}),
    };
  });
}

/** Whether cached properties are usable (a cache file may have been edited by hand). */
function isProperties(value: unknown): value is FabricProperties {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const { description, folder } = value as Record<string, unknown>;
  return typeof description === 'string' && (folder === undefined || typeof folder === 'string');
}
