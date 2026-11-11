/**
 * Notebooks as they are in Fabric, fetched without writing anything in `src/`: for
 * "Refresh Workspace Information" (notebook details, cached for "Compare All Notebooks with
 * Workspace"), "Test Notebook Formats" and "Compare Notebook with Workspace".
 */
import type { FabricClient, Notebook } from '../fabric/client';
import { mapLimit } from '../util/concurrency';
import { asObject as obj, type JsonObject, nonEmptyString as str } from '../util/json';
import { toLf } from '../util/text';
import { contentParts, findPartText, partText } from './definition';
import { ANY_CELL_MARKER, ANY_META_LINE, ANY_METADATA_MARKER } from './format';
import { CURRENT_WORKSPACE_ID } from './references';
import { isTsqlNotebook, unsupportedNotebook } from './support';

export interface RemoteNotebook {
  notebook: Notebook;
  /** Fabric's Git-format file, e.g. `notebook-content.py` (what download writes). */
  gitPath?: string;
  gitText?: string;
  /** Fabric's `.ipynb` export (`source: 'both'` only). */
  ipynbText?: string;
  /** The notebook's language (see `summarizeNotebook`). */
  language?: string;
  /** Why it isn't supported (from its Git-format file), if it isn't. */
  unsupported?: string;
  /** Why it couldn't be fetched. */
  error?: string;
  /** Not fetched because the user cancelled first (`error` says so too). */
  cancelled?: true;
  /** Its description and folder in Fabric (`undefined` if not known, e.g. an older cache). */
  properties?: FabricProperties;
}

/** A notebook's properties in Fabric, as `notebook.yaml` holds them. */
export interface FabricProperties {
  /** `''` for none. */
  description: string;
  /** Its folder path (`''` for the workspace root); `undefined` if Fabric's folders couldn't be read. */
  folder?: string;
}

/**
 * Fills in each notebook's folder path from `pathOf` (`''` for the workspace root). One whose
 * folder can't be found is left without a folder, so its folder isn't compared.
 */
export async function addFolderPaths(sources: readonly RemoteNotebook[], pathOf: (folderId: string | undefined) => Promise<string>): Promise<void> {
  for (const source of sources) {
    if (!source.properties) {
      continue;
    }
    try {
      source.properties.folder = await pathOf(source.notebook.folderId);
    } catch {
      delete source.properties.folder;
    }
  }
}

/** The `error` of a notebook not fetched because the user cancelled. */
export const CANCELLED_ERROR = 'Not fetched: cancelled before it was reached.';

export interface FetchOptions {
  /**
   * `git` (the default): one request per notebook, Fabric's Git-format file, as download
   * fetches. `both`: the `.ipynb` export too ("Test Notebook Formats").
   */
  source?: 'git' | 'both';
  concurrency?: number;
  isCancelled?: () => boolean;
  onProgress?: (name: string, done: number, total: number) => void;
}

/**
 * Fetches notebooks' Fabric sources, `concurrency` notebooks at a time (with `source:
 * 'both'`, a notebook's two exports at the same time; the client's limiter decides how many
 * requests actually run at once). Returns one entry per notebook, in order: failures are
 * recorded per notebook, and notebooks not reached before `isCancelled` are marked `cancelled`.
 */
export async function fetchNotebookSources(
  client: FabricClient,
  workspaceId: string,
  notebooks: readonly Notebook[],
  options: FetchOptions = {},
): Promise<RemoteNotebook[]> {
  let done = 0;
  const results = await mapLimit(
    notebooks,
    options.concurrency ?? 1,
    async (notebook): Promise<RemoteNotebook> => {
      try {
        const [git, ipynb] = await Promise.all([
          client.getNotebookDefinition(workspaceId, notebook.id),
          options.source === 'both' ? client.getNotebookDefinition(workspaceId, notebook.id, 'ipynb') : undefined,
        ]);
        const result: RemoteNotebook = {
          notebook,
          ipynbText: ipynb && findPartText(ipynb, '.ipynb'),
          properties: { description: notebook.description ?? '' },
        };
        const [content] = contentParts(git);
        if (!content) {
          result.error = `Fabric returned no notebook-content file (got: ${git.parts.map((p) => p.path).join(', ') || 'none'}).`;
          return result;
        }
        result.gitPath = content.path;
        result.gitText = partText(content);
        result.language = summarizeNotebook(content.path, result.gitText).language;
        result.unsupported = unsupportedNotebook(notebook.displayName, content.path, result.gitText);
        return result;
      } catch (err) {
        return { notebook, error: err instanceof Error ? err.message : String(err) };
      } finally {
        options.onProgress?.(notebook.displayName, ++done, notebooks.length);
      }
    },
    options.isCancelled,
  );
  return results.map((r, i): RemoteNotebook => r ?? { notebook: notebooks[i], error: CANCELLED_ERROR, cancelled: true });
}

