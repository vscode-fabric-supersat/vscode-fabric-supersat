/**
 * "Test Notebook Formats": checks the extension's format handling against every notebook
 * in a workspace, as Fabric really exports them, without writing anything to `src/`.
 * For each notebook, both Fabric exports (Git-format `notebook-content.*` and `.ipynb`) are
 * checked:
 *
 * 1. Reading and rewriting Fabric's `.py` gives back exactly the same text.
 * 2. The `.py` generated from Fabric's `.ipynb` is identical to Fabric's `.py`.
 * 3. The `.ipynb` generated from Fabric's `.py` (what download writes, here keeping Fabric's
 *    outputs as a local `.ipynb`'s are kept) matches Fabric's `.ipynb`.
 * 4. Both exports agree on whether the notebook is supported (download decides from the `.py`).
 * 5. Uploading it back to its own workspace leaves its lakehouse and environment IDs alone.
 * 6. It has only the header keys and cell types the extension knows; others are dropped
 *    (header keys) or refused (cell types) in normal use, so they are reported here.
 *
 * No `vscode` dependency, so it can be unit-tested offline.
 */
import { fabricToIpynb, formatFabricPy, HEADER_META_KEYS, parseFabricPy, unknownCellTypes, unknownHeaderKeys } from './format';
import { fence, mdText } from '../util/markdown';
import type { ReferenceMapper } from './references';
import { type RemoteNotebook, summarizeNotebook } from './remote';
import { ipynbLanguage, isTsqlNotebook, pyFromIpynb, unsupportedIpynb, unsupportedNotebook } from './support';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface FormatCheck {
  id: 'pyRoundTrip' | 'pyFromIpynb' | 'ipynbFromPy' | 'supported' | 'references' | 'knownContent';
  status: CheckStatus;
  detail?: string;
}

export interface NotebookFormatResult {
  name: string;
  gitPath?: string;
  language?: string;
  checks: FormatCheck[];
  /** Why the notebook couldn't be fetched (no checks then). */
  error?: string;
  /** Not checked because the run was cancelled first: not a failure. */
  cancelled?: true;
}

export const CHECK_TITLES: Record<FormatCheck['id'], string> = {
  pyRoundTrip: '.py read and rewritten unchanged',
  pyFromIpynb: '.py generated from .ipynb matches Fabric’s .py',
  ipynbFromPy: '.ipynb generated from .py (as download writes it) matches Fabric’s .ipynb',
  supported: 'Both exports agree on whether it’s supported',
  references: 'Uploading to its own workspace keeps its IDs',
  knownContent: 'Only known header keys and cell types',
};

