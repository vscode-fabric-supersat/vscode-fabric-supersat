import * as vscode from 'vscode';
import {
  defaultLanguageGroup,
  type FabricCell,
  type FabricNotebook,
  formatFabricPy,
  type JsonObject,
  NotebookFormatError,
  parseFabricPy,
} from './format';

/** Notebook type for Fabric's Git format; matches `contributes.notebooks` in package.json. */
export const FABRIC_NOTEBOOK_TYPE = 'fabric-supersat-notebook';

/** Fabric cell languages and the VS Code language IDs used to edit them. */
const LANGUAGES: readonly (readonly [fabric: string, vscode: string])[] = [
  ['python', 'python'],
  ['sparksql', 'sql'], // Spark SQL (%%sql) in Spark notebooks
  ['sql', 'sql'], // T-SQL (%%tsql) in Python notebooks
  ['scala', 'scala'],
  ['r', 'r'],
  ['sparkr', 'r'],
  ['csharp', 'csharp'],
];

const toVscodeLanguage = (fabric: unknown) => LANGUAGES.find(([f]) => f === fabric)?.[1] ?? 'python';
/** The Fabric language for a cell's VS Code language. SQL depends on the notebook: T-SQL in Python notebooks. */
const toFabricLanguage = (languageId: string, group: string) =>
  languageId === 'sql' && group === 'jupyter_python'
    ? 'sql'
    : (LANGUAGES.find(([, v]) => v === languageId)?.[0] ?? 'python');

/**
 * Opens `src/Notebooks/<Name>/<Name>.py` (Fabric's Git format) in the notebook editor.
 * VS Code picks notebook editors by file name only, so the type is registered for `*.py`
 * as an option, and `configurationDefaults` in package.json makes it the default editor for
 * `.py` files directly in `src/Notebooks/<Name>/` (editor associations match by path).
 *
 * The file has no outputs, so outputs are never saved to it. Fabric's metadata is carried
 * in the notebook and cell metadata so a save writes it back unchanged.
 */
export class FabricNotebookSerializer implements vscode.NotebookSerializer {
  deserializeNotebook(content: Uint8Array): vscode.NotebookData {
    let notebook;
    try {
      notebook = parseFabricPy(new TextDecoder().decode(content));
    } catch (err) {
      throw err instanceof NotebookFormatError
        ? new NotebookFormatError(
            `${err.message} Use "Reopen Editor With… → Text Editor" to open it as plain text. ` +
              'Only the notebook belongs at this path.',
          )
        : err;
    }
    const data = new vscode.NotebookData(
      notebook.cells.map((cell) => {
        const isCode = cell.kind === 'code';
        const item = new vscode.NotebookCellData(
          isCode ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup,
          cell.source,
          isCode ? toVscodeLanguage(cell.meta?.language) : 'markdown',
        );
        item.metadata = { fabric: cell.meta, parameters: cell.parameters };
        return item;
      }),
    );
    data.metadata = { fabric: notebook.meta };
    return data;
  }

  serializeNotebook(data: vscode.NotebookData): Uint8Array {
    const notebookMeta = data.metadata?.fabric as JsonObject | undefined;
    // New cells join the notebook's language group (e.g. jupyter_python in a Python notebook).
    const group = defaultLanguageGroup({
      meta: notebookMeta,
      cells: data.cells.map((c): FabricCell => ({ kind: 'code', source: '', meta: c.metadata?.fabric as JsonObject })),
    } satisfies FabricNotebook);
    const cells = data.cells.map((cell): FabricCell => {
      if (cell.kind === vscode.NotebookCellKind.Markup) {
        return { kind: 'markdown', source: cell.value };
      }
      const meta = cell.metadata?.fabric as JsonObject | undefined;
      // Keep Fabric's language unless the cell was switched to another one in the editor
      // (or is new), so e.g. `sparkr` isn't rewritten as `r`.
      const language =
        meta && toVscodeLanguage(meta.language) === cell.languageId
          ? meta.language
          : toFabricLanguage(cell.languageId, typeof meta?.language_group === 'string' ? meta.language_group : group);
      return {
        kind: 'code',
        source: cell.value,
        ...(cell.metadata?.parameters ? { parameters: true } : {}),
        // Existing metadata keeps its key order (so saving doesn't churn git diffs).
        meta: meta ? { ...meta, language } : { language, language_group: group },
      };
    });
    return new TextEncoder().encode(formatFabricPy({ ...(notebookMeta ? { meta: notebookMeta } : {}), cells }));
  }
}
