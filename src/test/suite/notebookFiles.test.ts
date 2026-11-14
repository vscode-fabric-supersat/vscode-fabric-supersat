// Local notebook files, sync between them, and download/upload against a fake Fabric.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { FabricClient } from '../../fabric/client';
import {
  checkNotebookName,
  createNotebookFiles,
  listLocalNotebooks,
  notebookFiles,
  notebookFilesFor,
  NEW_PROPERTIES_FILE,
  NotFabricNotebookError,
  readNotebookDescription,
  refreshIpynbIfStale,
  syncNotebookFiles,
  wasWrittenByExtension,
} from '../../notebooks/files';
import { FABRIC_NOTEBOOK_TYPE, FabricNotebookSerializer } from '../../notebooks/serializer';
import { EXTENSION_FULL_ID } from '../../constants';
import {
  downloadNotebook,
  downloadNotebooks,
  findByName,
  planUploads,
  runUploads,
  ipynbLanguage,
  isTsqlNotebook,
  unsupportedNotebook,
  uploadNotebook,
} from '../../notebooks/transfer';
import { FABRIC_PY_HEADER, formatFabricPy, ipynbToFabric, isFabricIpynb, isFabricPy, parseFabricPy } from '../../notebooks/format';
import {
  FABRIC_CICD_EXAMPLE_PY,
  SCRATCH2_IPYNB,
  SCRATCH2_TSQL_LAKEHOUSE_IPYNB,
  SCRATCH2_TSQL_LAKEHOUSE_PY,
  TSQL_NOTEBOOK_IPYNB,
} from './fixtures/fabricSamples';
import { ReferenceMapper, SAME_WORKSPACE_ID } from '../../notebooks/references';
import { fromBase64 } from '../../util/base64';
import { toBase64 } from '../../util/base64';
import { LOCAL_GITIGNORE, UnsafePathError } from '../../util/localState';
import { MemFs } from './memFs';

const PY = `# Fabric notebook source

# CELL ********************

print("héllo")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;

const IPYNB = `${JSON.stringify(
  {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { language_info: { name: 'python' } },
    cells: [
      {
        cell_type: 'code',
        id: 'c1',
        metadata: { microsoft: { language: 'python', language_group: 'synapse_pyspark' } },
        source: ['print("héllo")'],
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['héllo\n'] }],
        execution_count: 1,
      },
    ],
  },
  undefined,
  1,
)}\n`;

const encode = (text: string) => new TextEncoder().encode(text);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const part = (path: string, text: string) => ({ path, payload: toBase64(encode(text)), payloadType: 'InlineBase64' });
/** Fabric's answer to getDefinition (its Git format). */
const gitDefinition = (py: string) => json({ definition: { parts: [part('notebook-content.py', py), part('.platform', '{}')] } });

/** A FabricClient whose fetch replays `responses`, recording "METHOD url" and request bodies. */
function fakeClient(responses: Response[]) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const client = new FabricClient({
    getToken: async () => 'tok',
    delay: async () => undefined,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input).replace('https://api.fabric.microsoft.com/v1', '')}`);
      bodies.push(init?.body ? JSON.parse(String(init.body)) : undefined);
      const next = responses.shift();
      if (!next) {
        throw new Error(`Unexpected request: ${String(input)}`);
      }
      return next;
    }) as typeof fetch,
  });
  return { client, calls, bodies };
}

