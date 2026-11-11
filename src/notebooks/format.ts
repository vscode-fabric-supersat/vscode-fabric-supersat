/**
 * Converts notebooks between Fabric's Git format (`notebook-content.py`) and Jupyter
 * (`notebook-content.ipynb`). No `vscode` dependency, so it runs anywhere and is easy to test.
 *
 * Fabric's Git format is plain Python with marker comments:
 *
 *     # Fabric notebook source
 *
 *     # METADATA ********************      <- notebook metadata (kernel, lakehouses)
 *
 *     # META { ...JSON... }
 *
 *     # MARKDOWN ********************      <- markdown cell, each line prefixed "# "
 *
 *     # # Title
 *
 *     # CELL ********************          <- code cell ("# PARAMETERS CELL" for parameters)
 *
 *     df = spark.read.table("sales")
 *
 *     # METADATA ********************      <- the cell's metadata (language)
 *
 *     # META { "language": "python", "language_group": "synapse_pyspark" }
 *
 * Code in another language (e.g. a `%%sql` cell) has each line prefixed `# MAGIC `.
 */

export type JsonObject = Record<string, unknown>;

export interface FabricCell {
  kind: 'code' | 'markdown';
  source: string;
  /** A parameters cell (`# PARAMETERS CELL`; the `parameters` tag in Jupyter). */
  parameters?: boolean;
  /** Fabric's cell metadata, e.g. `{ "language": "python", "language_group": "synapse_pyspark" }`. */
  meta?: JsonObject;
}

export interface FabricNotebook {
  /** Fabric's notebook metadata, e.g. `kernel_info` and lakehouse `dependencies`. */
  meta?: JsonObject;
  cells: FabricCell[];
}

/** First line of every notebook in Fabric's Git format. */
export const FABRIC_PY_HEADER = '# Fabric notebook source';
const HEADER = FABRIC_PY_HEADER;
const STARS = '********************';
const MARKER = /^# (METADATA|CELL|MARKDOWN|PARAMETERS CELL) \*+\s*$/;
/** Notebook metadata keys kept in the `.py` header; everything else stays in the `.ipynb`. */
const HEADER_META_KEYS = ['kernel_info', 'dependencies'];

/**
 * Key order Fabric uses in a `.py` header where its `.ipynb` uses another: the lakehouse
 * keys, as in every Fabric-written .py seen (a downloaded notebook and Microsoft's
 * fabric-cicd samples; see the test fixtures). Keys not listed keep the .ipynb's order.
 */
const FABRIC_PY_HEADER_ORDER: JsonObject = {
  kernel_info: { name: null, jupyter_kernel_name: null },
  dependencies: {
    lakehouse: {
      default_lakehouse: null,
      default_lakehouse_name: null,
      default_lakehouse_workspace_id: null,
      known_lakehouses: null,
    },
  },
};

export class NotebookFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotebookFormatError';
  }
}

// --- Fabric Git format (.py) ---

/**
 * The content check for Fabric's Git format: the first non-blank line is
 * `# Fabric notebook source`. An empty file also counts, as a new notebook with no cells.
 * `formatFabricPy` always writes that line, so everything it writes passes this check.
 */
export function isFabricPy(text: string): boolean {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.trim());
  return first === undefined || first.trimEnd() === HEADER;
}