/** What a notebook's header says about it. */
export interface NotebookSummary {
  /** PySpark, Python, Spark SQL, T-SQL, Scala or SparkR (or the kernel name, if unknown). */
  language: string;
  kernel?: string;
  cells: number;
  defaultLakehouse?: { id: string; name?: string; workspaceId?: string };
  otherLakehouses: string[];
  environment?: { id: string; workspaceId?: string };
  warehouses: { id: string; type?: string }[];
}

const KERNEL_LANGUAGES: Record<string, string> = {
  synapse_pyspark: 'PySpark',
  jupyter: 'Python',
  sqldatawarehouse: 'T-SQL',
};
const EXTENSION_LANGUAGES: Record<string, string> = { sql: 'Spark SQL', scala: 'Scala', r: 'SparkR' };

/** Summarises a Git-format notebook file of any language (`# META`, `-- META` or `// META` lines). */
export function summarizeNotebook(path: string, original: string): NotebookSummary {
  const text = toLf(original);
  const meta = headerMeta(text);
  const kernelInfo = obj(meta?.kernel_info);
  const kernel = str(kernelInfo?.name);
  const extension = path.split('.').pop()!.toLowerCase();
  const language = isTsqlNotebook(text)
    ? 'T-SQL'
    : (EXTENSION_LANGUAGES[extension] ?? (kernel && KERNEL_LANGUAGES[kernel]) ?? kernel ?? 'unknown');
  const dependencies = obj(meta?.dependencies);
  const lakehouse = obj(dependencies?.lakehouse);
  const environment = obj(dependencies?.environment);
  const warehouse = obj(dependencies?.warehouse);
  const defaultId = str(lakehouse?.default_lakehouse);
  const known = Array.isArray(lakehouse?.known_lakehouses) ? lakehouse.known_lakehouses : [];
  return {
    language,
    kernel,
    cells: text.split('\n').filter((l) => ANY_CELL_MARKER.test(l)).length,
    defaultLakehouse: defaultId
      ? {
          id: defaultId,
          name: str(lakehouse?.default_lakehouse_name),
          workspaceId: str(lakehouse?.default_lakehouse_workspace_id),
        }
      : undefined,
    otherLakehouses: known.map((k) => str(obj(k)?.id)).filter((id): id is string => !!id && id !== defaultId),
    environment: str(environment?.environmentId)
      ? { id: str(environment?.environmentId)!, workspaceId: str(environment?.workspaceId) }
      : undefined,
    warehouses: (Array.isArray(warehouse?.known_warehouses) ? warehouse.known_warehouses : [])
      .map((w) => ({ id: str(obj(w)?.id) ?? '', type: str(obj(w)?.type) }))
      .filter((w) => w.id),
  };
}

/** Whether a workspace ID in a notebook means `workspaceId`: that ID, "current workspace" (all zeros), or none. */
export function isOwnWorkspace(id: string | undefined, workspaceId: string): boolean {
  return !id || id.toLowerCase() === CURRENT_WORKSPACE_ID || id.toLowerCase() === workspaceId.toLowerCase();
}

/** The notebook-level metadata block at the top of a Git-format file, whatever its comment prefix. */
function headerMeta(text: string): JsonObject | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => ANY_METADATA_MARKER.test(l));
  if (start < 0 || lines.slice(0, start).some((l) => ANY_CELL_MARKER.test(l))) {
    return undefined;
  }
  const json: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = ANY_META_LINE.exec(line);
    if (match) {
      json.push(match[1]);
    } else if (json.length && line.trim()) {
      break;
    }
  }
  try {
    const parsed: unknown = JSON.parse(json.join('\n'));
    return obj(parsed);
  } catch {
    return undefined;
  }
}
