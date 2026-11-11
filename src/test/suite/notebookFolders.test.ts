// Workspace folders: folder paths in notebook.yaml, and download/upload placing notebooks in them, against a fake Fabric.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { FabricClient } from '../../fabric/client';
import { NEW_PROPERTIES_FILE, notebookFiles, readNotebookDescription, readNotebookFolder } from '../../notebooks/files';
import { folderPathsOf, parseFolderPath, sameFolderPath, WorkspaceFolders } from '../../notebooks/folders';
import { downloadNotebook, downloadNotebooks, movesNotebook, planUploads, runUploads, uploadNotebook } from '../../notebooks/transfer';
import { toBase64 } from '../../util/base64';
import { MemFs } from './memFs';

const PY = `# Fabric notebook source

# CELL ********************

print("hello")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
`;

const encode = (text: string) => new TextEncoder().encode(text);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const definition = () =>
  json({ definition: { parts: [{ path: 'notebook-content.py', payload: toBase64(encode(PY)), payloadType: 'InlineBase64' }] } });

/** Folders: Bronze (f1) > Ingest (f2), and Silver (f3). */
const FOLDERS = [
  { id: 'f1', displayName: 'Bronze' },
  { id: 'f2', displayName: 'Ingest', parentFolderId: 'f1' },
  { id: 'f3', displayName: 'Silver' },
];

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

