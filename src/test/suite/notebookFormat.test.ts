import * as assert from 'assert';
import {
  FABRIC_PY_HEADER,
  fabricToIpynb,
  isFabricIpynb,
  isFabricPy,
  formatFabricPy,
  ipynbToFabric,
  NotebookFormatError,
  parseFabricPy,
  withKeyOrderOf,
} from '../../notebooks/format';
import {
  FABRIC_CICD_EXAMPLE_PY,
  FABRIC_CICD_HELLO_WORLD_PY,
  SCRATCH2_IPYNB,
  SCRATCH2_TSQL_LAKEHOUSE_IPYNB,
  SCRATCH2_TSQL_LAKEHOUSE_PY,
  SCRATCH3_IPYNB,
  SCRATCH3_PY,
} from './fixtures/fabricSamples';

const PY_META = { language: 'python', language_group: 'synapse_pyspark' };
const SQL_META = { language: 'sparksql', language_group: 'synapse_pyspark' };

/** A notebook in Fabric's Git format, laid out the way Fabric writes it. */
const SAMPLE_PY = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse_name": "Sales"
# META     }
# META   }
# META }

# MARKDOWN ********************

# # Load sales
#
# Reads the raw table.

# PARAMETERS CELL ********************

year = 2024

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

df = spark.read.table("sales")

display(df)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# MAGIC %%sql
# MAGIC SELECT *
# MAGIC
# MAGIC FROM sales

# METADATA ********************