/** Runs the checks on one fetched notebook. `references` (pointed at its own workspace) enables check 5. */
export async function checkNotebookFormats(remote: RemoteNotebook, references?: ReferenceMapper): Promise<NotebookFormatResult> {
  const name = remote.notebook.displayName;
  if (remote.cancelled) {
    return { name, checks: [], error: remote.error, cancelled: true };
  }
  if (remote.error || remote.gitText === undefined || !remote.gitPath) {
    return { name, checks: [], error: remote.error ?? 'Fabric returned no Git-format file.' };
  }
  const { gitPath, gitText, ipynbText } = remote;
  const result: NotebookFormatResult = { name, gitPath, language: summarizeNotebook(gitPath, gitText).language, checks: [] };
  const check = (id: FormatCheck['id'], run: () => Omit<FormatCheck, 'id'>) => {
    try {
      result.checks.push({ id, ...run() });
    } catch (err) {
      result.checks.push({ id, status: 'fail', detail: `Threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  };

  const unsupported = unsupportedNotebook(name, gitPath, gitText);
  const ipynbTsql = ipynbText !== undefined && isTsqlNotebook(ipynbText);
  const ipynbUnsupported = ipynbText === undefined ? undefined : unsupportedIpynb(name, ipynbText);
  check('supported', () => {
    if (ipynbText === undefined) {
      return { status: 'skip', detail: 'No .ipynb export.' };
    }
    const gitTsql = isTsqlNotebook(gitText);
    if (gitTsql !== ipynbTsql) {
      return {
        status: 'fail',
        detail: `The Git-format file says ${gitTsql ? '' : 'not '}T-SQL; the .ipynb says ${ipynbTsql ? '' : 'not '}T-SQL. Download decides from the Git-format file.`,
      };
    }
    if (!unsupported !== !ipynbUnsupported) {
      return {
        status: 'fail',
        detail:
          `From ${gitPath}: ${unsupported ?? 'supported'}\nFrom the .ipynb (${ipynbLanguage(ipynbText)}): ${ipynbUnsupported ?? 'supported'}\n` +
          'Download decides from the Git-format file.',
      };
    }
    return { status: 'pass', detail: unsupported ? `Not supported: ${unsupported}` : undefined };
  });
  if (unsupported || ipynbUnsupported) {
    const why = `Skipped: ${unsupported ?? ipynbUnsupported} (not supported).`;
    for (const id of ['pyRoundTrip', 'pyFromIpynb', 'ipynbFromPy', 'references', 'knownContent'] as const) {
      result.checks.push({ id, status: 'skip', detail: why });
    }
    return result;
  }

  check('pyRoundTrip', () => {
    const rewritten = formatFabricPy(parseFabricPy(gitText));
    return rewritten === gitText ? { status: 'pass' } : { status: 'fail', detail: firstDifference(gitText, rewritten, 'Fabric', 'rewritten') };
  });
  check('pyFromIpynb', () => {
    if (ipynbText === undefined) {
      return { status: 'skip', detail: 'No .ipynb export.' };
    }
    const generated = pyFromIpynb(ipynbText);
    return generated === gitText ? { status: 'pass' } : { status: 'fail', detail: firstDifference(gitText, generated, 'Fabric', 'generated') };
  });
  check('ipynbFromPy', () => {
    if (ipynbText === undefined) {
      return { status: 'skip', detail: 'No .ipynb export.' };
    }
    const generated: unknown = JSON.parse(fabricToIpynb(parseFabricPy(gitText), ipynbText));
    const difference = firstJsonDifference(JSON.parse(ipynbText), generated);
    return difference ? { status: 'fail', detail: difference } : { status: 'pass' };
  });
  if (references) {
    try {
      const retargeted = await references.retarget(gitText);
      result.checks.push(
        retargeted.py === gitText
          ? { id: 'references', status: 'pass' }
          : {
              id: 'references',
              status: 'warn',
              detail: `Uploading it here would change: ${retargeted.replaced.join('; ') || 'workspace IDs'}. Usually it refers to items in another workspace.`,
            },
      );
    } catch (err) {
      result.checks.push({ id: 'references', status: 'fail', detail: `Threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  } else {
    result.checks.push({ id: 'references', status: 'skip', detail: 'Uploads keep IDs (notebooks.upload settings are "keep").' });
  }
  check('knownContent', () => {
    const problems: string[] = [];
    const keys = unknownHeaderKeys(parseFabricPy(gitText));
    if (keys.length) {
      problems.push(
        `Header keys in ${gitPath} that aren't known (${HEADER_META_KEYS.join(', ')} are): ${keys.join(', ')}. ` +
          'Download, upload and editing leave them out.',
      );
    }
    const types = Object.entries(ipynbText === undefined ? {} : unknownCellTypes(ipynbText));
    if (types.length) {
      problems.push(
        `Cell types in the .ipynb that Fabric notebooks aren't known to have (code and markdown are): ` +
          `${types.map(([type, n]) => `${type} (${n})`).join(', ')}. Syncing an .ipynb with them to the .py is refused.`,
      );
    }
    return problems.length ? { status: 'warn', detail: problems.join('\n') } : { status: 'pass' };
  });
  return result;
}

/** Whether a notebook's results include a failure (its sample files are saved then). */
export function hasFailure(result: NotebookFormatResult): boolean {
  return !result.cancelled && (!!result.error || result.checks.some((c) => c.status === 'fail'));
}

/**
 * Replaces every GUID in the texts with numbered placeholders, consistently (the same ID
 * gets the same placeholder in every text), so samples can be shared as test fixtures.
 * The all-zeros ID is kept. Names, code and outputs are not changed.
 */
export function replaceIds(texts: readonly string[]): string[] {
  const placeholders = new Map<string, string>();
  return texts.map((text) =>
    text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (id) => {
      const key = id.toLowerCase();
      if (key === '00000000-0000-0000-0000-000000000000') {
        return id;
      }
      let placeholder = placeholders.get(key);
      if (!placeholder) {
        placeholder = `00000000-0000-0000-0000-${String(placeholders.size + 1).padStart(12, '0')}`;
        placeholders.set(key, placeholder);
      }
      return placeholder;
    }),
  );
}

/** The report as Markdown: a summary, a table of every notebook's checks, then each failure. */
export function renderFormatReport(workspace: string, time: string, results: readonly NotebookFormatResult[]): string {
  const icon: Record<CheckStatus, string> = { pass: '✅', fail: '❌', warn: '⚠️', skip: '–' };
  const failing = results.filter(hasFailure);
  const warned = results.filter((r) => !hasFailure(r) && r.checks.some((c) => c.status === 'warn'));
  const cancelled = results.filter((r) => r.cancelled);
  const ids = Object.keys(CHECK_TITLES) as FormatCheck['id'][];
  const out: string[] = [
    `# Notebook format test: ${mdText(workspace)}`,
    '',
    `Run ${mdText(time)} by "Test Notebook Formats". Both Fabric exports of each notebook were checked locally; nothing in src/ was changed.`,
    '',
    '## Summary',
    '',
    `- Notebooks: ${results.length}`,
    `- All checks passed: ${results.length - failing.length - warned.length - cancelled.length}`,
    `- With warnings: ${warned.length}`,
    `- With failures: ${failing.length}`,
    ...(cancelled.length ? [`- Not checked (cancelled): ${cancelled.length}`] : []),
    '',
    ...(cancelled.length
      ? [
          `**The run was cancelled**: ${cancelled.length} of ${results.length} notebooks weren't checked. The samples from the previous run were kept; run the test again for a complete report.`,
          '',
        ]
      : []),
    failing.length
      ? cancelled.length
        ? 'Failing notebooks are listed below; their sample files are saved only by a complete run.'
        : 'Sample files for each failing notebook are in `samples/`, with IDs replaced by placeholders. Review them before sharing: names, code and cell outputs are kept as they are.'
      : cancelled.length
        ? 'No failures among the notebooks checked.'
        : 'No failures: the extension handles every notebook in this workspace as Fabric exports it.',
    '',
    'Checks:',
    '',
    ...ids.map((id, i) => `${i + 1}. ${CHECK_TITLES[id]}`),
    '',
    '## Results',
    '',
    `| Notebook | Language | ${ids.map((_, i) => String(i + 1)).join(' | ')} |`,
    `| --- | --- | ${ids.map(() => '---').join(' | ')} |`,
    ...results.map(
      (r) =>
        `| ${mdText(r.name)} | ${r.language ? mdText(r.language) : r.cancelled ? '– cancelled' : r.error ? '❌ not fetched' : ''} | ${ids
          .map((id) => icon[r.checks.find((c) => c.id === id)?.status ?? 'skip'])
          .join(' | ')} |`,
    ),
    '',
  ];
  const details = results.filter((r) => !r.cancelled && (r.error || r.checks.some((c) => c.status === 'fail' || c.status === 'warn')));
  if (details.length) {
    out.push('## Details', '');
    for (const r of details) {
      out.push(`### ${mdText(r.name)}`, '');
      if (r.error) {
        out.push(`Not fetched: ${mdText(r.error)}`, '');
      }
      for (const c of r.checks.filter((c) => c.status === 'fail' || c.status === 'warn')) {
        // Details quote notebook lines, which may contain backticks: the fence is longer than any of them.
        out.push(`${icon[c.status]} **${CHECK_TITLES[c.id]}**`, '', ...fence(c.detail ?? ''), '');
      }
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** The first line where two texts differ, with a little context from each. */
export function firstDifference(expected: string, actual: string, expectedLabel: string, actualLabel: string): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  const show = (lines: string[]) =>
    lines
      .slice(Math.max(0, i - 2), i + 3)
      .map((l, k) => `${Math.max(0, i - 2) + k + 1}: ${l.length > 200 ? `${l.slice(0, 200)}…` : l}`)
      .join('\n');
  return `First difference at line ${i + 1} (${a.length} lines in ${expectedLabel}, ${b.length} in ${actualLabel}).\n--- ${expectedLabel}\n${show(a)}\n--- ${actualLabel}\n${show(b)}`;
}

/**
 * Paths where a key set to `null` counts as the key being left out: the `.py` header keys.
 * Fabric's `.ipynb` can say `"lakehouse": null` where its own `.py` leaves the key out, and
 * the `.py` drops null settings the same way, so the `.ipynb` generated from it can't have them.
 */
const NULL_IS_MISSING = HEADER_META_KEYS.map((key) => `$.metadata.${key}`);

const nullMeansMissing = (path: string) => NULL_IS_MISSING.some((p) => path === p || path.startsWith(`${p}.`));

/** The first path where two JSON values differ, or `undefined` if they're equal. */
export function firstJsonDifference(expected: unknown, actual: unknown, path = '$'): string | undefined {
  if (expected === actual || ((expected ?? null) === null && (actual ?? null) === null && nullMeansMissing(path))) {
    return undefined;
  }
  const describe = (v: unknown) => {
    const text = JSON.stringify(v);
    return text === undefined ? 'missing' : text.length > 200 ? `${text.slice(0, 200)}…` : text;
  };
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      const d = firstJsonDifference(expected[i], actual[i], `${path}[${i}]`);
      if (d) {
        return d;
      }
    }
    return undefined;
  }
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object' && !Array.isArray(expected) && !Array.isArray(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
      const d = firstJsonDifference((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key], `${path}.${key}`);
      if (d) {
        return d;
      }
    }
    return undefined;
  }
  return `${path}: Fabric has ${describe(expected)}, generated has ${describe(actual)}`;
}