/** A FabricClient that answers each "METHOD url" with its route, recording the requests. */
function routedClient(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const client = new FabricClient({
    getToken: async () => 'tok',
    delay: async () => undefined,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${String(input).replace('https://api.fabric.microsoft.com/v1', '')}`;
      calls.push(call);
      const route = routes[call];
      if (!route) {
        throw new Error(`Unexpected request: ${call}`);
      }
      return route();
    }) as typeof fetch,
  });
  return { client, calls };
}

suite('Notebook folders', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  const text = (uri: vscode.Uri) => memFs.text(uri.path);
  const write = async (uri: vscode.Uri, content: string) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encode(content));
  };

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-folder-test', memFs);
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    root = vscode.Uri.parse(`fss-folder-test:/project${++run}`);
    await vscode.workspace.fs.createDirectory(root);
  });

  test('folder paths: names joined by /, checked against Fabric’s folder name rules', () => {
    assert.deepStrictEqual(parseFolderPath(''), []);
    assert.deepStrictEqual(parseFolderPath('/'), []);
    assert.deepStrictEqual(parseFolderPath('/Bronze/Ingest/'), ['Bronze', 'Ingest']);
    assert.throws(() => parseFolderPath('Bronze//Ingest'), /empty folder name/);
    assert.throws(() => parseFolderPath('v1.2'), /character Fabric doesn't allow/);
    assert.throws(() => parseFolderPath('Bronze/ Ingest'), /starts or ends with a space/);
    assert.throws(() => parseFolderPath('Recycled'), /reserves/);
    assert.throws(() => parseFolderPath('x'.repeat(256)), /256 characters/);
    assert.doesNotThrow(() => parseFolderPath(Array(10).fill('a').join('/')));
    assert.throws(() => parseFolderPath(Array(11).fill('a').join('/')), /11 levels deep; Fabric allows at most 10/);
    assert.ok(sameFolderPath('bronze/ingest/', 'Bronze/Ingest'));
    assert.ok(!sameFolderPath('Bronze', ''));
    assert.deepStrictEqual([...folderPathsOf(FOLDERS)], [['f1', 'Bronze'], ['f2', 'Bronze/Ingest'], ['f3', 'Silver']]);
  });

  test('notebook.yaml folder: none leaves the notebook where it is; "" is the root; a bad path is refused', async () => {
    const files = notebookFiles(root, 'Load');
    assert.strictEqual(await readNotebookFolder(files), undefined);
    await write(files.properties, 'description: "x"\n');
    assert.strictEqual(await readNotebookFolder(files), undefined);
    await write(files.properties, 'folder: ""\n');
    assert.strictEqual(await readNotebookFolder(files), '');
    await write(files.properties, 'folder: "/Bronze/Ingest/"\n');
    assert.strictEqual(await readNotebookFolder(files), 'Bronze/Ingest');
    await write(files.properties, 'folder: "a:b"\n');
    await assert.rejects(readNotebookFolder(files), /notebook\.yaml.*"a:b"/);
    await write(files.properties, 'folder: [a]\n');
    await assert.rejects(readNotebookFolder(files), /should be text/);
  });

  test('download saves the notebook’s folder path in notebook.yaml, listing the folders once for Download All', async () => {
    const { client, calls } = fakeClient([definition(), json({ value: FOLDERS }), definition()]);
    const result = await downloadNotebooks(
      client,
      root,
      'w1',
      [
        { id: 'n1', displayName: 'Load', folderId: 'f2' },
        { id: 'n2', displayName: 'Clean', folderId: 'f3', description: 'Cleans' },
      ],
      true,
    );
    assert.deepStrictEqual(result.done, ['Load', 'Clean']);
    assert.strictEqual(calls.filter((c) => c.endsWith('/folders')).length, 1);
    const load = notebookFiles(root, 'Load');
    assert.strictEqual(text(load.properties), `${NEW_PROPERTIES_FILE}folder: "Bronze/Ingest"\n`);
    assert.strictEqual(await readNotebookDescription(load), '');
    assert.strictEqual(await readNotebookFolder(notebookFiles(root, 'Clean')), 'Silver');
  });

  test('download of a notebook in the root adds no folder, sends no folder request, and updates an existing folder to ""', async () => {
    const files = notebookFiles(root, 'Load');
    const first = fakeClient([definition()]);
    await downloadNotebook(first.client, root, 'w1', { id: 'n1', displayName: 'Load', description: 'D' }, async () => true);
    assert.deepStrictEqual(first.calls, ['POST /workspaces/w1/notebooks/n1/getDefinition']);
    assert.strictEqual(await readNotebookFolder(files), undefined);

    await write(files.properties, 'description: "D"\nfolder: "Old" # moved\n');
    await downloadNotebook(fakeClient([definition()]).client, root, 'w1', { id: 'n1', displayName: 'Load', description: 'D' }, async () => true);
    assert.strictEqual(text(files.properties), 'description: "D"\nfolder: "" # moved\n');
  });

  test('download still succeeds when the folders can’t be read, leaving notebook.yaml’s folder alone', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.properties, 'folder: "Mine"\n');
    const { client } = fakeClient([definition(), json({ errorCode: 'Forbidden', message: 'No' }, 403)]);
    assert.ok(await downloadNotebook(client, root, 'w1', { id: 'n1', displayName: 'Load', folderId: 'f9' }, async () => true));
    assert.strictEqual(await readNotebookFolder(files), 'Mine');
  });

  test('upload creates a new notebook in its folder, creating the missing folders first', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    await write(files.properties, 'folder: "bronze/Ingest/Daily"\n');
    const { client, calls, bodies } = fakeClient([
      json({ value: [] }),
      json({ value: FOLDERS.slice(0, 1) }),
      json({ id: 'f2', displayName: 'Ingest', parentFolderId: 'f1' }, 201),
      json({ id: 'f4', displayName: 'Daily', parentFolderId: 'f2' }, 201),
      json({ id: 'n9', displayName: 'Load' }, 201),
    ]);
    let placement: unknown;
    const result = await uploadNotebook(client, files, 'w1', async (_existing, p) => {
      placement = p;
      return true;
    });
    assert.strictEqual(result, 'created');
    assert.deepStrictEqual(placement, { to: 'bronze/Ingest/Daily', from: undefined });
    assert.deepStrictEqual(calls, [
      'GET /workspaces/w1/notebooks',
      'GET /workspaces/w1/folders',
      'POST /workspaces/w1/folders',
      'POST /workspaces/w1/folders',
      'POST /workspaces/w1/notebooks',
    ]);
    assert.deepStrictEqual(bodies[2], { displayName: 'Ingest', parentFolderId: 'f1' }, 'Bronze matched ignoring case');
    assert.deepStrictEqual(bodies[3], { displayName: 'Daily', parentFolderId: 'f2' });
    assert.strictEqual((bodies[4] as { folderId?: string }).folderId, 'f4');
  });

  test('upload moves an existing notebook only when it’s in another folder; no folder in notebook.yaml sends no folder request', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    const upload = async (fabricFolder: string | undefined, responses: Response[]) => {
      const fake = fakeClient([json({ value: [{ id: 'n1', displayName: 'Load', folderId: fabricFolder }] }), ...responses]);
      let placement: unknown;
      assert.strictEqual(
        await uploadNotebook(fake.client, files, 'w1', async (_e, p) => {
          placement = p;
          return true;
        }),
        'updated',
      );
      return { ...fake, placement };
    };

    const none = await upload('f3', [new Response(null, { status: 200 })]);
    assert.deepStrictEqual(none.calls.slice(1), ['POST /workspaces/w1/notebooks/n1/updateDefinition']);
    assert.strictEqual(none.placement, undefined);

    await write(files.properties, 'folder: "Bronze/Ingest"\n');
    const moved = await upload('f3', [json({ value: FOLDERS }), new Response(null, { status: 200 }), json({ value: [] })]);
    assert.deepStrictEqual(moved.placement, { to: 'Bronze/Ingest', from: 'Silver' });
    assert.ok(movesNotebook(moved.placement as never));
    assert.deepStrictEqual(moved.calls.slice(1), [
      'GET /workspaces/w1/folders',
      'POST /workspaces/w1/notebooks/n1/updateDefinition',
      'POST /workspaces/w1/items/n1/move',
    ]);
    assert.deepStrictEqual(moved.bodies[3], { targetFolderId: 'f2' });

    const already = await upload('F2', [json({ value: FOLDERS }), new Response(null, { status: 200 })]);
    assert.ok(!movesNotebook(already.placement as never));
    assert.strictEqual(already.calls.length, 3, 'already there: no move');

    await write(files.properties, 'folder: ""\n');
    const toRoot = await upload('f3', [json({ value: FOLDERS }), new Response(null, { status: 200 }), json({ value: [] })]);
    assert.deepStrictEqual(toRoot.calls.at(-1), 'POST /workspaces/w1/items/n1/move');
    assert.deepStrictEqual(toRoot.bodies.at(-1), {});
  });

  test('a folder that can’t be created stops the upload before the notebook changes', async () => {
    const files = notebookFiles(root, 'Load');
    await write(files.py, PY);
    await write(files.properties, 'folder: "New"\n');
    const { client, calls } = fakeClient([
      json({ value: [{ id: 'n1', displayName: 'Load' }] }),
      json({ value: [] }),
      json({ errorCode: 'TooManyFolders', message: 'Too many folders' }, 400),
    ]);
    await assert.rejects(uploadNotebook(client, files, 'w1', async () => true), /Too many folders/);
    assert.ok(!calls.some((c) => c.includes('updateDefinition')));
  });

  test('Upload All: plans where each notebook goes, and creates a shared folder once for notebooks uploaded together', async () => {
    for (const name of ['A', 'B', 'C']) {
      await write(notebookFiles(root, name).py, PY);
    }
    await write(notebookFiles(root, 'A').properties, 'folder: "Gold"\n');
    await write(notebookFiles(root, 'B').properties, 'folder: "Gold"\n');
    const local = [notebookFiles(root, 'A'), notebookFiles(root, 'B'), notebookFiles(root, 'C')];
    const planned = fakeClient([json({ value: [{ id: 'nb', displayName: 'B', folderId: 'f3' }] }), json({ value: FOLDERS })]);
    const plan = await planUploads(planned.client, 'w1', local);
    assert.deepStrictEqual(
      plan.uploads.map((u) => [u.files.name, u.placement]),
      [
        ['A', { to: 'Gold', from: undefined }],
        ['B', { to: 'Gold', from: 'Silver' }],
        ['C', undefined],
      ],
    );

    // Uploaded at once, so answered by request rather than in order.
    const { client, calls } = routedClient({
      'GET /workspaces/w1/folders': () => json({ value: FOLDERS }),
      'POST /workspaces/w1/folders': () => json({ id: 'f5', displayName: 'Gold' }, 201),
      'POST /workspaces/w1/notebooks': () => json({ id: 'new', displayName: 'New' }, 201),
      'POST /workspaces/w1/notebooks/nb/updateDefinition': () => new Response(null, { status: 200 }),
      'POST /workspaces/w1/items/nb/move': () => json({ value: [] }),
    });
    const result = await runUploads(client, 'w1', plan.uploads, { concurrency: 3 });
    assert.deepStrictEqual(result.done, ['A', 'B', 'C']);
    assert.strictEqual(calls.filter((c) => c === 'POST /workspaces/w1/folders').length, 1);
    assert.strictEqual(calls.filter((c) => c === 'GET /workspaces/w1/folders').length, 1);
    assert.ok(calls.includes('POST /workspaces/w1/items/nb/move'));
  });

  test('WorkspaceFolders lists again after a failed listing', async () => {
    const { client, calls } = fakeClient([json({ errorCode: 'Boom', message: 'Boom' }, 400), json({ value: FOLDERS })]);
    const folders = new WorkspaceFolders(client, 'w1');
    await assert.rejects(folders.pathOf('f1'), /Boom/);
    assert.strictEqual(await folders.pathOf('f2'), 'Bronze/Ingest');
    assert.strictEqual(await folders.pathOf(undefined), '');
    await assert.rejects(folders.pathOf('gone'), /didn't list the folder/);
    assert.strictEqual(calls.length, 2);
  });
});
