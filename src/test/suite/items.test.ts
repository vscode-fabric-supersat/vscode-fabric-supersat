// What every kind of item shares (src/items/, and the item-generic parts of workspace/state.ts and
// workspace/metadata.ts): sync state by kind, comparing, deleting; and environments' content
// model (hash and comparison) on top of it.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { changedFiles, contentFiles, type EnvironmentFile, hashEnvironment } from '../../environments/definition';
import { environmentFiles, localEnvironments } from '../../environments/files';
import { FabricClient } from '../../fabric/client';
import { deleteItems } from '../../items/delete';
import { ITEM_KINDS } from '../../items/kinds';
import { compareContent, compareItemProperties } from '../../workspace/metadata';
import {
  changedSinceSync,
  forgetItemSync,
  itemChangedSinceSync,
  onDidRecordSync,
  readSyncState,
  recordItemSync,
  recordSync,
  type SyncRecorded,
  workspaceStateDir,
} from '../../workspace/state';
import { MemFs } from './memFs';

const encode = (text: string) => new TextEncoder().encode(text);
const file = (path: string, content: string | Uint8Array): EnvironmentFile => ({ path, bytes: typeof content === 'string' ? encode(content) : content });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A FabricClient whose fetch replays `responses`, recording "METHOD url". */
function fakeClient(responses: Response[]) {
  const calls: string[] = [];
  const client = new FabricClient({
    getToken: async () => 'tok',
    delay: async () => undefined,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input).replace('https://api.fabric.microsoft.com/v1', '')}`);
      const next = responses.shift();
      if (!next) {
        throw new Error(`Unexpected request: ${String(input)}`);
      }
      return next;
    }) as typeof fetch,
  });
  return { client, calls };
}

suite('Items: kinds, comparing and environment content', () => {
  test('each kind has its Fabric type, API path, src/ folder and sync state key', () => {
    assert.deepStrictEqual(
      Object.values(ITEM_KINDS).map((k) => [k.kind, k.fabricType, k.apiPath, k.sourceDir, k.stateKey]),
      [
        ['notebook', 'Notebook', 'notebooks', 'Notebooks', 'notebooks'],
        ['environment', 'Environment', 'environments', 'Environments', 'environments'],
      ],
    );
  });

  test('compareContent: not fetched, not supported, only in Fabric, same or different', () => {
    const same = (a: string, b: string) => a === b;
    assert.strictEqual(compareContent(undefined, 'x', 'x', same), 'Not Fetched');
    assert.strictEqual(compareContent({ error: 'boom' }, 'x', 'x', same), 'Not Fetched');
    assert.strictEqual(compareContent({ unsupported: 'T-SQL' }, 'x', 'x', same), 'Not Supported');
    assert.strictEqual(compareContent({}, undefined, 'x', same), 'Not Fetched');
    assert.strictEqual(compareContent({}, 'x', undefined, same), 'Only in Fabric');
    assert.strictEqual(compareContent({}, 'x', 'x', same), 'Same');
    assert.strictEqual(compareContent({}, 'x', 'y', same), 'Different');
  });

  test('environment content: text parts ignore line endings, binary parts don\'t; other files don\'t count', async () => {
    const fabric = [file('Setting/Sparkcompute.yml', 'a: 1\nb: 2\n'), file('Libraries/CustomLibraries/x.whl', Uint8Array.of(1, 13, 10))];
    const crlf = [file('Setting/Sparkcompute.yml', 'a: 1\r\nb: 2\r\n'), file('Libraries/CustomLibraries/x.whl', Uint8Array.of(1, 13, 10)), file('NOTES.md', 'mine')];
    assert.deepStrictEqual(changedFiles(fabric, crlf), []);
    assert.strictEqual(await hashEnvironment(fabric), await hashEnvironment(crlf));
    assert.deepStrictEqual(contentFiles(crlf).map((f) => f.path), ['Libraries/CustomLibraries/x.whl', 'Setting/Sparkcompute.yml']);
    const binary = [fabric[0], file('Libraries/CustomLibraries/x.whl', Uint8Array.of(1, 10))];
    assert.deepStrictEqual(changedFiles(fabric, binary), ['Libraries/CustomLibraries/x.whl'], 'a binary\'s bytes count, CR included');
    assert.notStrictEqual(await hashEnvironment(fabric), await hashEnvironment(binary));
    const moreAndLess = [file('Setting/Sparkcompute.yml', 'a: 1\nb: 3\n'), file('Libraries/PublicLibraries/environment.yml', 'dependencies: []\n')];
    assert.deepStrictEqual(changedFiles(fabric, moreAndLess), [
      'Libraries/CustomLibraries/x.whl',
      'Libraries/PublicLibraries/environment.yml',
      'Setting/Sparkcompute.yml',
    ]);
  });
});

suite('Items: sync state, local environments and deleting', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  const text = (uri: vscode.Uri) => memFs.text(uri.path);
  const write = async (uri: vscode.Uri, content: string) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encode(content));
  };
  const syncStateText = () => text(vscode.Uri.joinPath(workspaceStateDir(root, 'Sales'), 'sync-state.json'));

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-items-test', memFs);
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    root = vscode.Uri.parse(`fss-items-test:/project${++run}`);
    await write(vscode.Uri.joinPath(root, '.fabric-supersat', '.gitignore'), '*\n');
  });

  test('each kind has its own sync state; a notebook-only file keeps its shape', async () => {
    const events: SyncRecorded[] = [];
    const listener = onDidRecordSync((e) => events.push(e));
    try {
      await recordSync(root, 'Sales', 'Load', 'print(1)\r\n', 'download', 'n1');
      assert.deepStrictEqual(Object.keys(JSON.parse(syncStateText()!)), ['notebooks'], 'no environments key until there are some');
      await recordItemSync(root, 'Sales', 'environment', 'Load', 'hash-1', 'upload', 'e1');
      const state = await readSyncState(root, 'Sales');
      assert.deepStrictEqual(Object.keys(state.notebooks), ['Load']);
      assert.strictEqual(state.environments.Load.hash, 'hash-1');
      assert.strictEqual(await changedSinceSync(state, 'Load', 'print(1)\n'), false, 'notebooks compare as LF, as before');
      assert.strictEqual(itemChangedSinceSync(state, 'environment', 'Load', 'hash-1'), false);
      assert.strictEqual(itemChangedSinceSync(state, 'environment', 'Load', 'hash-2'), true);
      assert.strictEqual(itemChangedSinceSync(state, 'environment', 'Other', 'hash-1'), true, 'never synced');
      // Forgetting one kind leaves the other kind's item of the same name.
      await forgetItemSync(root, 'Sales', 'environment', 'load');
      const after = await readSyncState(root, 'Sales');
      assert.deepStrictEqual([Object.keys(after.notebooks), Object.keys(after.environments)], [['Load'], []]);
      assert.deepStrictEqual(
        events.map((e) => [e.kind, e.name, e.synced, e.itemId]),
        [
          ['notebook', 'Load', true, 'n1'],
          ['environment', 'Load', true, 'e1'],
          ['environment', 'load', false, undefined],
        ],
      );
    } finally {
      listener.dispose();
    }
  });

  test('local environments: names, content files and properties, for comparing with Fabric', async () => {
    const files = environmentFiles(root, 'Shared');
    await write(vscode.Uri.joinPath(files.folder, 'Setting', 'Sparkcompute.yml'), 'a: 1\n');
    await write(vscode.Uri.joinPath(files.folder, 'NOTES.md'), 'mine');
    await write(files.properties, 'description: "Here"\nfolder: "Shared"\n');
    const local = await localEnvironments(root);
    assert.deepStrictEqual(local.names, ['Shared']);
    assert.deepStrictEqual((await local.readFiles('Shared'))?.map((f) => f.path), ['Setting/Sparkcompute.yml']);
    assert.strictEqual(await local.readFiles('Missing'), undefined);
    const properties = await compareItemProperties('shared', { description: 'There', folder: '' }, local);
    assert.deepStrictEqual(
      properties.differences.map((d) => [d.property, d.local, d.fabric]),
      [
        ['description', 'Here', 'There'],
        ['folder', 'Shared', ''],
      ],
    );
  });

  test('deleteItems deletes through the kind\'s API, records history and forgets the sync state', async () => {
    await recordItemSync(root, 'Sales', 'environment', 'Shared', 'hash-1', 'download');
    const { client, calls } = fakeClient([new Response(null, { status: 200 }), json({ errorCode: 'ItemNotFound', message: 'Gone' }, 404)]);
    const tidied: string[] = [];
    const result = await deleteItems(client, 'w1', 'environment', [{ id: 'e1', displayName: 'Shared' }, { id: 'e2', displayName: 'Gone' }], {
      root,
      workspaceName: 'Sales',
      afterDelete: async (name) => {
        tidied.push(name);
      },
    });
    assert.deepStrictEqual(calls, ['DELETE /workspaces/w1/environments/e1', 'DELETE /workspaces/w1/environments/e2']);
    assert.deepStrictEqual(result.done, ['Shared']);
    assert.deepStrictEqual(result.failed.map((f) => f.name).concat(result.skipped.map((s) => s.name)), ['Gone']);
    assert.deepStrictEqual(tidied, ['Shared']);
    assert.deepStrictEqual((await readSyncState(root, 'Sales')).environments, {});
  });

  test('the client sends property updates and deletes to the kind\'s API', async () => {
    const { client, calls } = fakeClient([json({ id: 'e1', displayName: 'Shared' }), new Response(null, { status: 200 })]);
    await client.updateItem('w1', 'environment', 'e1', { description: 'New' });
    await client.deleteNotebook('w1', 'n1');
    assert.deepStrictEqual(calls, ['PATCH /workspaces/w1/environments/e1', 'DELETE /workspaces/w1/notebooks/n1']);
  });
});
