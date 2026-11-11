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

import { isObject, type JsonObject } from '../util/json';
import { toLf } from '../util/text';
import type { WarningError } from '../util/errorFix';

export type { JsonObject } from '../util/json';

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

// Git-format files in every notebook language: Python uses `#`, Spark SQL and T-SQL `--`,
// Scala `//`. These match the markers whatever the comment prefix (the parser above is for `.py`).
/** A cell marker line (`CELL`, `MARKDOWN` or `PARAMETERS CELL`), any comment prefix. */
export const ANY_CELL_MARKER = /^(?:#|--|\/\/) (?:CELL|MARKDOWN|PARAMETERS CELL) \*+\s*$/;
/** A `METADATA` marker line, any comment prefix. */
export const ANY_METADATA_MARKER = /^(?:#|--|\/\/) METADATA \*+\s*$/;
/** A `META` line, any comment prefix; group 1 is its JSON text. */
export const ANY_META_LINE = /^(?:#|--|\/\/) META ?(.*)$/;

/** `text` with the comment prefix of every `META` line removed (any language), leaving the JSON. */
export function stripMetaPrefixes(text: string): string {
  return text.replace(/^\s*(?:#|--|\/\/)\s*META ?/gm, '');
}
/**
 * The notebook metadata keys this extension knows in the `.py` header. Only these are kept
 * (in the `.py`, and copied to and from the `.ipynb`); any other header key is dropped.
 * "Test Notebook Formats" reports other keys found in Fabric's exports.
 */
export const HEADER_META_KEYS: readonly string[] = ['kernel_info', 'dependencies'];

/** The Jupyter cell types Fabric notebooks have; others (e.g. `raw`) can't be written to the `.py`. */
export const FABRIC_CELL_TYPES: readonly string[] = ['code', 'markdown'];

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

/** A notebook file whose content can't be read as a notebook: a warning about the user's file (see `WarningError`). */
export class NotebookFormatError extends Error implements WarningError {
  readonly warning = true;

  constructor(message: string) {
    super(message);
    this.name = 'NotebookFormatError';
  }
}

/**
 * An `.ipynb` has cells of types Fabric notebooks don't have (e.g. `raw`), so it can't be
 * written to the `.py`: dropping them would lose their text.
 */
export class NonFabricCellsError extends NotebookFormatError {
  constructor(readonly cellTypes: Readonly<Record<string, number>>) {
    const them = Object.values(cellTypes).reduce((a, b) => a + b, 0) === 1 ? 'it' : 'them';
    super(
      `The .ipynb has ${describeCellTypes(cellTypes)}; Fabric notebooks only have code and markdown cells. ` +
        `Change ${them} to code or markdown, or delete ${them}.`,
    );
    this.name = 'NonFabricCellsError';
  }
}

/** Cell counts by type for a message, e.g. "1 raw cell" or "2 raw cells, 1 heading cell". */
export function describeCellTypes(cellTypes: Readonly<Record<string, number>>): string {
  return Object.entries(cellTypes)
    .map(([type, n]) => `${n} ${type} cell${n === 1 ? '' : 's'}`)
    .join(', ');
}

// --- Fabric Git format (.py) ---

/**
 * The content check for Fabric's Git format: the first non-blank line is
 * `# Fabric notebook source`. An empty file also counts, as a new notebook with no cells.
 * `formatFabricPy` always writes that line, so everything it writes passes this check.
 */
export function isFabricPy(text: string): boolean {
  const first = toLf(text.replace(/^\uFEFF/, '')).split('\n').find((l) => l.trim());
  return first === undefined || first.trimEnd() === HEADER;
}

/** Parses Fabric's Git format. Throws `NotebookFormatError` for anything else (see `isFabricPy`). */
export function parseFabricPy(text: string): FabricNotebook {
  if (!isFabricPy(text)) {
    throw new NotebookFormatError(`Not a Fabric notebook: the first line must be "${HEADER}".`);
  }
  const lines = toLf(text.replace(/^\uFEFF/, '')).split('\n');
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
      // Fabric writes an empty markdown line as "# " (with the space), unlike other prefixes,
      // except the one after a final newline, which it leaves blank as in code cells.
      const lines = prefixLines(cell.source, '#', '# ').split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '# ') {
        lines[lines.length - 1] = '';
      }
      block('MARKDOWN', lines.join('\n'));
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

/** The notebook's header keys that aren't in `HEADER_META_KEYS`. */
export function unknownHeaderKeys(notebook: FabricNotebook): string[] {
  return Object.keys(notebook.meta ?? {}).filter((k) => !HEADER_META_KEYS.includes(k));
}

/** `notebook` with only the header keys in `HEADER_META_KEYS` (the notebook itself if it has no others). */
export function withKnownHeaderKeys(notebook: FabricNotebook): FabricNotebook {
  if (!notebook.meta || !unknownHeaderKeys(notebook).length) {
    return notebook;
  }
  const meta = Object.fromEntries(Object.entries(notebook.meta).filter(([k]) => HEADER_META_KEYS.includes(k)));
  return Object.keys(meta).length ? { ...notebook, meta } : { cells: notebook.cells };
}

/**
 * A `.py` with only known header keys: the text itself when it has no others, else
 * rewritten without them. `dropped` names the keys removed. Throws `NotebookFormatError`
 * if it isn't a Fabric notebook.
 */
export function dropUnknownHeaderKeys(py: string): { py: string; dropped: string[] } {
  const notebook = parseFabricPy(py);
  const dropped = unknownHeaderKeys(notebook);
  return dropped.length ? { py: formatFabricPy(withKnownHeaderKeys(notebook)), dropped } : { py, dropped };
}

/**
 * The cell types in an `.ipynb` that Fabric notebooks don't have (see `FABRIC_CELL_TYPES`),
 * with how many cells of each, e.g. `{ raw: 2 }`. Throws `NotebookFormatError` if it isn't an `.ipynb`.
 */
export function unknownCellTypes(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const cell of parseIpynb(text).cells as unknown[]) {
    const type = isObject(cell) && typeof cell.cell_type === 'string' ? cell.cell_type : '(none)';
    if (!FABRIC_CELL_TYPES.includes(type)) {
      counts[type] = (counts[type] ?? 0) + 1;
    }
  }
  return counts;
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

const DEFAULT_LAKEHOUSE_KEYS = ['default_lakehouse', 'default_lakehouse_name', 'default_lakehouse_workspace_id'];

/**
 * `meta` with `default_lakehouse_name` and `default_lakehouse_workspace_id` set to `""` when
 * its lakehouse settings have none of the default lakehouse's, as Fabric's .py has them where its .ipynb
 * leaves both out (a notebook with lakehouses attached but no default).
 */
function withEmptyDefaultLakehouse(meta: JsonObject): JsonObject {
  const dependencies = meta.dependencies;
  const lakehouse = isObject(dependencies) ? dependencies.lakehouse : undefined;
  if (!isObject(dependencies) || !isObject(lakehouse) || DEFAULT_LAKEHOUSE_KEYS.some((k) => k in lakehouse)) {
    return meta;
  }
  return {
    ...meta,
    dependencies: {
      ...dependencies,
      lakehouse: { default_lakehouse_name: '', default_lakehouse_workspace_id: '', ...lakehouse },
    },
  };
}

/**
 * The reverse of `withEmptyDefaultLakehouse`, for the .ipynb: the two `""` settings left out,
 * unless `previous` (the .ipynb being rewritten) has either. Fabric's .ipynb has both forms
 * (`""` kept, with `"default_lakehouse": null`, e.g. once a default was removed), which the
 * .py can't tell apart, so an existing .ipynb's form is kept.
 */
function withoutEmptyDefaultLakehouse(meta: JsonObject, previous: JsonObject): JsonObject {
  const dependencies = meta.dependencies;
  const lakehouse = isObject(dependencies) ? dependencies.lakehouse : undefined;
  const previousDependencies = previous.dependencies;
  const previousLakehouse = isObject(previousDependencies) ? previousDependencies.lakehouse : undefined;
  if (
    !isObject(dependencies) ||
    !isObject(lakehouse) ||
    (isObject(previousLakehouse) && DEFAULT_LAKEHOUSE_KEYS.some((k) => k in previousLakehouse)) ||
    'default_lakehouse' in lakehouse ||
    lakehouse.default_lakehouse_name !== '' ||
    lakehouse.default_lakehouse_workspace_id !== ''
  ) {
    return meta;
  }
  const rest = { ...lakehouse };
  delete rest.default_lakehouse_name;
  delete rest.default_lakehouse_workspace_id;
  return { ...meta, dependencies: { ...dependencies, lakehouse: rest } };
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

/** Prefixes each line with `prefix` and a space; an empty line becomes `empty` (by default the bare prefix). */
function prefixLines(source: string, prefix: string, empty = prefix): string {
  return source
    .split('\n')
    .map((l) => (l ? `${prefix} ${l}` : empty))
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

/**
 * The Fabric notebook in an `.ipynb`. Throws `NotebookFormatError` if it has cells of a type
 * Fabric notebooks don't have (e.g. `raw`): they can't be written to the `.py`, and dropping
 * them would lose their text.
 */
export function ipynbToFabric(text: string): FabricNotebook {
  const ipynb = parseIpynb(text);
  const unknown = unknownCellTypes(text);
  if (Object.keys(unknown).length) {
    throw new NonFabricCellsError(unknown);
  }
  // Fabric's .ipynb (from the API) can say `"lakehouse": null` where its .py leaves the key
  // out, so null settings are dropped from the .py header.
  const meta = orderLike(
    withEmptyDefaultLakehouse(
      withoutNulls(Object.fromEntries(HEADER_META_KEYS.filter((k) => k in ipynb.metadata).map((k) => [k, ipynb.metadata[k]]))) as JsonObject,
    ),
    FABRIC_PY_HEADER_ORDER,
  ) as JsonObject;
  return {
    ...(Object.keys(meta).length ? { meta } : {}),
    cells: ipynb.cells.map((cell): FabricCell => {
      // Sources written on Windows may use CRLF; the .py's lines are processed as LF.
      const source = toLf(joinSource(cell.source));
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
      // A kept cell keeps its ID as it is, even none (Fabric's .ipynb can leave it out).
      ...(old ? {} : usesCellIds(base) ? { id: newCellId() } : {}),
      metadata,
      // An unchanged cell keeps its source exactly as stored (string or lines).
      source: old && joinSource(old.source) === cell.source ? old.source : splitSource(cell.source),
    };
    // A kept cell keeps these as they are, even left out (as Fabric's .ipynb can).
    if (type === 'code' && !old) {
      result.outputs = [];
      result.execution_count = null;
    }
    return result;
  });

  const metadata = { ...base.metadata };
  const meta = notebook.meta && withoutEmptyDefaultLakehouse(notebook.meta, base.metadata);
  for (const key of HEADER_META_KEYS) {
    if (meta && key in meta) {
      metadata[key] = meta[key];
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
 * Source for matching cells between versions: line endings and trailing newlines don't
 * count, so a cell whose only change is one of those (e.g. from a hand edit, or Windows
 * line endings) keeps its outputs and ID.
 */
function comparable(source: string): string {
  return toLf(source).replace(/\n+$/, '');
}

function joinSource(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source;
}

/** Jupyter stores source as lines, each ending in "\n" except the last. */
function splitSource(source: string): string[] {
  return source ? source.split(/(?<=\n)/) : [];
}

/** Cell IDs are part of nbformat 4.5 and later; older versions don't allow them. */
function usesCellIds(ipynb: Ipynb): boolean {
  return ipynb.nbformat > 4 || (ipynb.nbformat === 4 && ipynb.nbformat_minor >= 5);
}

function newCellId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}
