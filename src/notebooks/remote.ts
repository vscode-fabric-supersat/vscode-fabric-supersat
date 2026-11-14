/**
 * Notebooks as they are in Fabric, fetched without writing anything locally: for
 * "Download Workspace Metadata" (notebook details), "Test Notebook Formats" and "Compare
 * with Workspace".
 */
import type { FabricClient, ItemDefinition, Notebook } from '../fabric/client';
import { fromBase64 } from '../util/base64';
import { mapLimit } from '../util/concurrency';
import type { JsonObject } from './format';
import { SAME_WORKSPACE_ID } from './references';
import { isTsqlNotebook, unsupportedNotebook } from './transfer';

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
}

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

/** Fetches notebooks' Fabric sources, `concurrency` at a time; failures are recorded per notebook. */
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
        const result: RemoteNotebook = { notebook, ipynbText: ipynb && partText(ipynb, '.ipynb') };
        const content = git.parts.find((p) => /^notebook-content\.[a-z]+$/i.test(p.path));
        if (!content) {
          result.error = `Fabric returned no notebook-content file (got: ${git.parts.map((p) => p.path).join(', ') || 'none'}).`;
          return result;
        }
        result.gitPath = content.path;
        result.gitText = decode(content.payload);
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
  return results.filter((r): r is RemoteNotebook => r !== undefined);
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
export function summarizeNotebook(path: string, text: string): NotebookSummary {
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
    cells: (text.match(/^(#|--|\/\/) (CELL|MARKDOWN|PARAMETERS CELL) \*+$/gm) ?? []).length,
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

/** Whether a workspace ID in a notebook means the notebook's own workspace. */
export function isOwnWorkspace(id: string | undefined, workspaceId: string): boolean {
  return !id || id.toLowerCase() === SAME_WORKSPACE_ID || id.toLowerCase() === workspaceId.toLowerCase();
}

/** The notebook-level metadata block at the top of a Git-format file, whatever its comment prefix. */
function headerMeta(text: string): JsonObject | undefined {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^(#|--|\/\/) METADATA \*+$/.test(l));
  if (start < 0 || lines.slice(0, start).some((l) => /^(#|--|\/\/) (CELL|MARKDOWN|PARAMETERS CELL) \*+$/.test(l))) {
    return undefined;
  }
  const json: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^(#|--|\/\/) META ?(.*)$/.exec(line);
    if (match) {
      json.push(match[2]);
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

function decode(payload: string): string {
  return new TextDecoder().decode(fromBase64(payload));
}

function partText(definition: ItemDefinition, extension: string): string | undefined {
  const part = definition.parts.find((p) => p.path.endsWith(extension));
  return part && decode(part.payload);
}

function obj(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
