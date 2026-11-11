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
import { firstJsonDifference } from '../../notebooks/formatTest';
import {
  FABRIC_CICD_EXAMPLE_PY,
  FABRIC_CICD_HELLO_WORLD_PY,
  LEAN_PYTHON_IPYNB,
  LEAN_PYTHON_PY,
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
     assert.strictEqual(written, SAMPLE_PY, 'byte for byte, as Fabric writes it');
  });

  test('an empty markdown line is written "# " with the space, as Fabric writes it; a bare "#" still reads', () => {
    // The blank line after the final newline is left bare (see the next test).
    const fabric = '# # Core Utils Module\n# \n# This notebook provides a module.\n';
    const py = formatFabricPy({ cells: [{ kind: 'markdown', source: '# Core Utils Module\n\nThis notebook provides a module.\n' }] });
    assert.ok(py.includes(`# MARKDOWN ********************\n\n${fabric}\n`), py);
    // Files written by earlier versions (bare "#") read the same, and are rewritten as Fabric writes them.
    const older = py.replace(/^# $/gm, '#');
    assert.notStrictEqual(older, py);
    assert.deepStrictEqual(parseFabricPy(older), parseFabricPy(py));
    assert.strictEqual(formatFabricPy(parseFabricPy(older)), py);
  });

  test('a markdown cell ending in a newline ends with a blank line, not "# ", as Fabric writes it', () => {
    // From a real Fabric .py: "# # Imports", a blank line, then the separator before the next cell.
    const fabric = '# MARKDOWN ********************\n\n# # Imports\n\n\n# CELL ********************\n\nimport os\n';
    const notebook = { cells: [{ kind: 'markdown' as const, source: '# Imports\n' }, { kind: 'code' as const, source: 'import os' }] };
    assert.strictEqual(formatFabricPy(notebook), `# Fabric notebook source\n\n${fabric}`);
    assert.deepStrictEqual(parseFabricPy(formatFabricPy(notebook)), notebook);
    // The same from the .ipynb, where the cell's source is ["# Imports\n"].
    const ipynb = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# Imports\n'] },
      { cell_type: 'code', metadata: {}, source: ['import os'], outputs: [], execution_count: null },
    ] };
    assert.ok(formatFabricPy(ipynbToFabric(JSON.stringify(ipynb))).includes(fabric));
    // Empty lines inside the cell are still "# ".
    assert.ok(formatFabricPy({ cells: [{ kind: 'markdown', source: 'a\n\nb\n\n' }] }).includes('# a\n# \n# b\n# \n\n'));
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

  test('cells kept from the .ipynb keep having no ID if they had none; new cells get one only from nbformat 4.5', () => {
    const ipynb = JSON.parse(SCRATCH3_IPYNB);
    delete ipynb.cells[0].id;
    const added = parseFabricPy(SCRATCH3_PY);
    added.cells.push({ ...added.cells[1], source: 'print(1)' });
    const v45 = JSON.parse(fabricToIpynb(added, JSON.stringify(ipynb)));
    assert.ok(!('id' in v45.cells[0]));
    assert.strictEqual(v45.cells[1].id, ipynb.cells[1].id);
    assert.strictEqual(typeof v45.cells[2].id, 'string');
    ipynb.nbformat_minor = 4;
    const v44 = JSON.parse(fabricToIpynb(added, JSON.stringify(ipynb)));
    assert.ok(!('id' in v44.cells[2]));
  });

  test('code cells kept from the .ipynb keep having no execution_count or outputs if they had none; new ones get both', () => {
    const ipynb = JSON.parse(SCRATCH3_IPYNB);
    delete ipynb.cells[1].execution_count;
    delete ipynb.cells[1].outputs;
    const added = parseFabricPy(SCRATCH3_PY);
    added.cells.push({ ...added.cells[1], source: 'print(1)' });
    const updated = JSON.parse(fabricToIpynb(added, JSON.stringify(ipynb)));
    assert.ok(!('execution_count' in updated.cells[1]));
    assert.ok(!('outputs' in updated.cells[1]));
    assert.strictEqual(updated.cells[2].execution_count, null);
    assert.deepStrictEqual(updated.cells[2].outputs, []);
  });

  test('a lean Fabric .ipynb (no cell IDs or execution counts, "lakehouse": null) comes back from its .py as Fabric has it', () => {
    assert.ok(isFabricIpynb(LEAN_PYTHON_IPYNB));
    assert.strictEqual(formatFabricPy(ipynbToFabric(LEAN_PYTHON_IPYNB)), LEAN_PYTHON_PY);
    assert.strictEqual(formatFabricPy(parseFabricPy(LEAN_PYTHON_PY)), LEAN_PYTHON_PY);
    // As the "matches Fabric's .ipynb" check of Test Notebook Formats compares them.
    const generated = fabricToIpynb(parseFabricPy(LEAN_PYTHON_PY), LEAN_PYTHON_IPYNB);
    assert.strictEqual(firstJsonDifference(JSON.parse(LEAN_PYTHON_IPYNB), JSON.parse(generated)), undefined);
  });

  test('lakehouses with no default: Fabric’s .py has "" for the default’s name and workspace, its .ipynb leaves both out', () => {
    // Headers from a real Fabric notebook (both exports; its cells left out).
    const fabricPy = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "jupyter",
# META     "jupyter_kernel_name": "python3.12"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse_name": "",
# META       "default_lakehouse_workspace_id": "",
# META       "known_lakehouses": []
# META     },
# META     "warehouse": {
# META       "known_warehouses": []
# META     }
# META   }
# META }
`;
    const fabricIpynb = JSON.stringify({
      cells: [],
      metadata: {
        dependencies: { lakehouse: { known_lakehouses: [] }, warehouse: { known_warehouses: [] } },
        kernel_info: { name: 'jupyter', jupyter_kernel_name: 'python3.12' },
        language_info: { name: 'python' },
        microsoft: { language: 'python', language_group: 'jupyter_python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    });
    assert.strictEqual(formatFabricPy(ipynbToFabric(fabricIpynb)), fabricPy);
    assert.strictEqual(formatFabricPy(parseFabricPy(fabricPy)), fabricPy);
    const generated = fabricToIpynb(parseFabricPy(fabricPy), fabricIpynb);
    assert.strictEqual(firstJsonDifference(JSON.parse(fabricIpynb), JSON.parse(generated)), undefined);
    // A new .ipynb (first download) has them left out too, and gives the same .py back.
    const fresh = fabricToIpynb(parseFabricPy(fabricPy));
    assert.deepStrictEqual(JSON.parse(fresh).metadata.dependencies, JSON.parse(fabricIpynb).metadata.dependencies);
    assert.strictEqual(formatFabricPy(ipynbToFabric(fresh)), fabricPy);
    // A default lakehouse's name and workspace are kept as they are.
    const withDefault = JSON.parse(SCRATCH2_TSQL_LAKEHOUSE_IPYNB);
    assert.deepStrictEqual(
      JSON.parse(fabricToIpynb(ipynbToFabric(SCRATCH2_TSQL_LAKEHOUSE_IPYNB), SCRATCH2_TSQL_LAKEHOUSE_IPYNB)).metadata.dependencies,
      withDefault.metadata.dependencies,
    );
  });

  test('no default lakehouse, but Fabric’s .ipynb keeps the "" name and workspace (and "default_lakehouse": null): kept on rewrite', () => {
    // Headers from a real Fabric notebook (both exports, 2026-11-18; its cells left out).
    const fabricPy = `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse_name": "",
# META       "default_lakehouse_workspace_id": "",
# META       "known_lakehouses": []
# META     },
# META     "environment": {
# META       "environmentId": "00000000-0000-0000-0000-000000000001",
# META       "workspaceId": "00000000-0000-0000-0000-000000000002"
# META     }
# META   }
# META }
`;
    const fabricIpynb = JSON.stringify({
      cells: [],
      metadata: {
        a365ComputeOptions: null,
        dependencies: {
          environment: { environmentId: '00000000-0000-0000-0000-000000000001', workspaceId: '00000000-0000-0000-0000-000000000002' },
          lakehouse: { default_lakehouse: null, default_lakehouse_name: '', default_lakehouse_workspace_id: '', known_lakehouses: [] },
        },
        kernel_info: { name: 'synapse_pyspark' },
        microsoft: { language: 'python', language_group: 'synapse_pyspark' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    });
    assert.strictEqual(formatFabricPy(ipynbToFabric(fabricIpynb)), fabricPy);
    const generated = fabricToIpynb(parseFabricPy(fabricPy), fabricIpynb);
    assert.strictEqual(firstJsonDifference(JSON.parse(fabricIpynb), JSON.parse(generated)), undefined);
    assert.strictEqual(formatFabricPy(ipynbToFabric(generated)), fabricPy);
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
