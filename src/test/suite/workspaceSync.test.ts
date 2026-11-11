// Sync Workspace: planning from comparisons, and syncing both ways against a fake Fabric.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { EXTENSION_FULL_ID } from '../../constants';
import { compareForSync, runSync } from '../../features/workspaceSync';
import { FabricClient } from '../../fabric/client';
import { notebookFiles, notebookPropertiesText } from '../../notebooks/files';
import { changesDescription } from '../../notebooks/transfer';
import { toBase64 } from '../../util/base64';
import { compareProperties, ONLY_LOCAL } from '../../workspace/metadata';
import { readNotebookCache } from '../../workspace/notebookCache';
import { readSyncState } from '../../workspace/state';
import { type NotebookComparison, planSync } from '../../workspace/sync';
import { MemFs } from './memFs';

const py = (code: string) => `# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# CELL ********************

${code}

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;
const SAME = py('print("same")');
const OLD = py('print("old")');
const NEW = py('print("new")');

const encode = (text: string) => new TextEncoder().encode(text);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface FakeNotebook {
  id: string;
  displayName: string;
  description?: string;
  folderId?: string;
  path?: string;
  text: string;
}

/** A FabricClient answering by URL (requests run at once, so not in a fixed order), recording "METHOD path". */
function fakeFabric(notebooks: FakeNotebook[], folders: { id: string; displayName: string }[] = []) {
  const calls: string[] = [];
  const client = new FabricClient({
    getToken: async () => 'tok',
    delay: async () => undefined,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = String(input).replace('https://api.fabric.microsoft.com/v1', '');
      calls.push(`${method} ${path}`);
      const definition = path.match(/^\/workspaces\/w1\/notebooks\/([^/]+)\/getDefinition$/);
      if (method === 'GET' && path === '/workspaces/w1/notebooks') {
        return json({
          value: notebooks.map(({ id, displayName, description, folderId }) => ({ id, displayName, description, folderId, type: 'Notebook', workspaceId: 'w1' })),
        });
      }
      if (method === 'GET' && path === '/workspaces/w1/folders') {
        return json({ value: folders });
      }
      if (method === 'POST' && definition) {
        const n = notebooks.find((x) => x.id === definition[1])!;
        return json({ definition: { parts: [{ path: n.path ?? 'notebook-content.py', payload: toBase64(encode(n.text)), payloadType: 'InlineBase64' }] } });
      }
      if (method === 'POST' && path === '/workspaces/w1/notebooks') {
        return json({ id: 'created', displayName: JSON.parse(String(init?.body)).displayName }, 201);
      }
      if (method === 'PATCH') {
        return json({});
      }
      if ((method === 'POST' && /\/(updateDefinition|move)$/.test(path)) || method === 'DELETE') {
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }) as typeof fetch,
  });
  return { client, calls };
}

suite('Sync Workspace: planning', () => {
  const comparisons: NotebookComparison[] = [
    { name: 'Changed', status: 'Different' },
    { name: 'Same', status: 'Same' },
    { name: 'Moved', status: 'Same', properties: [{ property: 'folder', local: 'Bronze', fabric: '', downloadOnly: false }] },
    { name: 'Described in Fabric', status: 'Same', properties: [{ property: 'description', fabric: 'Loads sales', downloadOnly: true }] },
    { name: 'Fabric Only', status: 'Only in Fabric' },
    { name: 'Local Only', status: ONLY_LOCAL },
    { name: 'Spark SQL', status: 'Not Supported', reason: 'Spark SQL notebooks aren’t supported yet.' },
    { name: 'Broken', status: 'Not Fetched', reason: 'HTTP 500' },
  ];

  test('to the workspace: uploads what differs or is only local, deletes what is only in Fabric', () => {
    const plan = planSync('toWorkspace', comparisons);
    assert.deepStrictEqual(
      plan.changes.map((c) => [c.name, c.action]),
      [
        ['Changed', 'overwrite'],
        ['Local Only', 'create'],
        ['Moved', 'properties'],
        ['Fabric Only', 'delete'],
      ],
    );
    assert.deepStrictEqual(plan.same, ['Described in Fabric', 'Same'], 'uploading can\'t change a description notebook.yaml doesn\'t set');
    assert.deepStrictEqual(
      plan.skipped.map((s) => s.name),
      ['Broken', 'Spark SQL'],
      'not supported or not fetched: left alone on both sides',
    );
    assert.match(plan.skipped[1].reason, /^not supported: Spark SQL/);
  });

  test('to src/: downloads what differs or is only in Fabric, deletes what is only local', () => {
    const plan = planSync('toLocal', comparisons);
    assert.deepStrictEqual(
      plan.changes.map((c) => [c.name, c.action]),
      [
        ['Changed', 'overwrite'],
        ['Fabric Only', 'create'],
        ['Described in Fabric', 'properties'],
        ['Moved', 'properties'],
        ['Local Only', 'delete'],
      ],
    );
    assert.deepStrictEqual(plan.same, ['Same']);
  });
});

suite('Sync Workspace: against Fabric', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  const workspace = { id: 'w1', name: 'Sales' };
  const text = (uri: vscode.Uri) => memFs.text(uri.path);
  const write = async (uri: vscode.Uri, content: string) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encode(content));
  };
  const remote = (): FakeNotebook[] => [
    { id: 'n-same', displayName: 'Same', text: SAME },
    { id: 'n-changed', displayName: 'Changed', text: NEW },
    { id: 'n-fabric', displayName: 'Fabric Only', text: SAME },
    { id: 'n-sql', displayName: 'Spark SQL', path: 'notebook-content.sql', text: '-- Fabric notebook source\n' },
  ];

  suiteSetup(async () => {
    registration = vscode.workspace.registerFileSystemProvider('fss-sync-test', memFs);
    await vscode.extensions.getExtension(EXTENSION_FULL_ID)?.activate();
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    root = vscode.Uri.parse(`fss-sync-test:/project${++run}`);
    await vscode.workspace.fs.createDirectory(root);
    await write(notebookFiles(root, 'Same').py, SAME);
    await write(notebookFiles(root, 'Changed').py, OLD);
    await write(notebookFiles(root, 'Local Only').py, SAME);
  });

  test('compares as Compare All does, caches what it fetched, and records notebooks found the same', async () => {
    const { client } = fakeFabric(remote());
    const { plan, cancelled } = await compareForSync(client, root, workspace, 'toWorkspace');
    assert.strictEqual(cancelled, false);
    assert.deepStrictEqual(
      plan.changes.map((c) => [c.name, c.status, c.action]),
      [
        ['Changed', 'Different', 'overwrite'],
        ['Local Only', ONLY_LOCAL, 'create'],
        ['Fabric Only', 'Only in Fabric', 'delete'],
      ],
    );
    assert.deepStrictEqual(plan.same, ['Same']);
    assert.deepStrictEqual(plan.skipped.map((s) => s.name), ['Spark SQL']);
    const cache = await readNotebookCache(root, 'Sales');
    assert.deepStrictEqual(cache?.notebooks.map((n) => n.name), ['Changed', 'Fabric Only', 'Same', 'Spark SQL']);
    assert.deepStrictEqual(Object.keys((await readSyncState(root, 'Sales')).notebooks), ['Same']);
  });

  test('cancelled while fetching: nothing is planned', async () => {
    const { client } = fakeFabric(remote());
    const result = await compareForSync(client, root, workspace, 'toWorkspace', { isCancelled: () => true });
    assert.strictEqual(result.cancelled, true);
    assert.deepStrictEqual(result.plan.changes, []);
  });

  test('to the workspace: overwrites, creates and deletes in Fabric; local files unchanged', async () => {
    const { client, calls } = fakeFabric(remote());
    const { plan, sources } = await compareForSync(client, root, workspace, 'toWorkspace');
    calls.length = 0;
    const result = await runSync(client, root, workspace, 'toWorkspace', plan.changes, sources);
    assert.deepStrictEqual(result.failed, []);
    assert.deepStrictEqual(result.actions, { Changed: 'overwrite', 'Local Only': 'create', 'Fabric Only': 'delete' });
    assert.ok(calls.includes('POST /workspaces/w1/notebooks/n-changed/updateDefinition'), calls.join('\n'));
    assert.ok(calls.includes('POST /workspaces/w1/notebooks'), 'creates the local-only notebook');
    assert.ok(calls.includes('DELETE /workspaces/w1/notebooks/n-fabric'));
    assert.ok(!calls.some((c) => c.includes('n-same') || c.includes('n-sql')), 'the same and unsupported notebooks are left alone');
    assert.strictEqual(text(notebookFiles(root, 'Changed').py), OLD);
    assert.ok(text(notebookFiles(root, 'Local Only').py));
  });

  test('to src/: replaces, downloads and deletes local files; Fabric unchanged', async () => {
    const { client, calls } = fakeFabric(remote());
    const { plan, sources } = await compareForSync(client, root, workspace, 'toLocal');
    assert.deepStrictEqual(
      plan.changes.map((c) => [c.name, c.action]),
      [
        ['Changed', 'overwrite'],
        ['Fabric Only', 'create'],
        ['Local Only', 'delete'],
      ],
    );
    calls.length = 0;
    const result = await runSync(client, root, workspace, 'toLocal', plan.changes, sources);
    assert.deepStrictEqual(result.failed, []);
    assert.deepStrictEqual(result.skipped, []);
    assert.deepStrictEqual(result.actions, { Changed: 'overwrite', 'Fabric Only': 'create', 'Local Only': 'delete' });
    assert.strictEqual(text(notebookFiles(root, 'Changed').py), NEW);
    assert.strictEqual(text(notebookFiles(root, 'Fabric Only').py), SAME);
    assert.ok(text(notebookFiles(root, 'Fabric Only').ipynb), 'its .ipynb is generated');
    assert.strictEqual(text(notebookFiles(root, 'Local Only').py), undefined);
    assert.strictEqual(text(notebookFiles(root, 'Same').py), SAME);
    assert.ok(!calls.some((c) => c.startsWith('DELETE') || c.endsWith('updateDefinition')), 'nothing changes in Fabric');
  });

  test('a notebook the same in content, but in another folder than its notebook.yaml names, is moved', async () => {
    await write(vscode.Uri.joinPath(root, 'src', 'Notebooks', 'Same', 'notebook.yaml'), 'folder: "Bronze"\n');
    const { client, calls } = fakeFabric(remote(), [{ id: 'f-bronze', displayName: 'Bronze' }]);
    const { plan, sources } = await compareForSync(client, root, workspace, 'toWorkspace');
    const same = plan.changes.find((c) => c.name === 'Same');
    assert.deepStrictEqual(same && [same.status, same.action], ['Same', 'properties']);
    calls.length = 0;
    await runSync(client, root, workspace, 'toWorkspace', [same!], sources);
    assert.ok(calls.includes('POST /workspaces/w1/items/n-same/move'), calls.join('\n'));
  });
  test('descriptions: notebook.yaml\'s is uploaded; Fabric\'s is downloaded into notebook.yaml', async () => {
    const yaml = vscode.Uri.joinPath(root, 'src', 'Notebooks', 'Same', 'notebook.yaml');
    await write(yaml, '# Mine\ndescription: "Local words"\n');
    const notebooks = remote().map((n) => (n.id === 'n-same' ? { ...n, description: 'Fabric words' } : n));

    const up = fakeFabric(notebooks);
    const toWorkspace = await compareForSync(up.client, root, workspace, 'toWorkspace');
    const same = toWorkspace.plan.changes.find((c) => c.name === 'Same');
    assert.deepStrictEqual(same?.action, 'properties');
    assert.deepStrictEqual(same?.properties, [{ property: 'description', local: 'Local words', fabric: 'Fabric words', downloadOnly: false }]);
    up.calls.length = 0;
    await runSync(up.client, root, workspace, 'toWorkspace', [same!], toWorkspace.sources);
    assert.ok(up.calls.includes('PATCH /workspaces/w1/notebooks/n-same'), up.calls.join('\n'));
    const cached = await readNotebookCache(root, 'Sales');
    assert.deepStrictEqual(cached?.notebooks.find((n) => n.name === 'Same')?.properties, { description: 'Local words', folder: '' }, 'the cache has the uploaded description');

    const down = fakeFabric(notebooks);
    const toLocal = await compareForSync(down.client, root, workspace, 'toLocal');
    const local = toLocal.plan.changes.find((c) => c.name === 'Same');
    assert.deepStrictEqual(local?.action, 'properties');
    await runSync(down.client, root, workspace, 'toLocal', [local!], toLocal.sources);
    assert.strictEqual(text(yaml), '# Mine\ndescription: "Fabric words"\n', 'comments kept');
  });

  test('a description or folder only in Fabric: only syncing to src/ writes it into notebook.yaml', async () => {
    const notebooks = remote().map((n) => (n.id === 'n-same' ? { ...n, description: 'Fabric words', folderId: 'f-gold' } : n));
    const folders = [{ id: 'f-gold', displayName: 'Gold' }];
    const up = await compareForSync(fakeFabric(notebooks, folders).client, root, workspace, 'toWorkspace');
    assert.ok(up.plan.same.includes('Same'), 'upload leaves properties notebook.yaml doesn\'t set alone');
    const { client } = fakeFabric(notebooks, folders);
    const down = await compareForSync(client, root, workspace, 'toLocal');
    const same = down.plan.changes.find((c) => c.name === 'Same');
    assert.deepStrictEqual(
      same?.properties?.map((p) => [p.property, p.fabric, p.downloadOnly]),
      [
        ['description', 'Fabric words', true],
        ['folder', 'Gold', true],
      ],
    );
    await runSync(client, root, workspace, 'toLocal', [same!], down.sources);
    const yaml = text(vscode.Uri.joinPath(root, 'src', 'Notebooks', 'Same', 'notebook.yaml')) ?? '';
    assert.match(yaml, /description: "Fabric words"/);
    assert.match(yaml, /folder: "Gold"/);
    const again = await compareForSync(fakeFabric(notebooks, folders).client, root, workspace, 'toLocal');
    assert.ok(again.plan.same.includes('Same'), 'in sync afterwards');
  });

  test('a notebook.yaml with a YAML error: properties aren\'t compared, and that is noted', async () => {
    await write(vscode.Uri.joinPath(root, 'src', 'Notebooks', 'Same', 'notebook.yaml'), 'description: [unclosed\n');
    const { plan } = await compareForSync(fakeFabric(remote()).client, root, workspace, 'toWorkspace');
    assert.ok(plan.same.includes('Same'));
    assert.deepStrictEqual(plan.propertyErrors?.map((e) => e.name), ['Same']);
  });
});

suite('Comparing descriptions and folders', () => {
  test('a value notebook.yaml sets differs if Fabric\'s isn\'t the same; one it doesn\'t set, only if download would write it', () => {
    assert.deepStrictEqual(compareProperties({ description: 'A', folder: 'Bronze/Ingest' }, { description: 'A', folder: 'bronze/ingest' }), [], 'folders ignore case');
    assert.deepStrictEqual(compareProperties({ description: '', folder: '' }, {}), [], 'nothing set, nothing in Fabric');
    assert.deepStrictEqual(compareProperties({ description: 'A', folder: '' }, { description: '' }), [
      { property: 'description', local: '', fabric: 'A', downloadOnly: false },
    ]);
    assert.deepStrictEqual(compareProperties({ description: 'A', folder: 'Gold' }, {}), [
      { property: 'description', local: undefined, fabric: 'A', downloadOnly: true },
      { property: 'folder', local: undefined, fabric: 'Gold', downloadOnly: true },
    ]);
    assert.deepStrictEqual(compareProperties({ description: '', folder: 'Gold' }, { folder: '' }), [
      { property: 'folder', local: '', fabric: 'Gold', downloadOnly: false },
    ]);
    assert.deepStrictEqual(compareProperties({ description: '' }, { folder: 'Gold' }), [], 'a folder not known isn\'t compared');
    assert.deepStrictEqual(compareProperties(undefined, { description: 'A' }), [], 'properties not known (an older cache) aren\'t compared');
  });

  test('notebook.yaml as download would write it, keeping comments', () => {
    const uri = vscode.Uri.parse('untitled:/notebook.yaml');
    assert.strictEqual(notebookPropertiesText(uri, undefined, { description: '', folder: '' }), undefined, 'no file for no properties');
    assert.strictEqual(
      notebookPropertiesText(uri, '# Mine\r\ndescription: "old" # note\r\n', { description: 'new', folder: 'Gold' }),
      '# Mine\r\ndescription: "new" # note\r\nfolder: "Gold"\r\n',
    );
    assert.match(notebookPropertiesText(uri, undefined, { description: 'A' }) ?? '', /^# Fabric notebook properties[\s\S]*description: "A"/);
  });

  test('Upload Changed counts a description that differs from Fabric\'s', () => {
    const existing = { id: 'n1', displayName: 'A', type: 'Notebook' as const, workspaceId: 'w1', description: 'old' };
    assert.strictEqual(changesDescription({ description: 'new', existing }), true);
    assert.strictEqual(changesDescription({ description: 'old', existing }), false);
    assert.strictEqual(changesDescription({ description: undefined, existing }), false, 'not set: left alone');
    assert.strictEqual(changesDescription({ description: '', existing: { ...existing, description: undefined } }), false);
    assert.strictEqual(changesDescription({ description: 'new', existing: undefined }), false, 'a new notebook is uploaded anyway');
  });
});