/** Parses Fabric's Git format. Throws `NotebookFormatError` for anything else (see `isFabricPy`). */
export function parseFabricPy(text: string): FabricNotebook {
  if (!isFabricPy(text)) {
    throw new NotebookFormatError(`Not a Fabric notebook: the first line must be "${HEADER}".`);
  }
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const notebook: FabricNotebook = { cells: [] };
  let current: { kind: string; body: string[] } | undefined;

  const finish = () => {
    if (!current) {
      return;
    }
    const body = withoutSeparators(current.body);
    if (current.kind === 'METADATA') {
      const meta = parseMeta(body);
      const owner = notebook.cells.at(-1);
      if (owner) {
        owner.meta = meta;
      } else {
        notebook.meta = meta;
      }
    } else if (current.kind === 'MARKDOWN') {
      notebook.cells.push({ kind: 'markdown', source: body.map((l) => stripPrefix(l, '#')).join('\n') });
    } else {
      const magic = body.some((l) => l.trim()) && body.every((l) => !l.trim() || isPrefixed(l, '# MAGIC'));
      const source = (magic ? body.map((l) => stripPrefix(l, '# MAGIC')) : body).join('\n');
      notebook.cells.push({
        kind: 'code',
        source,
        ...(current.kind === 'PARAMETERS CELL' ? { parameters: true } : {}),
      });
    }
  };

  for (const line of lines) {
    const marker = MARKER.exec(line);
    if (marker) {
      finish();
      current = { kind: marker[1], body: [] };
    } else if (current) {
      current.body.push(line);
    } else if (line.trim() && line.trim() !== HEADER) {
      throw new NotebookFormatError(`Expected "${HEADER}" and Fabric cell markers, found: ${line.slice(0, 80)}`);
    }
  }
  finish();
  return notebook;
}

export function formatFabricPy(notebook: FabricNotebook): string {
  const blocks: string[] = [HEADER];
  const block = (marker: string, body: string) => blocks.push(`# ${marker} ${STARS}`, body);
  const metaBlock = (meta: JsonObject) =>
    block(
      'METADATA',
      JSON.stringify(meta, undefined, 2)
        .split('\n')
        .map((l) => `# META ${l}`)
        .join('\n'),
    );

  if (notebook.meta && Object.keys(notebook.meta).length) {
    metaBlock(notebook.meta);
  }
  for (const cell of notebook.cells) {
    if (cell.kind === 'markdown') {
      block('MARKDOWN', prefixLines(cell.source, '#'));
      continue;
    }
    const language = cell.meta?.language;
    const magic = typeof language === 'string' && language !== 'python';
    block(cell.parameters ? 'PARAMETERS CELL' : 'CELL', magic ? prefixLines(cell.source, '# MAGIC') : cell.source);
    if (cell.meta && Object.keys(cell.meta).length) {
      metaBlock(cell.meta);
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

/**
 * Returns `next` with its metadata keys in the order `previous` (the current .py) has them,
 * so regenerating the .py from the .ipynb doesn't reorder keys and churn git diffs. Fabric's
 * .ipynb and .py can order the same keys differently (e.g. the lakehouse keys). New keys
 * go after existing ones; values are never changed.
 */
export function withKeyOrderOf(next: FabricNotebook, previous: FabricNotebook | undefined): FabricNotebook {
  if (!previous) {
    return next;
  }
  const unused = new Map<string, FabricCell[]>();
  for (const cell of previous.cells) {
    const key = `${cell.kind}\n${comparable(cell.source)}`;
    unused.set(key, [...(unused.get(key) ?? []), cell]);
  }
  return {
    ...next,
    ...(next.meta ? { meta: orderLike(next.meta, previous.meta) as JsonObject } : {}),
    cells: next.cells.map((cell, i) => {
      if (!cell.meta) {
        return cell;
      }
      // The same cell if unchanged, else the cell in the same position.
      const old = unused.get(`${cell.kind}\n${comparable(cell.source)}`)?.shift() ?? previous.cells[i];
      return { ...cell, meta: orderLike(cell.meta, old?.meta) as JsonObject };
    }),
  };
}

/** `value` without object keys whose value is `null`, at any depth (list items are kept). */
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutNulls);
  }
  if (!isObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, withoutNulls(v)]),
  );
}

function orderLike(value: unknown, template: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v, i) => orderLike(v, Array.isArray(template) ? template[i] : undefined));
  }
  if (!isObject(value) || !isObject(template)) {
    return value;
  }
  const keys = [...Object.keys(template).filter((k) => k in value), ...Object.keys(value).filter((k) => !(k in template))];
  return Object.fromEntries(keys.map((k) => [k, orderLike(value[k], template[k])]));
}