suite('Notebook files', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  const text = (uri: vscode.Uri) => memFs.text(uri.path);
  const write = async (uri: vscode.Uri, content: string) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encode(content));
  };


  suiteSetup(async () => {
    registration = vscode.workspace.registerFileSystemProvider('fss-nb-test', memFs);
    await vscode.extensions.getExtension(EXTENSION_FULL_ID)?.activate();
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    root = vscode.Uri.parse(`fss-nb-test:/project${++run}`);
    await vscode.workspace.fs.createDirectory(root);
  });

  test('a notebook’s two files, found from either path', () => {
    const files = notebookFiles(root, 'Sales Load');
    assert.strictEqual(files.py.path, `${root.path}/src/Notebooks/Sales Load/Sales Load.py`);
    assert.strictEqual(files.ipynb.path, `${root.path}/.fabric-supersat/Notebooks/Sales Load/Sales Load.ipynb`);
    assert.deepStrictEqual(notebookFilesFor(root, files.py), { files, kind: 'py' });
    assert.deepStrictEqual(notebookFilesFor(root, files.ipynb), { files, kind: 'ipynb' });
    for (const other of [
      'src/Notebooks/Sales Load/helpers.py',
      'src/Notebooks/Sales Load/notebook-content.py',
      'src/Notebooks/Sales Load.py',
      'lib/Notebooks/Sales Load/Sales Load.py',
      '.fabric-supersat/Notebooks/Sales Load/Sales Load.py',
      '.fabric-supersat/Notebooks/Sales Load/Other.ipynb',
      'src/Notebooks/Sales Load/sub/Sales Load.py',
      'src/Notebooks/Sales Load/docs/notes.py',
    ]) {
      assert.strictEqual(notebookFilesFor(root, vscode.Uri.joinPath(root, other)), undefined, other);
    }
    assert.strictEqual(notebookFilesFor(root, vscode.Uri.parse('fss-nb-test:/elsewhere/src/Notebooks/A/A.py')), undefined);
  });

  test('never writes through a symlinked .fabric-supersat folder (e.g. one committed to a cloned repo)', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    await vscode.workspace.fs.createDirectory(files.localDir);
    memFs.markSymlink(files.localDir.path);
    await assert.rejects(syncNotebookFiles(files, 'py'), UnsafePathError);
    await assert.rejects(refreshIpynbIfStale(files), UnsafePathError);
    assert.strictEqual(text(vscode.Uri.joinPath(files.localDir, '.gitignore')), undefined);
    assert.strictEqual(text(files.ipynb), undefined);
  });

  test('never writes through a symlinked notebook folder or file', async () => {
    // The source differs from the other file, so sync really has something to write.
    const changed = PY.replace('héllo', 'changed');
    const files = notebookFiles(root, 'Load');
    await write(files.py, changed);
    await write(files.ipynb, IPYNB);
    memFs.markSymlink(vscode.Uri.joinPath(files.ipynb, '..').path);
    await assert.rejects(syncNotebookFiles(files, 'py'), UnsafePathError);
    assert.strictEqual(text(files.ipynb), IPYNB);

    const other = notebookFiles(root, 'Other');
    await write(other.py, changed);
    await write(other.ipynb, IPYNB);
    memFs.markSymlink(other.py.path);
    await assert.rejects(syncNotebookFiles(other, 'ipynb'), UnsafePathError);
    assert.strictEqual(text(other.py), changed);
  });

  test('notebook names must work as folder names; they are never changed to fit', () => {
    for (const ok of ['Sales Load', 'load_2024-v2', 'Café (dev)', '100%']) {
      checkNotebookName(ok);
    }
    for (const bad of ['a/b', 'a\\b', 'a:b', 'what?', ' padded', 'dot.', '..', '']) {
      assert.throws(() => checkNotebookName(bad), /can't be saved as a folder/, JSON.stringify(bad));
    }
  });

  test('saving the .ipynb regenerates the .py; saving the .py updates the .ipynb, keeping outputs', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.ipynb, IPYNB);
    await syncNotebookFiles(files, 'ipynb');
    assert.strictEqual(text(files.py), PY);

    await write(files.py, PY.replace('print("héllo")', 'print("héllo")\nprint("again")'));
    await syncNotebookFiles(files, 'py');
    const updated = JSON.parse(text(files.ipynb)!);
    assert.deepStrictEqual(updated.cells[0].source, ['print("héllo")\n', 'print("again")']);
    assert.deepStrictEqual(updated.cells[0].outputs, []);

    await write(files.py, PY);
    await write(files.ipynb, IPYNB);
    await syncNotebookFiles(files, 'py');
    assert.deepStrictEqual(JSON.parse(text(files.ipynb)!).cells[0].outputs, JSON.parse(IPYNB).cells[0].outputs);
  });

  test('sync skips a saved file that isn’t a notebook, and never overwrites one that isn’t', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, 'print("just python")\n');
    await assert.rejects(syncNotebookFiles(files, 'py'), /isn't a Fabric notebook.*%run in Python notebooks or an Environment in PySpark notebooks/);
    assert.strictEqual(text(files.ipynb), undefined);

    // A standard .py where the notebook's .py would go is left alone.
    await write(files.ipynb, IPYNB);
    await assert.rejects(syncNotebookFiles(files, 'ipynb'), NotFabricNotebookError);
    assert.strictEqual(text(files.py), 'print("just python")\n');

    await write(files.py, PY);
    await write(files.ipynb, '{"not": "a notebook"}');
    await assert.rejects(syncNotebookFiles(files, 'py'), /isn't a Fabric notebook/);
    assert.strictEqual(text(files.ipynb), '{"not": "a notebook"}');
  });

  test('a new notebook: an empty <Name>.py opens as an empty notebook and saves as a valid Fabric file', async () => {
    const files = notebookFiles(root, 'Brand New');
    await write(files.py, '');
    const serializer = new FabricNotebookSerializer();
    const data = serializer.deserializeNotebook(encode(''));
    assert.strictEqual(data.cells.length, 0);
    data.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'print("hi")', 'python'));
    await vscode.workspace.fs.writeFile(files.py, serializer.serializeNotebook(data));

    await syncNotebookFiles(files, 'py');
    assert.strictEqual(JSON.parse(text(files.ipynb)!).cells[0].source[0], 'print("hi")');
    const { client, bodies } = fakeClient([json({ value: [] }), json({ id: 'n9', displayName: 'Brand New' }, 201)]);
    assert.strictEqual(await uploadNotebook(client, files, 'w1', async () => true), 'created');
    assert.strictEqual((bodies[1] as { displayName: string }).displayName, 'Brand New');
  });

  test('Create New Fabric Notebook writes both files: one empty Python cell, valid and ready to upload', async () => {
    const files = notebookFiles(root, 'Load Sales');
    await createNotebookFiles(files);
    const py = text(files.py)!;
    assert.ok(py.startsWith(`${FABRIC_PY_HEADER}\n`));
    assert.ok(isFabricPy(py));
    assert.deepStrictEqual(parseFabricPy(py).cells, [
      { kind: 'code', source: '', meta: { language: 'python', language_group: 'synapse_pyspark' } },
    ]);
    assert.ok(isFabricIpynb(text(files.ipynb)!));
    assert.strictEqual(text(vscode.Uri.joinPath(files.localDir, '.gitignore')), LOCAL_GITIGNORE);
    assert.strictEqual(new FabricNotebookSerializer().deserializeNotebook(encode(py)).cells.length, 1);

    const { client } = fakeClient([json({ value: [] }), json({ id: 'n9', displayName: 'Load Sales' }, 201)]);
    assert.strictEqual(await uploadNotebook(client, files, 'w1', async () => true), 'created');
  });

  test('Create New Fabric Notebook makes a Python (non-Spark) notebook as Fabric writes one', async () => {
    const files = notebookFiles(root, 'Common');
    await createNotebookFiles(files, 'python');
    const notebook = parseFabricPy(text(files.py)!);
    // As in a Python notebook downloaded from Fabric (SCRATCH2_IPYNB).
    const scratch2 = ipynbToFabric(SCRATCH2_IPYNB);
    assert.deepStrictEqual(notebook.meta?.kernel_info, scratch2.meta?.kernel_info);
    assert.deepStrictEqual(notebook.cells[0].meta, scratch2.cells[1].meta);
    const ipynb = text(files.ipynb)!;
    assert.ok(isFabricIpynb(ipynb));
    assert.strictEqual(JSON.parse(ipynb).metadata.microsoft.language_group, 'jupyter_python');

    // A cell added in the editor joins the Python language group.
    const serializer = new FabricNotebookSerializer();
    const data = serializer.deserializeNotebook(encode(text(files.py)!));
    data.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1', 'python'));
    const saved = parseFabricPy(new TextDecoder().decode(serializer.serializeNotebook(data)));
    assert.strictEqual(saved.cells[1].meta?.language_group, 'jupyter_python');
  });

  test('Create New Fabric Notebook makes a PySpark notebook by default, matching Fabric’s documented example header', async () => {
    const files = notebookFiles(root, 'Spark Job');
    await createNotebookFiles(files);
    assert.ok(text(files.py)!.startsWith(
      '# Fabric notebook source\n\n# METADATA ********************\n\n# META {\n# META   "kernel_info": {\n# META     "name": "synapse_pyspark"\n# META   },\n# META   "dependencies": {}\n# META }\n',
    ));
  });

  test('Create New Fabric Notebook refuses an existing notebook or a name that can’t be a folder', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    await assert.rejects(createNotebookFiles(files), /already exists/);
    assert.strictEqual(text(files.py), PY);
    await assert.rejects(createNotebookFiles(notebookFiles(root, 'a:b')), /can't be saved as a folder/);
  });

  test('upload refuses a .py that isn’t a Fabric notebook, or has no cells', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, 'print("just python")\n');
    await assert.rejects(uploadNotebook(fakeClient([]).client, files, 'w1', async () => true), NotFabricNotebookError);
    await write(files.py, '');
    await assert.rejects(uploadNotebook(fakeClient([]).client, files, 'w1', async () => true), /no cells/);
  });

  test('saving a .py with no .ipynb yet creates it, and git-ignores .fabric-supersat', async () => {
    const files = notebookFiles(root, 'Fresh');
    await write(files.py, PY);
    await syncNotebookFiles(files, 'py');
    assert.strictEqual(JSON.parse(text(files.ipynb)!).cells[0].source[0], 'print("héllo")');
    assert.strictEqual(text(vscode.Uri.joinPath(files.localDir, '.gitignore')), LOCAL_GITIGNORE);
  });

  test('download makes one request: Fabric’s .py as it is, and an .ipynb generated from it, without Fabric’s outputs', async () => {
    const { client, calls } = fakeClient([gitDefinition(PY)]);
    const files = await downloadNotebook(client, root, 'w1', { id: 'n1', displayName: 'Load' }, async () => {
      throw new Error('should not ask: nothing to replace');
    });
    assert.ok(files);
    assert.strictEqual(text(files.py), PY);
    const ipynb = JSON.parse(text(files.ipynb)!);
    assert.deepStrictEqual(ipynb.cells.map((c: { source: string[]; outputs: unknown[] }) => [c.source, c.outputs]), [[['print("héllo")'], []]]);
    assert.ok(isFabricIpynb(text(files.ipynb)!));
    assert.strictEqual(text(vscode.Uri.joinPath(files.localDir, '.gitignore')), LOCAL_GITIGNORE);
    assert.deepStrictEqual(calls, ['POST /workspaces/w1/notebooks/n1/getDefinition']);
  });

  test('downloading again keeps the local .ipynb’s outputs for cells whose code is unchanged', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.ipynb, IPYNB);
    const { client } = fakeClient([gitDefinition(PY)]);
    await downloadNotebook(client, root, 'w1', { id: 'n1', displayName: 'Load' }, async () => true);
    assert.deepStrictEqual(JSON.parse(text(files.ipynb)!).cells[0].outputs, JSON.parse(IPYNB).cells[0].outputs);

    const changed = fakeClient([gitDefinition(PY.replace('print("héllo")', 'print("bye")'))]);
    await downloadNotebook(changed.client, root, 'w1', { id: 'n1', displayName: 'Load' }, async () => true);
    assert.deepStrictEqual(JSON.parse(text(files.ipynb)!).cells[0].outputs, []);
  });

  const definitions = () => [gitDefinition(PY)];

  test('upload writes the changed lakehouse IDs to both local files first, and uploads them', async () => {
    const files = notebookFiles(root, 'Example');
    await write(files.py, FABRIC_CICD_EXAMPLE_PY);
    await syncNotebookFiles(files, 'py');
    const references = new ReferenceMapper(async () => [{ id: 'lh-test', displayName: 'WithoutSchema' }], 'w-test');
    const { client, bodies } = fakeClient([json({ value: [] }), json({ id: 'n9', displayName: 'Example' }, 201)]);
    assert.strictEqual(await uploadNotebook(client, files, 'w-test', async () => true, { references }), 'created');

    const py = text(files.py)!;
    assert.notStrictEqual(py, FABRIC_CICD_EXAMPLE_PY);
    assert.strictEqual(parseFabricPy(py).meta?.dependencies && (parseFabricPy(py).meta!.dependencies as { lakehouse: { default_lakehouse: string } }).lakehouse.default_lakehouse, 'lh-test');
    const ipynb = JSON.parse(text(files.ipynb)!) as { metadata: { dependencies: { lakehouse: Record<string, unknown> } } };
    assert.strictEqual(ipynb.metadata.dependencies.lakehouse.default_lakehouse, 'lh-test');
    assert.strictEqual(ipynb.metadata.dependencies.lakehouse.default_lakehouse_workspace_id, 'w-test');
    const sent = (bodies[1] as { definition: { parts: { payload: string }[] } }).definition.parts[0].payload;
    assert.strictEqual(new TextDecoder().decode(fromBase64(sent)), py);
  });

  test('download can save the notebook’s own workspace as "same workspace", in both files', async () => {
    const workspaceId = '00000000-0000-0000-0000-000000000010'; // FABRIC_CICD_EXAMPLE_PY's lakehouse workspace
    const { client } = fakeClient([gitDefinition(FABRIC_CICD_EXAMPLE_PY)]);
    const files = await downloadNotebook(client, root, workspaceId, { id: 'n1', displayName: 'Example' }, async () => true, {
      sameWorkspace: { defaultLakehouse: true, environment: true },
    });
    assert.ok(files);
    assert.strictEqual(text(files.py), FABRIC_CICD_EXAMPLE_PY.replace(workspaceId, SAME_WORKSPACE_ID));
    const ipynb = JSON.parse(text(files.ipynb)!) as { metadata: { dependencies: { lakehouse: Record<string, unknown> } } };
    assert.strictEqual(ipynb.metadata.dependencies.lakehouse.default_lakehouse_workspace_id, SAME_WORKSPACE_ID);
  });

  test('download saves Fabric’s description in notebook.yaml', async () => {
    const { client } = fakeClient(definitions());
    const files = await downloadNotebook(
      client,
      root,
      'w1',
      { id: 'n1', displayName: 'Load', description: 'Loads "sales"' },
      async () => true,
    );
    assert.ok(files);
    assert.strictEqual(text(files.properties), NEW_PROPERTIES_FILE.replace('\ndescription: ""', '\ndescription: "Loads \\"sales\\""'));
    assert.strictEqual(await readNotebookDescription(files), 'Loads "sales"');
  });

  test('download without a description creates no notebook.yaml, and blanks it in an existing one', async () => {
    const files = notebookFiles(root, 'Load');
    const none = await downloadNotebook(fakeClient(definitions()).client, root, 'w1', { id: 'n1', displayName: 'Load' }, async () => true);
    assert.ok(none);
    assert.strictEqual(text(files.properties), undefined);

    await write(files.properties, '# my notes\ndescription: "old" # from before\n');
    await downloadNotebook(fakeClient(definitions()).client, root, 'w1', { id: 'n1', displayName: 'Load' }, async () => true);
    assert.strictEqual(text(files.properties), '# my notes\ndescription: "" # from before\n');
    assert.strictEqual(await readNotebookDescription(files), '');
  });

  test('notebook.yaml: no file or no description leaves Fabric’s alone; "" clears; too long is refused', async () => {
    const files = notebookFiles(root, 'Load');
    assert.strictEqual(await readNotebookDescription(files), undefined);
    await write(files.properties, '# nothing yet\n');
    assert.strictEqual(await readNotebookDescription(files), undefined);
    await write(files.properties, 'description: ""\n');
    assert.strictEqual(await readNotebookDescription(files), '');
    await write(files.properties, 'description: 2024\n');
    assert.strictEqual(await readNotebookDescription(files), '2024');
    await write(files.properties, `description: "${'x'.repeat(257)}"\n`);
    await assert.rejects(readNotebookDescription(files), /257 characters; Fabric allows at most 256/);
    await write(files.properties, 'description: [a]\n');
    await assert.rejects(readNotebookDescription(files), /should be text/);
  });

  test('upload sets the description only when notebook.yaml has one that differs from Fabric’s', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    const upload = async (fabricDescription: string | undefined) => {
      const fake = fakeClient([
        json({ value: [{ id: 'n1', displayName: 'Load', description: fabricDescription }] }),
        new Response(null, { status: 200 }),
        json({ id: 'n1', displayName: 'Load' }),
      ]);
      assert.strictEqual(await uploadNotebook(fake.client, files, 'w1', async () => true), 'updated');
      return fake;
    };

    // No notebook.yaml: exactly as before, Fabric's description untouched.
    assert.deepStrictEqual((await upload('kept')).calls.length, 2);

    await write(files.properties, 'description: "New text"\n');
    const changed = await upload('Old text');
    assert.deepStrictEqual(changed.calls.slice(1), [
      'POST /workspaces/w1/notebooks/n1/updateDefinition',
      'PATCH /workspaces/w1/notebooks/n1',
    ]);
    assert.deepStrictEqual(changed.bodies[2], { description: 'New text' });
    assert.strictEqual((await upload('New text')).calls.length, 2, 'unchanged: no PATCH');

    await write(files.properties, 'description: ""\n');
    const cleared = await upload('Old text');
    assert.deepStrictEqual(cleared.bodies[2], { description: '' });
    assert.strictEqual((await upload(undefined)).calls.length, 2, 'already empty: no PATCH');
  });

  test('upload creates the notebook with the description from notebook.yaml', async () => {
    const files = notebookFiles(root, 'New One');
    await write(files.py, PY);
    await write(files.properties, 'description: "Fresh"\n');
    const { client, bodies } = fakeClient([json({ value: [] }), json({ id: 'n9', displayName: 'New One' }, 201)]);
    assert.strictEqual(await uploadNotebook(client, files, 'w1', async () => true), 'created');
    assert.strictEqual((bodies[1] as { description?: string }).description, 'Fresh');

    await write(files.properties, 'description: ""\n');
    const empty = fakeClient([json({ value: [] }), json({ id: 'n9', displayName: 'New One' }, 201)]);
    await uploadNotebook(empty.client, files, 'w1', async () => true);
    assert.ok(!('description' in (empty.bodies[1] as object)));
  });

  test('upload refuses a notebook.yaml it can’t use, before sending anything; Upload All skips it', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    await write(files.properties, `description: "${'x'.repeat(300)}"\n`);
    const { client, calls } = fakeClient([]);
    await assert.rejects(uploadNotebook(client, files, 'w1', async () => true), /notebook\.yaml.*300 characters/);
    assert.deepStrictEqual(calls, []);

    const plan = await planUploads(fakeClient([json({ value: [] })]).client, 'w1', [files]);
    assert.deepStrictEqual(plan.uploads, []);
    assert.match(plan.skipped[0].reason, /300 characters/);
  });

  test('download asks before replacing a local copy, and leaves it alone if declined', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, 'local edits');
    const { client, calls } = fakeClient([]);
    let asked = 0;
    const result = await downloadNotebook(client, root, 'w1', { id: 'n1', displayName: 'Load' }, async () => {
      asked++;
      return false;
    });
    assert.strictEqual(result, undefined);
    assert.strictEqual(asked, 1);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(text(files.py), 'local edits');
  });

  test('upload overwrites the notebook with the same name (ignoring case), sending the .py', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    const { client, calls, bodies } = fakeClient([
      json({ value: [{ id: 'n0', displayName: 'Other' }, { id: 'n1', displayName: 'load' }] }),
      new Response(null, { status: 200 }),
    ]);
    let confirmedFor: unknown;
    const result = await uploadNotebook(client, files, 'w1', async (existing) => {
      confirmedFor = existing?.id;
      return true;
    });
    assert.strictEqual(result, 'updated');
    assert.strictEqual(confirmedFor, 'n1');
    assert.deepStrictEqual(calls, ['GET /workspaces/w1/notebooks', 'POST /workspaces/w1/notebooks/n1/updateDefinition']);
    assert.deepStrictEqual(bodies[1], { definition: { parts: [part('notebook-content.py', PY)] } });
  });

  test('upload creates the notebook when none has the name, and does nothing if cancelled', async () => {
    const files = notebookFiles(root, 'New One');
    await write(files.py, PY);
    const cancelled = fakeClient([json({ value: [] })]);
    assert.strictEqual(await uploadNotebook(cancelled.client, files, 'w1', async () => false), undefined);
    assert.deepStrictEqual(cancelled.calls, ['GET /workspaces/w1/notebooks']);

    const { client, calls, bodies } = fakeClient([json({ value: [] }), json({ id: 'n9', displayName: 'New One' }, 201)]);
    assert.strictEqual(await uploadNotebook(client, files, 'w1', async (existing) => existing === undefined), 'created');
    assert.deepStrictEqual(calls[1], 'POST /workspaces/w1/notebooks');
    assert.strictEqual((bodies[1] as { displayName: string }).displayName, 'New One');
  });

  test('upload builds the .py from the .ipynb if only that exists, and refuses a broken .py', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.ipynb, IPYNB);
    const { client } = fakeClient([json({ value: [] }), json({ id: 'n9', displayName: 'Load' }, 201)]);
    assert.strictEqual(await uploadNotebook(client, files, 'w1', async () => true), 'created');
    assert.strictEqual(text(files.py), PY);

    await write(files.py, 'not a fabric notebook');
    await assert.rejects(uploadNotebook(fakeClient([]).client, files, 'w1', async () => true), /Fabric notebook source/);
  });

  test('findByName prefers an exact match', () => {
    const items = [{ displayName: 'LOAD' }, { displayName: 'Load' }];
    assert.strictEqual(findByName(items, 'Load'), items[1]);
    assert.strictEqual(findByName(items, 'load'), items[0]);
    assert.strictEqual(findByName(items, 'nope'), undefined);
  });

  test('the .py opens in the notebook editor and saves back unchanged', () => {
    const serializer = new FabricNotebookSerializer();
    const data = serializer.deserializeNotebook(encode(PY));
    assert.strictEqual(data.cells.length, 1);
    assert.strictEqual(data.cells[0].languageId, 'python');
    assert.strictEqual(new TextDecoder().decode(serializer.serializeNotebook(data)), PY);

    // A cell added in the editor (no Fabric metadata) and a cell switched to SQL.
    data.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'SELECT 1', 'sql'));
    const saved = new TextDecoder().decode(serializer.serializeNotebook(data));
    assert.ok(saved.includes('# MAGIC SELECT 1\n\n# METADATA ********************\n\n# META {\n# META   "language": "sparksql",\n# META   "language_group": "synapse_pyspark"\n# META }'), saved);
  });

  test('opening src/Notebooks/<Name>/<Name>.py shows the notebook editor; files in subfolders and other .py files open as text', async () => {
    const files = notebookFiles(root, 'Opened');
    await write(files.py, PY);
    const helper = vscode.Uri.joinPath(root, 'src', 'Notebooks', 'Opened', 'docs', 'notes.py');
    await write(helper, 'x = 1\n');
    const plain = vscode.Uri.joinPath(root, 'src', 'helpers.py');
    await write(plain, 'x = 1\n');
    try {
      await vscode.commands.executeCommand('vscode.open', files.py);
      const notebook = vscode.window.activeNotebookEditor?.notebook;
      assert.strictEqual(notebook?.uri.toString(), files.py.toString());
      assert.strictEqual(notebook?.notebookType, FABRIC_NOTEBOOK_TYPE);
      assert.strictEqual(notebook?.cellAt(0).document.getText(), 'print("héllo")');

      for (const uri of [helper, plain]) {
        await vscode.commands.executeCommand('vscode.open', uri);
        assert.strictEqual(vscode.window.activeTextEditor?.document.uri.toString(), uri.toString());
        assert.strictEqual(vscode.window.activeNotebookEditor, undefined);
      }
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('in a Python notebook, a cell added in the editor gets jupyter_python, not Spark', () => {
    const serializer = new FabricNotebookSerializer();
    const py = new TextDecoder().decode(
      serializer.serializeNotebook(serializer.deserializeNotebook(encode(PY.replace(/synapse_pyspark/g, 'jupyter_python')))),
    );
    const data = serializer.deserializeNotebook(encode(py));
    data.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1', 'python'));
    const saved = parseFabricPy(new TextDecoder().decode(serializer.serializeNotebook(data)));
    assert.deepStrictEqual(saved.cells[1].meta, { language: 'python', language_group: 'jupyter_python' });

    // Same when the notebook's only hint is its kernel (Fabric's Python kernel is "jupyter").
    const scratch = new TextDecoder().decode(serializer.serializeNotebook(serializer.deserializeNotebook(encode(
      formatFabricPy({ meta: ipynbToFabric(SCRATCH2_IPYNB).meta, cells: [] }),
    ))));
    const empty = serializer.deserializeNotebook(encode(scratch));
    empty.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'x = 1', 'python'));
    assert.strictEqual(parseFabricPy(new TextDecoder().decode(serializer.serializeNotebook(empty))).cells[0].meta?.language_group, 'jupyter_python');
  });

  test('SQL cells: T-SQL opens as SQL and saves unchanged; new SQL cells get the notebook’s SQL dialect', () => {
    const serializer = new FabricNotebookSerializer();
    const save = (data: vscode.NotebookData) => parseFabricPy(new TextDecoder().decode(serializer.serializeNotebook(data)));
    const python = serializer.deserializeNotebook(encode(formatFabricPy(ipynbToFabric(SCRATCH2_TSQL_LAKEHOUSE_IPYNB))));
    assert.strictEqual(python.cells[2].languageId, 'sql');
    assert.deepStrictEqual(save(python), ipynbToFabric(SCRATCH2_TSQL_LAKEHOUSE_IPYNB));

    // A new SQL cell is T-SQL in a Python notebook...
    python.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '%%tsql\nSELECT 1', 'sql'));
    assert.deepStrictEqual(save(python).cells[3].meta, { language: 'sql', language_group: 'jupyter_python' });

    // ...and Spark SQL in a Spark notebook.
    const spark = serializer.deserializeNotebook(encode(PY));
    spark.cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '%%sql\nSELECT 1', 'sql'));
    assert.deepStrictEqual(save(spark).cells[1].meta, { language: 'sparksql', language_group: 'synapse_pyspark' });
  });

  test('download explains that Spark SQL, Scala and SparkR notebooks aren’t supported yet', async () => {
    for (const [path, message] of [
      ['notebook-content.scala', /"Scala Job" is a Scala notebook \(notebook-content\.scala; it runs Scala on a Spark cluster\)\. Scala notebooks aren't supported yet, only PySpark and Python notebooks\.$/],
      ['notebook-content.sql', /"Scala Job" is a Spark SQL notebook \(notebook-content\.sql; it runs Spark SQL on a Spark cluster\)\..*Spark SQL cells \(%%sql\) in a PySpark notebook are supported\.$/],
      ['notebook-content.r', /"Scala Job" is a SparkR notebook/],
    ] as const) {
      const { client } = fakeClient([json({ definition: { parts: [part(path, '// Fabric notebook source\n'), part('.platform', '{}')] } })]);
      await assert.rejects(downloadNotebook(client, root, 'w1', { id: 'n1', displayName: 'Scala Job' }, async () => true), message);
    }
    assert.strictEqual(text(notebookFiles(root, 'Scala Job').py), undefined);
    assert.strictEqual(ipynbLanguage(IPYNB), 'PySpark');
    assert.strictEqual(ipynbLanguage(SCRATCH2_TSQL_LAKEHOUSE_IPYNB), 'Python');
    assert.strictEqual(ipynbLanguage(TSQL_NOTEBOOK_IPYNB), 'T-SQL');
  });

  test('Spark SQL and T-SQL notebooks are told apart, and their SQL cells pointed to', () => {
    const header = (prefix: string, kernel: string) =>
      `${prefix} Fabric notebook source\n\n${prefix} METADATA ********************\n\n` +
      `${prefix} META {\n${prefix} META   "kernel_info": {\n${prefix} META     "name": "${kernel}"\n${prefix} META   }\n${prefix} META }\n`;
    assert.match(
      unsupportedNotebook('Sales', 'notebook-content.sql', header('--', 'synapse_pyspark'))!,
      /"Sales" is a Spark SQL notebook \(notebook-content\.sql; it runs Spark SQL on a Spark cluster\)\..*Spark SQL cells \(%%sql\) in a PySpark notebook are supported\.$/,
    );
    for (const [path, prefix] of [['notebook-content.sql', '--'], ['notebook-content.py', '#']]) {
      assert.match(
        unsupportedNotebook('Report', path, header(prefix, 'sqldatawarehouse'))!,
        /"Report" is a T-SQL notebook \(.*; it runs T-SQL on a warehouse or SQL analytics endpoint\)\. T-SQL notebooks aren't supported yet.*T-SQL cells \(%%tsql\) in a Python notebook are supported\.$/,
        path,
      );
    }
    // A Python notebook with a T-SQL cell is fine.
    assert.strictEqual(unsupportedNotebook('Scratch2', 'notebook-content.py', SCRATCH2_TSQL_LAKEHOUSE_PY), undefined);
    assert.strictEqual(unsupportedNotebook('Load', 'notebook-content.py', PY), undefined);
  });

  test('a T-SQL notebook is refused on download, by the kernel in its Git-format header', async () => {
    assert.ok(isTsqlNotebook(TSQL_NOTEBOOK_IPYNB));
    assert.ok(!isTsqlNotebook(SCRATCH2_TSQL_LAKEHOUSE_IPYNB), 'a Python notebook with a T-SQL cell');
    const header = '# Fabric notebook source\n\n# METADATA ********************\n\n# META {\n# META   "kernel_info": {\n# META     "name": "sqldatawarehouse"\n# META   }\n# META }\n';
    const { client } = fakeClient([gitDefinition(header)]);
    await assert.rejects(
      downloadNotebook(client, root, 'w1', { id: 'n1', displayName: 'Endpoint Query' }, async () => true),
      /"Endpoint Query" is a T-SQL notebook \(notebook-content\.py; it runs T-SQL on a warehouse or SQL analytics endpoint\)/,
    );
    assert.strictEqual(text(notebookFiles(root, 'Endpoint Query').py), undefined);
  });

  test('a local T-SQL notebook is refused on upload', async () => {
    const tsql = PY.replace('# Fabric notebook source\n', '# Fabric notebook source\n\n# METADATA ********************\n\n# META {\n# META   "kernel_info": {\n# META     "name": "sqldatawarehouse"\n# META   }\n# META }\n');
    const files = notebookFiles(root, 'Report');
    await write(files.py, tsql);
    await assert.rejects(uploadNotebook(fakeClient([]).client, files, 'w1', async () => true), /"Report" is a T-SQL notebook/);
  });

  test('finds the project’s notebooks from either file, ignoring other files and folders', async () => {
    await write(notebookFiles(root, 'B Load').py, PY);
    await write(notebookFiles(root, 'A Only Ipynb').ipynb, IPYNB);
    await write(vscode.Uri.joinPath(root, 'src', 'Notebooks', 'Misnamed', 'other.py'), PY);
    await write(vscode.Uri.joinPath(root, 'src', 'Notebooks', 'stray.py'), PY);
    assert.deepStrictEqual((await listLocalNotebooks(root)).map((f) => f.name), ['A Only Ipynb', 'B Load']);
    assert.deepStrictEqual(await listLocalNotebooks(vscode.Uri.parse('fss-nb-test:/no-such-project')), []);
  });

  test('Download All: replaces or skips local copies as chosen, and carries on past a failing notebook', async () => {
    await write(notebookFiles(root, 'Kept').py, 'local edits');
    const definitionResponses = () => [gitDefinition(PY)];
    const notebooks = [
      { id: 'n1', displayName: 'Kept' },
      { id: 'n2', displayName: 'a:b' }, // Can't be a folder name: fails before any request.
      { id: 'n3', displayName: 'New' },
    ];
    const progress: string[] = [];
    const { client } = fakeClient(definitionResponses());
    const skip = await downloadNotebooks(client, root, 'w1', notebooks, false, {
      onProgress: (name, done, total) => progress.push(`${done}/${total} ${name}`),
    });
    assert.deepStrictEqual(skip.done, ['New']);
    assert.deepStrictEqual(skip.skipped, [{ name: 'Kept', reason: 'local copy kept' }]);
    assert.deepStrictEqual(skip.failed.map((f) => f.name), ['a:b']);
    assert.match(skip.failed[0].reason, /can't be saved as a folder/);
    assert.deepStrictEqual(progress, ['1/3 Kept', '2/3 a:b', '3/3 New']);
    assert.strictEqual(text(notebookFiles(root, 'Kept').py), 'local edits');

    const replace = await downloadNotebooks(fakeClient(definitionResponses()).client, root, 'w1', [notebooks[0]], true);
    assert.deepStrictEqual(replace.done, ['Kept']);
    assert.strictEqual(text(notebookFiles(root, 'Kept').py), PY);
  });

  test('Download All stops when cancelled', async () => {
    const result = await downloadNotebooks(fakeClient([]).client, root, 'w1', [{ id: 'n1', displayName: 'X' }], false, {
      isCancelled: () => true,
    });
    assert.deepStrictEqual(result, { done: [], skipped: [], failed: [], cancelled: true });
  });

  test('Upload All: plans overwrite vs create by name, skips what can’t be uploaded, then uploads the rest', async () => {
    await write(notebookFiles(root, 'Existing').py, PY);
    await write(notebookFiles(root, 'Brand New').py, PY);
    await write(notebookFiles(root, 'Plain Python').py, 'print("not a notebook")\n');
    const local = await listLocalNotebooks(root);
    const { client, calls } = fakeClient([
      json({ value: [{ id: 'n1', displayName: 'existing' }] }),
      json({ id: 'n9', displayName: 'Brand New' }, 201),
      new Response(null, { status: 200 }),
    ]);
    const plan = await planUploads(client, 'w1', local);
    assert.deepStrictEqual(
      plan.uploads.map((u) => [u.files.name, u.existing?.id]),
      [
        ['Brand New', undefined],
        ['Existing', 'n1'],
      ],
    );
    assert.deepStrictEqual(plan.skipped.map((s) => s.name), ['Plain Python']);
    assert.match(plan.skipped[0].reason, /isn't a Fabric notebook/);

    const result = await runUploads(client, 'w1', plan.uploads);
    assert.deepStrictEqual(result, { done: ['Brand New', 'Existing'], skipped: [], failed: [], cancelled: false });
    assert.deepStrictEqual(calls, [
      'GET /workspaces/w1/notebooks',
      'POST /workspaces/w1/notebooks',
      'POST /workspaces/w1/notebooks/n1/updateDefinition',
    ]);
  });

  test('Upload All carries on past a notebook Fabric rejects', async () => {
    await write(notebookFiles(root, 'One').py, PY);
    await write(notebookFiles(root, 'Two').py, PY);
    const uploads = (await listLocalNotebooks(root)).map((files) => ({ files, py: PY, existing: undefined }));
    const { client } = fakeClient([
      json({ errorCode: 'ItemDisplayNameAlreadyInUse', message: 'Name in use' }, 400),
      json({ id: 'n2', displayName: 'Two' }, 201),
    ]);
    const result = await runUploads(client, 'w1', uploads);
    assert.deepStrictEqual(result.done, ['Two']);
    assert.deepStrictEqual(result.failed, [{ name: 'One', reason: 'Name in use' }]);
  });

  test('the .py is the source of truth: a newer .py (e.g. after git discard or pull) regenerates the .ipynb', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.ipynb, IPYNB);
    await write(files.py, PY.replace('print("héllo")', 'print("from git")'));
    assert.strictEqual(await refreshIpynbIfStale(files), true);
    assert.deepStrictEqual(JSON.parse(text(files.ipynb)!).cells[0].source, ['print("from git")']);

    // Now the .ipynb is newer: nothing to do.
    assert.strictEqual(await refreshIpynbIfStale(files), false);

    // Git restores the original .py: the cell's earlier outputs are gone with the old .ipynb,
    // but the .ipynb follows the .py again.
    await write(files.py, PY);
    assert.strictEqual(await refreshIpynbIfStale(files), true);
    assert.deepStrictEqual(JSON.parse(text(files.ipynb)!).cells[0].source, ['print("héllo")']);
  });

  test('a fresh clone (a .py with no .ipynb) gets its .ipynb; a lone .ipynb or a plain .py is left alone', async () => {
    const files = notebookFiles(root, 'Cloned');
    await write(files.py, PY);
    assert.strictEqual(await refreshIpynbIfStale(files), true);
    assert.ok(isFabricIpynb(text(files.ipynb)!));

    const lone = notebookFiles(root, 'Lone');
    await write(lone.ipynb, IPYNB);
    assert.strictEqual(await refreshIpynbIfStale(lone), false);

    const plain = notebookFiles(root, 'Plain');
    await write(plain.py, 'print("not a notebook")\n');
    await assert.rejects(refreshIpynbIfStale(plain), NotFabricNotebookError);
    assert.strictEqual(text(plain.ipynb), undefined);
  });

  test('unchanged content isn’t rewritten, and the extension’s own writes are recognised', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    assert.strictEqual(await syncNotebookFiles(files, 'py'), true);
    assert.ok(wasWrittenByExtension(files.ipynb));
    assert.ok(!wasWrittenByExtension(files.py), 'the .py was written by the test, not the extension');

    const before = (await vscode.workspace.fs.stat(files.ipynb)).mtime;
    assert.strictEqual(await syncNotebookFiles(files, 'py'), false);
    assert.strictEqual((await vscode.workspace.fs.stat(files.ipynb)).mtime, before);
    assert.strictEqual(await syncNotebookFiles(files, 'ipynb'), false, 'the .py generated from the .ipynb is the same');
  });
});
