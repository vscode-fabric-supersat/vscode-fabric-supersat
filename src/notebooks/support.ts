/**
 * Which notebooks the extension supports, from their files: the notebook's language (as
 * opposed to its cells' languages) and why it isn't supported, if it isn't. No `vscode`
 * dependency, so it can be unit-tested offline.
 */
import { formatFabricPy, ipynbToFabric, stripMetaPrefixes } from './format';

/**
 * Notebook languages, as opposed to cell languages. Only PySpark and Python notebooks are
 * supported; SQL cells inside them are (Spark SQL `%%sql` in PySpark, T-SQL `%%tsql` in Python).
 *
 * - **Spark SQL** notebooks run Spark SQL on a Spark cluster, and Fabric stores them as
 *   `notebook-content.sql` (documented, like `.scala` for Scala and `.r` for SparkR).
 * - **T-SQL** notebooks run T-SQL on a warehouse or SQL analytics endpoint. Their kernel is
 *   `sqldatawarehouse` (seen in a real export, 2026-11); Microsoft doesn't document which
 *   Git-format file Fabric stores them in, so they are recognised by that kernel instead.
 */
const TSQL_NOTEBOOK = {
  label: 'T-SQL',
  runs: 'T-SQL on a warehouse or SQL analytics endpoint',
  cells: 'T-SQL cells (%%tsql) in a Python notebook are supported.',
};

const UNSUPPORTED_BY_EXTENSION: Record<string, { label: string; runs: string; cells: string }> = {
  sql: {
    label: 'Spark SQL',
    runs: 'Spark SQL on a Spark cluster',
    cells: 'Spark SQL cells (%%sql) in a PySpark notebook are supported.',
  },
  scala: { label: 'Scala', runs: 'Scala on a Spark cluster', cells: '' },
  r: { label: 'SparkR', runs: 'R on a Spark cluster', cells: '' },
} as const;

/** Supported notebooks' language as an .ipynb names it (`microsoft.language`, else `language_info.name`). */
const IPYNB_LANGUAGES: Record<string, string> = { sparksql: 'Spark SQL', sql: 'Spark SQL', scala: 'Scala', r: 'SparkR' };

/**
 * The notebook language an `.ipynb` export declares: T-SQL (its kernel), PySpark or
 * Python (Python code, on the Spark or Jupyter kernel), Spark SQL, Scala, SparkR, or the
 * declared name if it's something else.
 */
export function ipynbLanguage(text: string): string {
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as { metadata?: Record<string, unknown> };
    metadata = parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {};
  } catch {
    // Not JSON: the caller's format checks report it.
  }
  const field = (owner: unknown, key: string) =>
    owner && typeof owner === 'object' && typeof (owner as Record<string, unknown>)[key] === 'string'
      ? ((owner as Record<string, unknown>)[key] as string)
      : undefined;
  const kernel = field(metadata.kernel_info, 'name');
  if (kernel === 'sqldatawarehouse') {
    return 'T-SQL';
  }
  const language = (field(metadata.microsoft, 'language') ?? field(metadata.language_info, 'name'))?.toLowerCase();
  if (language === undefined || language === 'python') {
    return kernel === 'jupyter' ? 'Python' : 'PySpark';
  }
  return IPYNB_LANGUAGES[language] ?? language;
}

/** Why a notebook can't be downloaded, from its `.ipynb` export, or `undefined` if it's a PySpark or Python notebook. */
export function unsupportedIpynb(name: string, text: string): string | undefined {
  const language = ipynbLanguage(text);
  if (language === 'PySpark' || language === 'Python') {
    return undefined;
  }
  const kind = language === 'T-SQL' ? TSQL_NOTEBOOK : Object.values(UNSUPPORTED_BY_EXTENSION).find((k) => k.label === language);
  return kind
    ? unsupportedMessage(name, kind)
    : `"${name}" is a ${language} notebook. Only PySpark and Python notebooks are supported.`;
}

/** The `.py` (Fabric's Git format) for an `.ipynb` export, as download writes it. */
export function pyFromIpynb(text: string): string {
  return formatFabricPy(ipynbToFabric(text));
}

function unsupportedMessage(name: string, kind: { label: string; runs: string; cells: string }, path?: string): string {
  return (
    `"${name}" is a ${kind.label} notebook (${path ? `${path}; ` : ''}it runs ${kind.runs}). ${kind.label} notebooks aren't supported yet, ` +
    `only PySpark and Python notebooks. ${kind.cells}`
  ).trimEnd();
}

/** A T-SQL notebook's kernel, in a Git-format header (any comment prefix) or an .ipynb. */
const TSQL_KERNEL = /"kernel_info"\s*:\s*\{[^}]*"name"\s*:\s*"sqldatawarehouse"/;

/** Whether a notebook file (Git format, or .ipynb) is a T-SQL notebook. */
export function isTsqlNotebook(text: string): boolean {
  // Git-format header lines are prefixed per language (`# META`, `-- META`): drop the prefixes.
  return TSQL_KERNEL.test(stripMetaPrefixes(text));
}

/**
 * Why a notebook can't be downloaded or uploaded, from one of its Git-format files
 * (`notebook-content.<ext>`), or `undefined` if it's a PySpark or Python notebook.
 * `tsql` says it is already known to be a T-SQL notebook (from its .ipynb export).
 */
export function unsupportedNotebook(name: string, path: string, text: string, tsql = false): string | undefined {
  const extension = path.split('.').pop()!.toLowerCase();
  const kind = tsql || isTsqlNotebook(text) ? TSQL_NOTEBOOK : UNSUPPORTED_BY_EXTENSION[extension];
  return kind && unsupportedMessage(name, kind, path);
}