function parseMeta(body: string[]): JsonObject {
  const json = body.map((l) => stripPrefix(l, '# META')).join('\n');
  try {
    const value: unknown = JSON.parse(json);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as JsonObject;
    }
  } catch {
    // Reported below.
  }
  throw new NotebookFormatError(`Invalid "# META" block: ${json.slice(0, 80)}`);
}

/** `# text` -> `text`, `#` -> `` (prefix plus one space, or the bare prefix). */
function stripPrefix(line: string, prefix: string): string {
  if (line.startsWith(`${prefix} `)) {
    return line.slice(prefix.length + 1);
  }
  return line.trimEnd() === prefix ? '' : line;
}

function isPrefixed(line: string, prefix: string): boolean {
  return line.startsWith(`${prefix} `) || line.trimEnd() === prefix;
}

function prefixLines(source: string, prefix: string): string {
  return source
    .split('\n')
    .map((l) => (l ? `${prefix} ${l}` : prefix))
    .join('\n');
}

/**
 * A block's body without the one blank line Fabric writes after its marker and before the
 * next. Further blank lines are part of the cell: a source ending in "\n" is written with an
 * extra blank line (as Fabric does, e.g. its "Welcome to your new notebook" cell).
 */
function withoutSeparators(lines: string[]): string[] {
  const start = lines.length && !lines[0].trim() ? 1 : 0;
  const end = lines.length > start && !lines[lines.length - 1].trim() ? lines.length - 1 : lines.length;
  return lines.slice(start, end);
}

// --- Jupyter (.ipynb) ---

/**
 * The content check for `.ipynb`: a Jupyter notebook (JSON with `nbformat` 4 and a `cells`
 * list) carrying Fabric's `microsoft` metadata, on the notebook or on any cell. Fabric
 * writes it on both (`{"language": "python", "language_group": "jupyter_python"}`);
 * `kernel_info` alone isn't enough, since other tools (e.g. nteract) write it too.
 */
export function isFabricIpynb(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isObject(value) || value.nbformat !== 4 || !Array.isArray(value.cells)) {
    return false;
  }
  return (
    (isObject(value.metadata) && isObject(value.metadata.microsoft)) ||
    value.cells.some((cell: unknown) => isObject(cell) && isObject(cell.metadata) && isObject(cell.metadata.microsoft))
  );
}

/**
 * The `language_group` for a new code cell: the one the notebook's other cells use, else
 * one matching its kernel (`jupyter` for Python notebooks), else Spark.
 * Fabric uses e.g. `synapse_pyspark` (Spark) and `jupyter_python` (Python).
 */
export function defaultLanguageGroup(notebook: FabricNotebook): string {
  const fromCell = notebook.cells.find((c) => typeof c.meta?.language_group === 'string')?.meta?.language_group;
  if (typeof fromCell === 'string') {
    return fromCell;
  }
  const kernel = notebook.meta?.kernel_info;
  return isObject(kernel) && kernel.name === 'jupyter' ? 'jupyter_python' : 'synapse_pyspark';
}