# META {
# META   "language": "sparksql",
# META   "language_group": "synapse_pyspark"
# META }
`;

const SAMPLE = {
  meta: { kernel_info: { name: 'synapse_pyspark' }, dependencies: { lakehouse: { default_lakehouse_name: 'Sales' } } },
  cells: [
    { kind: 'markdown', source: '# Load sales\n\nReads the raw table.' },
    { kind: 'code', source: 'year = 2024', parameters: true, meta: PY_META },
    { kind: 'code', source: 'df = spark.read.table("sales")\n\ndisplay(df)', meta: PY_META },
    { kind: 'code', source: '%%sql\nSELECT *\n\nFROM sales', meta: SQL_META },
  ],
};

suite('Notebook formats', () => {
  test('parses Fabric’s Git format: header metadata, markdown, parameters, cell metadata, MAGIC lines', () => {
    assert.deepStrictEqual(parseFabricPy(SAMPLE_PY), SAMPLE);
  });

  test('accepts Windows line endings', () => {
    assert.deepStrictEqual(parseFabricPy(SAMPLE_PY.replace(/\n/g, '\r\n')), SAMPLE);
  });

  test('writes the Git format, round-tripping', () => {
    const written = formatFabricPy(parseFabricPy(SAMPLE_PY));
    assert.deepStrictEqual(parseFabricPy(written), SAMPLE);
    assert.strictEqual(formatFabricPy(parseFabricPy(written)), written);
    assert.ok(written.startsWith('# Fabric notebook source\n\n# METADATA ********************\n\n# META {'));
    assert.ok(written.includes('# CELL ********************\n\n# MAGIC %%sql\n# MAGIC SELECT *\n# MAGIC\n# MAGIC FROM sales\n'));
  });

  test('rejects text that isn’t Fabric’s Git format, and invalid metadata', () => {
    assert.throws(() => parseFabricPy('print("plain python")\n'), /Not a Fabric notebook/);
    // Cell markers alone aren't enough: the header line is the content check.
    assert.throws(() => parseFabricPy('# CELL ********************\n\nx\n'), NotebookFormatError);
    assert.throws(
      () => parseFabricPy(`${FABRIC_PY_HEADER}\n\n# CELL ********************\n\nx\n\n# METADATA ********************\n\n# META {oops\n`),
      /Invalid "# META" block/,
    );
  });

  test('content checks: what counts as a Fabric .py and a Fabric .ipynb', () => {
    for (const yes of [SAMPLE_PY, SAMPLE_PY.replace(/\n/g, '\r\n'), `\uFEFF${SAMPLE_PY}`, `\n\n${FABRIC_PY_HEADER}  \n`, '', ' \n\n']) {
      assert.ok(isFabricPy(yes), JSON.stringify(yes.slice(0, 30)));
    }
    for (const no of ['print(1)\n', `# helper\n${FABRIC_PY_HEADER}\n`, '# Fabric notebook source, sort of\n', '# CELL ********************\n']) {
      assert.ok(!isFabricPy(no), JSON.stringify(no));
    }
    assert.ok(isFabricIpynb(SCRATCH2_IPYNB));
    assert.ok(isFabricIpynb('{"nbformat": 4, "metadata": {"microsoft": {}}, "cells": []}'));
    assert.ok(isFabricIpynb('{"nbformat": 4, "metadata": {}, "cells": [{"cell_type": "code", "metadata": {"microsoft": {}}}]}'));
    for (const no of [
      '{"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": []}', // plain Jupyter
      '{"nbformat": 4, "metadata": {"kernel_info": {"name": "python3"}}, "cells": []}', // nteract writes kernel_info too
      '',
      '{}',
      '[]',
      '{"nbformat": 3, "metadata": {"microsoft": {}}, "cells": []}',
      'not json',
    ]) {
      assert.ok(!isFabricIpynb(no), no);
    }
  });

  test('everything formatFabricPy writes passes the content check, including a new empty notebook', () => {
    assert.ok(isFabricPy(formatFabricPy(parseFabricPy(SAMPLE_PY))));
    const empty = formatFabricPy(parseFabricPy(''));
    assert.strictEqual(empty, `${FABRIC_PY_HEADER}\n`);
    assert.ok(isFabricPy(empty));
    assert.deepStrictEqual(parseFabricPy(empty), { cells: [] });
  });

  test('converts .ipynb to the Git format: languages, parameters tag, header metadata', () => {
    const ipynb = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { ...SAMPLE.meta, language_info: { name: 'python' }, microsoft: { host: {} } },
      cells: [
        { cell_type: 'markdown', id: 'a', metadata: {}, source: ['# Load sales\n', '\n', 'Reads the raw table.'] },
        { cell_type: 'code', id: 'b', metadata: { microsoft: PY_META, tags: ['parameters'] }, source: 'year = 2024', outputs: [], execution_count: null },
        { cell_type: 'code', id: 'c', metadata: { microsoft: PY_META }, source: ['df = spark.read.table("sales")\n', '\n', 'display(df)'], outputs: [{ output_type: 'stream' }], execution_count: 3 },
        { cell_type: 'code', id: 'd', metadata: { microsoft: SQL_META }, source: ['%%sql\n', 'SELECT *\n', '\n', 'FROM sales'], outputs: [], execution_count: null },
      ],
    };
    assert.deepStrictEqual(ipynbToFabric(JSON.stringify(ipynb)), SAMPLE);
  });

  test('converts the Git format to .ipynb, keeping outputs and IDs of unchanged cells', () => {
    const first = JSON.parse(fabricToIpynb(parseFabricPy(SAMPLE_PY)));
    assert.strictEqual(first.nbformat, 4);
    assert.deepStrictEqual(first.metadata.dependencies, SAMPLE.meta.dependencies);
    assert.deepStrictEqual(first.cells[1].metadata, { microsoft: PY_META, tags: ['parameters'] });
    assert.deepStrictEqual(first.cells[2].source, ['df = spark.read.table("sales")\n', '\n', 'display(df)']);

    // Run a cell, then edit another and insert a new one before it in the .py.
    first.cells[2].outputs = [{ output_type: 'stream', text: 'ok' }];
    first.cells[2].execution_count = 1;
    first.metadata.custom = 'kept';
    const edited = parseFabricPy(SAMPLE_PY);
    edited.cells[1].source = 'year = 2025';
    edited.cells.splice(1, 0, { kind: 'code', source: 'import os', meta: PY_META });

    const second = JSON.parse(fabricToIpynb(edited, JSON.stringify(first)));
    assert.strictEqual(second.metadata.custom, 'kept');
    assert.deepStrictEqual(second.cells.map((c: { source: string[] }) => c.source.join('')), [
      '# Load sales\n\nReads the raw table.',
      'import os',
      'year = 2025',
      'df = spark.read.table("sales")\n\ndisplay(df)',
      '%%sql\nSELECT *\n\nFROM sales',
    ]);
    assert.strictEqual(second.cells[0].id, first.cells[0].id);
    assert.deepStrictEqual(second.cells[3].outputs, [{ output_type: 'stream', text: 'ok' }]);
    assert.strictEqual(second.cells[3].id, first.cells[2].id);
    assert.deepStrictEqual(second.cells[2].outputs, []);
    assert.notStrictEqual(second.cells[1].id, undefined);
  });

  test('round-trips .ipynb → .py → .ipynb without losing anything Fabric keeps', () => {
    const ipynb = fabricToIpynb(parseFabricPy(SAMPLE_PY));
    assert.deepStrictEqual(ipynbToFabric(fabricToIpynb(ipynbToFabric(ipynb), ipynb)), SAMPLE);
  });

  test('a real Fabric export (Python notebook) converts to the Git format and back without changes', () => {
    const notebook = ipynbToFabric(SCRATCH2_IPYNB);
    assert.deepStrictEqual(notebook, {
      meta: { kernel_info: { name: 'jupyter', jupyter_kernel_name: 'python3.12' } },
      cells: [
        { kind: 'markdown', source: '# Scratch2' },
        { kind: 'code', source: 'print("Hi!")', meta: { language: 'python', language_group: 'jupyter_python' } },
      ],
    });
    const py = formatFabricPy(notebook);
    assert.ok(isFabricPy(py));
    // Saving the .py back into the .ipynb changes nothing: metadata, outputs and IDs are kept.
    assert.deepStrictEqual(JSON.parse(fabricToIpynb(parseFabricPy(py), SCRATCH2_IPYNB)), JSON.parse(SCRATCH2_IPYNB));
  });

  test('a new .ipynb made from a .py passes the Fabric check, in the notebook’s language group', () => {
    const python = { meta: { kernel_info: { name: 'jupyter' } }, cells: [] };
    const created = JSON.parse(fabricToIpynb(python));
    assert.deepStrictEqual(created.metadata.microsoft, { language: 'python', language_group: 'jupyter_python' });
    assert.ok(isFabricIpynb(fabricToIpynb(python)));
    assert.ok(isFabricIpynb(fabricToIpynb(parseFabricPy(''))));
    assert.strictEqual(JSON.parse(fabricToIpynb(parseFabricPy(''))).metadata.microsoft.language_group, 'synapse_pyspark');
  });

  test('a real Fabric export (PySpark notebook) converts to the Git format and back without changes', () => {
    assert.ok(isFabricIpynb(SCRATCH3_IPYNB));
    const notebook = ipynbToFabric(SCRATCH3_IPYNB);
    assert.deepStrictEqual(notebook, {
      meta: { kernel_info: { name: 'synapse_pyspark' }, dependencies: {} },
      cells: [
        { kind: 'markdown', source: '# Scratch3' },
        {
          kind: 'code',
          // The trailing newline is kept: Fabric's .py writes it as an extra blank line (SCRATCH3_PY).
          source: '# Welcome to your new notebook\n# Type here in the cell editor to add code!\n',
          meta: { language: 'python', language_group: 'synapse_pyspark' },
        },
      ],
    });
    const py = formatFabricPy(notebook);
    assert.deepStrictEqual(parseFabricPy(py), notebook);
    assert.strictEqual(py, SCRATCH3_PY);
    // Saving the .py back changes nothing in the .ipynb: not the trailing newline, not the cell IDs.
    assert.deepStrictEqual(JSON.parse(fabricToIpynb(parseFabricPy(py), SCRATCH3_IPYNB)), JSON.parse(SCRATCH3_IPYNB));
  });

  test('a real Fabric export with a T-SQL cell and a lakehouse converts to the Git format and back without changes', () => {
    const notebook = ipynbToFabric(SCRATCH2_TSQL_LAKEHOUSE_IPYNB);
    const lakehouse = JSON.parse(SCRATCH2_TSQL_LAKEHOUSE_IPYNB).metadata.dependencies;
    assert.deepStrictEqual(notebook.meta, {
      kernel_info: { name: 'jupyter', jupyter_kernel_name: 'python3.12' },
      dependencies: lakehouse,
    });
    assert.deepStrictEqual(notebook.cells[2], {
      kind: 'code',
      source: '%%tsql\nSELECT * FROM table',
      meta: { language: 'sql', language_group: 'jupyter_python' },
    });
    const py = formatFabricPy(notebook);
    assert.ok(py.includes('# MAGIC %%tsql\n# MAGIC SELECT * FROM table\n'));
    assert.ok(py.includes('# META       "default_lakehouse_name": "mylakehouse",'));
    assert.deepStrictEqual(parseFabricPy(py), notebook);
    assert.deepStrictEqual(
      JSON.parse(fabricToIpynb(parseFabricPy(py), SCRATCH2_TSQL_LAKEHOUSE_IPYNB)),
      JSON.parse(SCRATCH2_TSQL_LAKEHOUSE_IPYNB),
    );
  });

  test('Fabric’s own Git-format files (Microsoft samples) parse and rewrite byte for byte', () => {
    for (const py of [FABRIC_CICD_EXAMPLE_PY, FABRIC_CICD_HELLO_WORLD_PY]) {
      assert.ok(isFabricPy(py));
      assert.strictEqual(formatFabricPy(parseFabricPy(py)), py);
    }
    assert.deepStrictEqual(parseFabricPy(FABRIC_CICD_HELLO_WORLD_PY).meta?.dependencies, {
      environment: { environmentId: '00000000-0000-0000-0000-000000000011', workspaceId: '00000000-0000-0000-0000-000000000000' },
    });
  });

  test('regenerating the .py from the .ipynb keeps the .py’s key order (no git diff when nothing changed)', () => {
    // Fabric's .ipynb lists the lakehouse keys in another order than its .py (see SCRATCH2_TSQL_LAKEHOUSE_IPYNB).
    const ipynb = JSON.parse(fabricToIpynb(parseFabricPy(FABRIC_CICD_EXAMPLE_PY)));
    const { known_lakehouses, ...rest } = ipynb.metadata.dependencies.lakehouse;
    ipynb.metadata.dependencies.lakehouse = { known_lakehouses, ...rest };
    ipynb.cells[0].metadata.microsoft = { language_group: 'synapse_pyspark', language: 'python' };
    const fromIpynb = ipynbToFabric(JSON.stringify(ipynb));
    assert.notStrictEqual(formatFabricPy(fromIpynb), FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(formatFabricPy(withKeyOrderOf(fromIpynb, parseFabricPy(FABRIC_CICD_EXAMPLE_PY))), FABRIC_CICD_EXAMPLE_PY);

    // An edited cell and a changed value keep the order too; new keys go last.
    fromIpynb.cells[0].source += '\nprint("more")';
    (fromIpynb.meta!.dependencies as { lakehouse: Record<string, unknown> }).lakehouse.default_lakehouse_name = 'Renamed';
    fromIpynb.meta!.extra = true;
    const edited = formatFabricPy(withKeyOrderOf(fromIpynb, parseFabricPy(FABRIC_CICD_EXAMPLE_PY)));
    const expected = FABRIC_CICD_EXAMPLE_PY.replace('"WithoutSchema"', '"Renamed"')
      .replace('# META   }\n# META }\n\n# CELL', '# META   },\n# META   "extra": true\n# META }\n\n# CELL')
      .replace('eventhouse query URI: https://trd-origineventhouse.z4.kusto.fabric.microsoft.com")\n', 'eventhouse query URI: https://trd-origineventhouse.z4.kusto.fabric.microsoft.com")\nprint("more")\n');
    assert.strictEqual(edited, expected);
  });

  test('a notebook downloaded from Fabric in both formats: the .py generated from its .ipynb is identical to Fabric’s', () => {
    // Fabric's own .py (confirms MARKDOWN cells without metadata, MAGIC lines, the jupyter kernel header)...
    assert.strictEqual(formatFabricPy(parseFabricPy(SCRATCH2_TSQL_LAKEHOUSE_PY)), SCRATCH2_TSQL_LAKEHOUSE_PY);
    // ...and the extension's conversion of Fabric's .ipynb of the same notebook, with no .py to copy from.
    assert.strictEqual(formatFabricPy(ipynbToFabric(SCRATCH2_TSQL_LAKEHOUSE_IPYNB)), SCRATCH2_TSQL_LAKEHOUSE_PY);
    // Saving Fabric's .py into Fabric's .ipynb changes nothing.
    assert.deepStrictEqual(
      JSON.parse(fabricToIpynb(parseFabricPy(SCRATCH2_TSQL_LAKEHOUSE_PY), SCRATCH2_TSQL_LAKEHOUSE_IPYNB)),
      JSON.parse(SCRATCH2_TSQL_LAKEHOUSE_IPYNB),
    );
  });

  test('trailing newlines: Fabric writes them as extra blank lines, and they survive every conversion', () => {
    assert.strictEqual(formatFabricPy(parseFabricPy(SCRATCH3_PY)), SCRATCH3_PY);
    assert.ok(SCRATCH3_PY.includes('add code!\n\n\n# METADATA'));
    assert.deepStrictEqual(JSON.parse(fabricToIpynb(parseFabricPy(SCRATCH3_PY), SCRATCH3_IPYNB)), JSON.parse(SCRATCH3_IPYNB));

    // A cell without a trailing newline has one blank line; with two newlines, two extra.
    for (const source of ['x = 1', 'x = 1\n', 'x = 1\n\n', '\nx = 1']) {
      const notebook = { cells: [{ kind: 'code' as const, source, meta: { language: 'python' } }] };
      assert.strictEqual(parseFabricPy(formatFabricPy(notebook)).cells[0].source, source, JSON.stringify(source));
    }

    // Only the trailing newline changed: the .ipynb takes the new source, but keeps the cell's outputs and ID.
    const ipynb = JSON.parse(SCRATCH3_IPYNB);
    ipynb.cells[1].outputs = [{ output_type: 'stream', name: 'stdout', text: ['ok\n'] }];
    const edited = parseFabricPy(SCRATCH3_PY);
    edited.cells[1].source = edited.cells[1].source.replace(/\n$/, '');
    const updated = JSON.parse(fabricToIpynb(edited, JSON.stringify(ipynb)));
    assert.deepStrictEqual(updated.cells[1].source, ['# Welcome to your new notebook\n', '# Type here in the cell editor to add code!']);
    assert.deepStrictEqual(updated.cells[1].outputs, ipynb.cells[1].outputs);
    assert.strictEqual(updated.cells[1].id, ipynb.cells[1].id);
  });

  test('null settings in the .ipynb (as Fabric’s API exports "lakehouse": null) are left out of the .py header', () => {
    const ipynb = JSON.parse(SCRATCH3_IPYNB);
    ipynb.metadata.dependencies = { lakehouse: null, environment: { environmentId: null, workspaceId: 'w' } };
    assert.deepStrictEqual(ipynbToFabric(JSON.stringify(ipynb)).meta?.dependencies, { environment: { workspaceId: 'w' } });
    ipynb.metadata.dependencies = { lakehouse: null };
    // Downloaded with "lakehouse": null, then saved (e.g. after clearing outputs): the .py is unchanged.
    assert.strictEqual(formatFabricPy(ipynbToFabric(JSON.stringify(ipynb))), SCRATCH3_PY);
  });
});
