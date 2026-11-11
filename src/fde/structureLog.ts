/**
 * Obscuring Fabric Data Engineering (FDE) work folder contents for "Log Fabric Data Engineering
 * Structure", so the log can be shared: IDs (including numeric ones), names, emails and free
 * text are replaced, while
 * the structure (folders, files, JSON keys, value types, date formats) is kept. No `vscode`
 * dependency.
 *
 * The same ID or name always gets the same placeholder within one log, so relationships
 * (e.g. a folder named after an item ID that `.artifact-info` also holds) stay visible.
 */

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const WHOLE_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** Folder and file names that are part of FDE's structure, not the user's: kept as they are. */
const STRUCTURE_NAMES = new Set([
  'SynapseNotebook',
  'SparkJobDefinition',
  'Lakehouse',
  'Environment',
  'conf',
  'resource',
  'builtin',
  'update',
  'lmUpdate',
  'log',
  'debug',
  'lighter-config.json',
  'sparkconf.py',
]);

/** JSON keys whose string values are kinds or formats, not user data: kept as they are. */
const SAFE_KEYS = new Set([
  'artifactType',
  'type',
  'kind',
  'language',
  'language_group',
  'auth',
  'platform',
  'format',
  'status',
  'cell_type',
  'mimetype',
  'file_extension',
  'pygments_lexer',
  'nbconvert_exporter',
  'codemirror_mode',
  'output_type',
  'provisionState',
  'systemArtifactType',
  'capacitySku',
  'jupyter_kernel_name',
  'ms_spell_check_language',
]);

/** String values that are kernel or language names: kept wherever they appear. */
const SAFE_VALUES = new Set([
  'synapse_pyspark',
  'jupyter_python',
  'python',
  'python3',
  'pyspark',
  'sparksql',
  'spark',
  'sparkr',
  'scala',
  'Synapse PySpark',
  'Python 3',
  'PySpark',
  'Jupyter Python',
  'jupyter',
  '/trident/default',
  'SynapseNotebook',
  'Workspace',
  'User',
  'RefreshToken',
  'DeviceCode',
  'data-cloud',
  'ipynb',
]);

/** Gives IDs, names and emails stable placeholders (`<id-1>`, `<name-1>`, `<email-1>`). */
export class Obscurer {
  private readonly maps = {
    id: new Map<string, string>(),
    name: new Map<string, string>(),
    email: new Map<string, string>(),
    number: new Map<string, string>(),
  };

  private placeholder(kind: 'id' | 'name' | 'email' | 'number', key: string): string {
    const map = this.maps[kind];
    let value = map.get(key);
    if (!value) {
      value = `<${kind}-${map.size + 1}>`;
      map.set(key, value);
    }
    return value;
  }

  /** A GUID's placeholder; the all-zero GUID (e.g. the starter pool) is kept. */
  id(guid: string): string {
    return guid === ZERO_GUID ? guid : this.placeholder('id', guid.toLowerCase());
  }

  /** Replaces every GUID and email inside `text`. */
  ids(text: string): string {
    return text.replace(EMAIL, (e) => this.placeholder('email', e.toLowerCase())).replace(GUID, (g) => this.id(g));
  }

  /** A folder or file name: structure names and dot-files kept, GUIDs as IDs, other names as `<name-N>` (extension kept). */
  pathSegment(segment: string): string {
    if (STRUCTURE_NAMES.has(segment) || /^\.[\w-]+$/.test(segment)) {
      return segment;
    }
    if (WHOLE_GUID.test(segment)) {
      return this.id(segment);
    }
    const dot = segment.lastIndexOf('.');
    const [base, extension] = dot > 0 ? [segment.slice(0, dot), segment.slice(dot)] : [segment, ''];
    return `${WHOLE_GUID.test(base) ? this.id(base) : this.placeholder('name', base)}${extension}`;
  }

  /**
   * A JSON number, under `key`: kept, unless the key names an ID (`id`, `ownerUserId`...),
   * since numeric IDs (e.g. a user's) identify people too.
   */
  number(key: string | undefined, value: number): number | string {
    return key !== undefined && /id$/i.test(key) ? this.placeholder('number', String(value)) : value;
  }

  /** A JSON string value, under `key`. */
  string(key: string | undefined, value: string): string {
    if (value === '' || SAFE_VALUES.has(value) || (key !== undefined && SAFE_KEYS.has(key) && /^[\w .-]{1,40}$/.test(value))) {
      return value;
    }
    if (WHOLE_GUID.test(value)) {
      return this.id(value);
    }
    if (ISO_DATE.test(value)) {
      return value.replace(/\d/g, 'd'); // The format, which matters, without the date.
    }
    return `<text, ${value.length} chars>`;
  }
}

/** A JSON value with every string obscured (see `Obscurer.string`), and keys that are IDs or emails replaced. */
export function obscureJson(value: unknown, obscurer: Obscurer, key?: string): unknown {
  if (typeof value === 'string') {
    return obscurer.string(key, value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => obscureJson(v, obscurer, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [obscurer.ids(k), obscureJson(v, obscurer, k)]));
  }
  if (typeof value === 'number') {
    return obscurer.number(key, value);
  }
  return value; // Booleans and null.
}

/**
 * A notebook's shape without its content: its metadata (obscured), how many cells of each
 * type, and the first cell's metadata (obscured). Cell sources and outputs are left out.
 */
export function summarizeIpynb(notebook: unknown, obscurer: Obscurer): unknown {
  if (!notebook || typeof notebook !== 'object') {
    return '<not a JSON object>';
  }
  const { cells, metadata, ...rest } = notebook as { cells?: unknown; metadata?: unknown };
  const list = Array.isArray(cells) ? (cells as { cell_type?: unknown; metadata?: unknown }[]) : [];
  const cellTypes: Record<string, number> = {};
  for (const cell of list) {
    const type = typeof cell?.cell_type === 'string' ? cell.cell_type : '<none>';
    cellTypes[type] = (cellTypes[type] ?? 0) + 1;
  }
  return {
    ...(obscureJson(rest, obscurer) as object),
    metadata: obscureJson(metadata, obscurer),
    cells: { count: list.length, types: cellTypes, firstCellMetadata: obscureJson(list[0]?.metadata, obscurer) },
  };
}