interface IpynbCell {
  cell_type: 'code' | 'markdown' | 'raw';
  id?: string;
  source: string | string[];
  metadata?: JsonObject;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

interface Ipynb {
  nbformat: number;
  nbformat_minor: number;
  metadata: JsonObject;
  cells: IpynbCell[];
  [key: string]: unknown;
}

export function ipynbToFabric(text: string): FabricNotebook {
  const ipynb = parseIpynb(text);
  // Fabric's .ipynb (from the API) can say `"lakehouse": null` where its .py leaves the key
  // out, so null settings are dropped from the .py header.
  const meta = withoutNulls(
    orderLike(
      Object.fromEntries(HEADER_META_KEYS.filter((k) => k in ipynb.metadata).map((k) => [k, ipynb.metadata[k]])),
      FABRIC_PY_HEADER_ORDER,
    ),
  ) as JsonObject;
  return {
    ...(Object.keys(meta).length ? { meta } : {}),
    cells: ipynb.cells.map((cell): FabricCell => {
      const source = joinSource(cell.source);
      if (cell.cell_type === 'markdown') {
        return { kind: 'markdown', source };
      }
      const microsoft = cell.metadata?.microsoft;
      const tags = cell.metadata?.tags;
      return {
        kind: 'code',
        source,
        ...(Array.isArray(tags) && tags.includes('parameters') ? { parameters: true } : {}),
        ...(isObject(microsoft) ? { meta: microsoft } : {}),
      };
    }),
  };
}

/**
 * Builds a `.ipynb` from a Fabric notebook. When `existing` (the current `.ipynb`) is given,
 * its notebook metadata is kept, and so are the outputs and IDs of cells whose source is
 * unchanged, so saving the `.py` doesn't wipe results you ran.
 */
export function fabricToIpynb(notebook: FabricNotebook, existing?: string): string {
  const base: Ipynb = existing
    ? parseIpynb(existing)
    : {
        nbformat: 4,
        nbformat_minor: 5,
        // `microsoft` as Fabric writes it, so the file passes `isFabricIpynb` even with no cells.
        metadata: {
          language_info: { name: 'python' },
          microsoft: { language: 'python', language_group: defaultLanguageGroup(notebook) },
        },
        cells: [],
      };

  // Old cells by type and source, so unchanged cells keep their outputs even if cells move.
  const unused = new Map<string, IpynbCell[]>();
  for (const cell of base.cells) {
    const key = `${cell.cell_type}\n${comparable(joinSource(cell.source))}`;
    unused.set(key, [...(unused.get(key) ?? []), cell]);
  }

  const cells = notebook.cells.map((cell): IpynbCell => {
    const type = cell.kind === 'markdown' ? 'markdown' : 'code';
    const old = unused.get(`${type}\n${comparable(cell.source)}`)?.shift();
    const metadata: JsonObject = { ...(old?.metadata ?? {}) };
    if (type === 'code') {
      if (cell.meta) {
        metadata.microsoft = cell.meta;
      } else {
        delete metadata.microsoft;
      }
      const tags = (Array.isArray(metadata.tags) ? (metadata.tags as unknown[]) : []).filter((t) => t !== 'parameters');
      if (cell.parameters) {
        tags.push('parameters');
      }
      if (tags.length) {
        metadata.tags = tags;
      } else {
        delete metadata.tags;
      }
    }
    const result: IpynbCell = {
      ...(old ?? {}),
      cell_type: type,
      id: old?.id ?? newCellId(),
      metadata,
      // An unchanged cell keeps its source exactly as stored (string or lines).
      source: old && joinSource(old.source) === cell.source ? old.source : splitSource(cell.source),
    };
    if (type === 'code') {
      result.outputs = old?.outputs ?? [];
      result.execution_count = old?.execution_count ?? null;
    }
    return result;
  });

  const metadata = { ...base.metadata };
  for (const key of HEADER_META_KEYS) {
    if (notebook.meta && key in notebook.meta) {
      metadata[key] = notebook.meta[key];
    } else {
      delete metadata[key];
    }
  }
  // Jupyter's own layout: one-space indent, trailing newline.
  return `${JSON.stringify({ ...base, metadata, cells }, undefined, 1)}\n`;
}

function parseIpynb(text: string): Ipynb {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new NotebookFormatError(`Not a valid .ipynb (JSON): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(value) || !Array.isArray(value.cells)) {
    throw new NotebookFormatError('Not a valid .ipynb: no "cells" list.');
  }
  return { ...value, metadata: isObject(value.metadata) ? value.metadata : {} } as Ipynb;
}

/**
 * Source for matching cells between versions: trailing newlines don't count, so a cell whose
 * only change is a trailing newline (e.g. from a hand edit) keeps its outputs and ID.
 */
function comparable(source: string): string {
  return source.replace(/(\r?\n)+$/, '');
}

function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

/** Jupyter stores source as lines, each ending in "\n" except the last. */
function splitSource(source: string): string[] {
  return source ? source.split(/(?<=\n)/) : [];
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function newCellId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}
