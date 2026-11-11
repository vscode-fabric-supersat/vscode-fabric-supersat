// Environments as files (src/environments/): a definition's parts kept byte for byte below
// src/Environments/<Name>/, and downloading them, against a fake Fabric API.
import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  definitionFromFiles,
  differentParts,
  filesFromDefinition,
  hashEnvironment,
  instancePoolId,
  partPathProblem,
  undocumentedParts,
  uploadDefinition,
} from '../../environments/definition';
import { environmentFiles, listLocalEnvironments, NEW_ENVIRONMENT_PROPERTIES_FILE, readEnvironmentFiles } from '../../environments/files';
import { downloadEnvironment, downloadEnvironments, planEnvironmentUploads, uploadEnvironment } from '../../environments/transfer';
import { publishDetailsOf, publishEnvironment } from '../../environments/publish';
import { isWarning } from '../../util/errorFix';
import { FabricClient, type ItemDefinition } from '../../fabric/client';
import { toBase64 } from '../../util/base64';
import { DEFAULT_ENVIRONMENT_SPARK_COMPUTE, PUBLIC_LIBRARIES_ENVIRONMENT_YML } from './fixtures/fabricSamples';
import { MemFs } from './memFs';
import { readSyncState } from '../../workspace/state';

// Not a real export yet: the example content in Microsoft's Environment definition article
// (https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/environment-definition).
const SPARK_COMPUTE = `enable_native_execution_engine: false
instance_pool_id: 655fc33c-2712-45a3-864a-b2a00429a8aa
driver_cores: 4
driver_memory: 28g
executor_cores: 4
executor_memory: 28g
dynamic_executor_allocation:
  enabled: true
  min_executors: 1
  max_executors: 2
spark_conf:
  spark.acls.enable: true
runtime_version: 1.3
`;
const PUBLIC_LIBRARIES = `dependencies:
  - matplotlib==0.10.1
  - scipy==0.0.1
  - pip:
      - fuzzywuzzy==0.18.0
      - numpy==0.1.28
`;
/** A custom library's bytes: not text, so it must survive as-is (every byte value, and no UTF-8 decoding). */
const WHEEL = Uint8Array.from({ length: 256 }, (_, i) => i);

const encode = (text: string) => new TextEncoder().encode(text);
const part = (path: string, bytes: Uint8Array | string) => ({
  path,
  payload: toBase64(typeof bytes === 'string' ? encode(bytes) : bytes),
  payloadType: 'InlineBase64' as const,
});
const DEFINITION: ItemDefinition = {
  parts: [
    part('Libraries/CustomLibraries/shared-0.1-py3-none-any.whl', WHEEL),
    part('Libraries/PublicLibraries/environment.yml', PUBLIC_LIBRARIES),
    part('Setting/Sparkcompute.yml', SPARK_COMPUTE),
    part('.platform', '{"metadata":{"type":"Environment"}}'),
  ],
};
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

suite('Environment definitions', () => {
  test('every part but .platform becomes a file at its own path, byte for byte, and gives the definition back', () => {
    const files = filesFromDefinition('Shared', DEFINITION);
    assert.deepStrictEqual(
      files.map((f) => f.path),
      ['Libraries/CustomLibraries/shared-0.1-py3-none-any.whl', 'Libraries/PublicLibraries/environment.yml', 'Setting/Sparkcompute.yml'],
    );
    assert.deepStrictEqual([...files[0].bytes], [...WHEEL]);
    assert.deepStrictEqual(differentParts(DEFINITION, definitionFromFiles(files)), [], '.platform aside, the same parts');
    assert.deepStrictEqual(differentParts({ parts: [] }, { parts: [] }), []);
  });

  test('differentParts names parts that changed, or that only one side has', () => {
    const changed: ItemDefinition = { parts: [DEFINITION.parts[1], part('Setting/Sparkcompute.yml', SPARK_COMPUTE.replace('4', '8'))] };
    assert.deepStrictEqual(differentParts(DEFINITION, changed), [
      'Libraries/CustomLibraries/shared-0.1-py3-none-any.whl',
      'Setting/Sparkcompute.yml',
    ]);
  });

  test('part paths that would leave the folder, or replace <Name>.yaml, are refused', () => {
    assert.strictEqual(partPathProblem('Setting/Sparkcompute.yml', 'Shared'), undefined);
    for (const path of ['', '../x', 'Libraries/../../x', '/etc/x', 'C:/x', 'a\\b', 'a//b', './a', 'shared.yaml']) {
      assert.ok(partPathProblem(path, 'Shared'), path);
    }
    assert.throws(() => filesFromDefinition('Shared', { parts: [part('../escape', 'x')] }), /"\.\.\/escape"/);
    assert.throws(
      () => filesFromDefinition('Shared', { parts: [part('Setting/a.yml', 'x'), part('setting/A.yml', 'y')] }),
      /differ only in case/,
    );
  });

  test('parts Microsoft doesn\'t document are named, so a new kind of part shows in the log', () => {
    assert.deepStrictEqual(undocumentedParts(DEFINITION), []);
    assert.deepStrictEqual(
      undocumentedParts({ parts: [part('Libraries/CustomLibraries/lib.tar.gz', 'x'), part('Setting/Other.yml', 'x'), part('Libraries/CustomLibraries/x.zip', 'x')] }),
      ['Setting/Other.yml', 'Libraries/CustomLibraries/x.zip'],
    );
  });
});

suite('Environment download', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  const text = (uri: vscode.Uri) => memFs.text(uri.path);
  const write = async (uri: vscode.Uri, content: string) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, encode(content));
  };
  const environment = { id: 'e1', displayName: 'Shared', description: 'Shared libraries', folderId: undefined };

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-env-test', memFs);
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    root = vscode.Uri.parse(`fss-env-test:/project${++run}`);
    await vscode.workspace.fs.createDirectory(root);
    await write(vscode.Uri.joinPath(root, '.fabric-supersat', '.gitignore'), '*\n');
  });

  test('writes each part under src/Environments/<Name>/, and its description into <Name>.yaml', async () => {
    const { client, calls } = fakeClient([json({ definition: DEFINITION })]);
    const files = await downloadEnvironment(client, root, 'w1', environment, async () => true);
    assert.ok(files);
    assert.deepStrictEqual(calls, ['POST /workspaces/w1/environments/e1/getDefinition']);
    assert.strictEqual(text(vscode.Uri.joinPath(files.folder, 'Setting', 'Sparkcompute.yml')), SPARK_COMPUTE);
    assert.strictEqual(text(vscode.Uri.joinPath(files.folder, 'Libraries', 'PublicLibraries', 'environment.yml')), PUBLIC_LIBRARIES);
    const wheel = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(files.folder, 'Libraries', 'CustomLibraries', 'shared-0.1-py3-none-any.whl'));
    assert.deepStrictEqual([...wheel], [...WHEEL]);
    assert.strictEqual(text(vscode.Uri.joinPath(files.folder, '.platform')), undefined, '.platform isn\'t kept');
    assert.strictEqual(
      text(files.properties),
      NEW_ENVIRONMENT_PROPERTIES_FILE.replace('\ndescription: ""', '\ndescription: "Shared libraries"'),
    );
    assert.deepStrictEqual((await listLocalEnvironments(root)).map((e) => e.name), ['Shared']);
    assert.deepStrictEqual(
      (await readEnvironmentFiles(files)).map((f) => f.path).sort(),
      filesFromDefinition('Shared', DEFINITION).map((f) => f.path),
      '<Name>.yaml isn\'t one of the definition\'s files',
    );
  });

  test('a real default environment: only Sparkcompute.yml, written exactly; description in <Name>.yaml, no folder (root)', async () => {
    const definition = { parts: [part('Setting/Sparkcompute.yml', DEFAULT_ENVIRONMENT_SPARK_COMPUTE), part('.platform', '{}')] };
    assert.deepStrictEqual(undocumentedParts(definition), []);
    const { client } = fakeClient([json({ definition })]);
    const files = await downloadEnvironment(client, root, 'w1', { id: 'e1', displayName: 'en_new', description: 'Desc' }, async () => true);
    assert.ok(files);
    assert.deepStrictEqual((await readEnvironmentFiles(files)).map((f) => f.path), ['Setting/Sparkcompute.yml']);
    assert.strictEqual(text(vscode.Uri.joinPath(files.folder, 'Setting', 'Sparkcompute.yml')), DEFAULT_ENVIRONMENT_SPARK_COMPUTE);
    // As the user's real download wrote it.
    assert.strictEqual(text(files.properties), NEW_ENVIRONMENT_PROPERTIES_FILE.replace('\ndescription: ""', '\ndescription: "Desc"'));
  });

  test('a real environment with a public library and a custom .py: every part kept exactly; removing them in Fabric removes them locally', async () => {
    // custom.py's path is from the real sample; its content is a stand-in (it wasn't shared).
    const customPy = 'def greet():\r\n    return "hi"\r\n';
    const definition = {
      parts: [
        part('Libraries/CustomLibraries/custom.py', customPy),
        part('Libraries/PublicLibraries/environment.yml', PUBLIC_LIBRARIES_ENVIRONMENT_YML),
        part('Setting/Sparkcompute.yml', DEFAULT_ENVIRONMENT_SPARK_COMPUTE),
        part('.platform', '{}'),
      ],
    };
    assert.deepStrictEqual(undocumentedParts(definition), []);
    const environment = { id: 'e1', displayName: 'en_custom_public' };
    const first = fakeClient([json({ definition })]);
    const files = await downloadEnvironment(first.client, root, 'w1', environment, async () => true);
    assert.ok(files);
    assert.strictEqual(text(vscode.Uri.joinPath(files.folder, 'Libraries', 'PublicLibraries', 'environment.yml')), PUBLIC_LIBRARIES_ENVIRONMENT_YML);
    assert.strictEqual(text(vscode.Uri.joinPath(files.folder, 'Libraries', 'CustomLibraries', 'custom.py')), customPy, 'line endings kept too');
    // Back to the default environment in Fabric: the library files go.
    const second = fakeClient([json({ definition: { parts: [part('Setting/Sparkcompute.yml', DEFAULT_ENVIRONMENT_SPARK_COMPUTE)] } })]);
    await downloadEnvironment(second.client, root, 'w1', environment, async () => true);
    assert.deepStrictEqual((await readEnvironmentFiles(files)).map((f) => f.path), ['Setting/Sparkcompute.yml']);
  });

  test('a download with the workspace\'s name is recorded in its sync state, by the environment\'s content hash', async () => {
    const { client } = fakeClient([json({ definition: DEFINITION })]);
    const files = await downloadEnvironment(client, root, 'w1', environment, async () => true, { workspaceName: 'Sales' });
    assert.ok(files);
    const state = await readSyncState(root, 'Sales');
    assert.deepStrictEqual(Object.keys(state.environments), ['Shared']);
    assert.strictEqual(state.environments.Shared.hash, await hashEnvironment(await readEnvironmentFiles(files)));
    assert.strictEqual(state.environments.Shared.direction, 'download');
    assert.deepStrictEqual(state.notebooks, {});
  });

  test('downloading again removes part files Fabric no longer has, keeps other files, and asks first', async () => {
    const files = environmentFiles(root, 'Shared');
    await write(vscode.Uri.joinPath(files.folder, 'Libraries', 'CustomLibraries', 'old.whl'), 'old');
    await write(vscode.Uri.joinPath(files.folder, 'NOTES.md'), 'mine');
    await write(files.properties, '# my comment\ndescription: "old"\nfolder: "Shared"\n');

    const kept = fakeClient([]);
    assert.strictEqual(await downloadEnvironment(kept.client, root, 'w1', environment, async () => false), undefined);
    assert.deepStrictEqual(kept.calls, [], 'nothing fetched when the local copy is kept');

    const { client } = fakeClient([json({ definition: DEFINITION })]);
    await downloadEnvironment(client, root, 'w1', environment, async () => true);
    assert.strictEqual(text(vscode.Uri.joinPath(files.folder, 'Libraries', 'CustomLibraries', 'old.whl')), undefined);
    assert.strictEqual(text(vscode.Uri.joinPath(files.folder, 'NOTES.md')), 'mine');
    assert.strictEqual(text(files.properties), '# my comment\ndescription: "Shared libraries"\nfolder: ""\n', 'comments kept; now in the root');
  });

  test('Download All: one failure doesn\'t stop the rest; a name that can\'t be a folder is skipped', async () => {
    const { client } = fakeClient([json({ definition: DEFINITION }), json({ errorCode: 'ItemNotFound', message: 'Gone' }, 404)]);
    const result = await downloadEnvironments(client, root, 'w1', [
      environment,
      { id: 'e2', displayName: 'Gone' },
      { id: 'e3', displayName: 'Bad:Name' },
    ], true);
    assert.deepStrictEqual(result.done, ['Shared']);
    assert.deepStrictEqual(result.skipped.map((s) => s.name), ['Bad:Name']);
    assert.deepStrictEqual(result.failed.map((f) => f.name), ['Gone']);
  });
});

suite('Environment upload and publish', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  const write = async (uri: vscode.Uri, content: string | Uint8Array) => {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, typeof content === 'string' ? encode(content) : content);
  };
  const decodeParts = (definition: ItemDefinition) =>
    Object.fromEntries(definition.parts.map((p) => [p.path, new TextDecoder().decode(Uint8Array.from(atob(p.payload), (c) => c.charCodeAt(0)))]));
  const list = (value: unknown[]) => json({ value });
  const noFolders = () => list([]);

  /** A local environment as download writes it, with optional `<Name>.yaml` text. */
  async function localEnvironment(name: string, sparkCompute = DEFAULT_ENVIRONMENT_SPARK_COMPUTE, properties?: string) {
    const files = environmentFiles(root, name);
    await write(vscode.Uri.joinPath(files.folder, 'Setting', 'Sparkcompute.yml'), sparkCompute);
    if (properties !== undefined) {
      await write(files.properties, properties);
    }
    return files;
  }

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-envup-test', memFs);
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    root = vscode.Uri.parse(`fss-envup-test:/project${++run}`);
    await write(vscode.Uri.joinPath(root, '.fabric-supersat', '.gitignore'), '*\n');
  });

  test('what an upload sends: content files only, text parts with LF; binaries as they are', () => {
    const definition = uploadDefinition([
      { path: 'Setting/Sparkcompute.yml', bytes: encode('a: 1\r\nb: 2\r\n') },
      { path: 'Libraries/CustomLibraries/x.whl', bytes: Uint8Array.of(13, 10) },
      { path: 'NOTES.md', bytes: encode('mine') },
    ]);
    assert.deepStrictEqual(definition.parts.map((p) => p.path), ['Libraries/CustomLibraries/x.whl', 'Setting/Sparkcompute.yml']);
    assert.strictEqual(decodeParts(definition)['Setting/Sparkcompute.yml'], 'a: 1\nb: 2\n');
    assert.strictEqual(definition.parts[0].payload, toBase64(Uint8Array.of(13, 10)));
  });

  test('the pool named in Sparkcompute.yml, if any (none: the starter pool)', () => {
    const pool = (text: string) => instancePoolId([{ path: 'Setting/Sparkcompute.yml', bytes: encode(text) }]);
    assert.strictEqual(pool(DEFAULT_ENVIRONMENT_SPARK_COMPUTE), undefined);
    assert.strictEqual(pool(SPARK_COMPUTE), '655fc33c-2712-45a3-864a-b2a00429a8aa', 'Microsoft\'s example');
    assert.strictEqual(pool('instance_pool_id: "abc"  # mine\n'), 'abc');
    assert.strictEqual(pool('instance_pool_id: null\n'), undefined);
    assert.strictEqual(pool('spark_conf:\n  instance_pool_id: nested\n'), undefined, 'only the top-level key');
  });

  test('planning: finds the environment it replaces, notes a move and an unknown pool, skips what can\'t be uploaded', async () => {
    await localEnvironment('Shared', SPARK_COMPUTE, 'folder: "Libs"\ndescription: "New"\n');
    await localEnvironment('Fresh');
    await vscode.workspace.fs.createDirectory(environmentFiles(root, 'Empty').folder);
    await localEnvironment('Broken', DEFAULT_ENVIRONMENT_SPARK_COMPUTE, 'description: [unclosed\n');
    const { client, calls } = fakeClient([
      list([{ id: 'e1', displayName: 'shared', description: 'Old', type: 'Environment', workspaceId: 'w1' }]),
      list([{ id: 'other-pool', name: 'Big' }]),
      noFolders(),
    ]);
    const plan = await planEnvironmentUploads(client, 'w1', await listLocalEnvironments(root));
    assert.deepStrictEqual(calls.slice(0, 2), ['GET /workspaces/w1/items?type=Environment', 'GET /workspaces/w1/spark/pools']);
    assert.deepStrictEqual(plan.uploads.map((u) => [u.files.name, u.existing?.id]), [['Fresh', undefined], ['Shared', 'e1']]);
    const shared = plan.uploads[1];
    assert.deepStrictEqual(shared.moves, { from: '', to: 'Libs' });
    assert.strictEqual(shared.description, 'New');
    assert.match(shared.warning ?? '', /655fc33c.*isn't one of the workspace's custom pools/);
    assert.strictEqual(plan.uploads[0].warning, undefined, 'the starter pool needs no check');
    assert.deepStrictEqual(plan.skipped.map((s) => s.name), ['Broken', 'Empty']);
    assert.match(plan.skipped[1].reason, /nothing to upload/);
  });

  test('upload replaces an existing environment\'s definition, then its description and folder; recorded as synced', async () => {
    const files = await localEnvironment('Shared', DEFAULT_ENVIRONMENT_SPARK_COMPUTE.replace(/\n/g, '\r\n'), 'description: "New"\nfolder: ""\n');
    const planned = fakeClient([
      list([{ id: 'e1', displayName: 'Shared', description: 'Old', folderId: 'f1', type: 'Environment', workspaceId: 'w1' }]),
      list([]),
      list([{ id: 'f1', displayName: 'Libs' }]),
    ]);
    const [upload] = (await planEnvironmentUploads(planned.client, 'w1', [files])).uploads;
    const { client, calls, bodies } = fakeClientWithBodies([
      new Response(null, { status: 200 }),
      json({ id: 'e1', displayName: 'Shared' }),
      new Response(null, { status: 200 }),
    ]);
    const result = await uploadEnvironment(client, 'w1', upload, { workspaceName: 'Sales' });
    assert.deepStrictEqual(result, { result: 'updated', id: 'e1' });
    assert.deepStrictEqual(calls, [
      'POST /workspaces/w1/environments/e1/updateDefinition',
      'PATCH /workspaces/w1/environments/e1',
      'POST /workspaces/w1/items/e1/move',
    ]);
    const sent = (bodies[0] as { definition: ItemDefinition }).definition;
    assert.deepStrictEqual(decodeParts(sent), { 'Setting/Sparkcompute.yml': DEFAULT_ENVIRONMENT_SPARK_COMPUTE }, 'LF, as Fabric gave it');
    assert.deepStrictEqual(bodies[1], { description: 'New' });
    assert.deepStrictEqual(bodies[2], {}, 'to the workspace root');
    // Downloading the same content back counts as unchanged since the upload.
    const state = await readSyncState(root, 'Sales');
    assert.strictEqual(state.environments.Shared.direction, 'upload');
    assert.strictEqual(state.environments.Shared.hash, await hashEnvironment(filesFromDefinition('Shared', sent)));
  });

  test('upload creates a new environment with its definition, description and folder', async () => {
    const files = await localEnvironment('Fresh', DEFAULT_ENVIRONMENT_SPARK_COMPUTE, 'description: "Hi"\nfolder: "Libs"\n');
    const planned = fakeClient([list([]), list([])]);
    const [upload] = (await planEnvironmentUploads(planned.client, 'w1', [files])).uploads;
    const { client, calls, bodies } = fakeClientWithBodies([list([{ id: 'f1', displayName: 'Libs' }]), json({ id: 'e9', displayName: 'Fresh' }, 201)]);
    assert.deepStrictEqual(await uploadEnvironment(client, 'w1', upload), { result: 'created', id: 'e9' });
    assert.deepStrictEqual(calls, ['GET /workspaces/w1/folders', 'POST /workspaces/w1/environments']);
    const body = bodies[1] as { displayName: string; description: string; folderId: string; definition: ItemDefinition };
    assert.deepStrictEqual([body.displayName, body.description, body.folderId], ['Fresh', 'Hi', 'f1']);
    assert.deepStrictEqual(body.definition.parts.map((p) => p.path), ['Setting/Sparkcompute.yml']);
  });

  test('publish starts it without waiting on the operation, then watches the environment until this publish ends', async () => {
    const details = (state: string, startTime: string) => json({ id: 'e1', properties: { publishDetails: { state, startTime, componentPublishInfo: { sparkLibraries: { state } } } } });
    const { client, calls } = fakeClient([
      details('Success', '2026-11-25T10:00:00Z'),
      new Response(null, { status: 202, headers: { Location: 'https://api.fabric.microsoft.com/v1/operations/op1', 'Retry-After': '120' } }),
      details('Success', '2026-11-25T10:00:00Z'), // still the previous publish
      details('Running', '2026-11-26T09:00:00Z'),
      details('Success', '2026-11-26T09:00:00Z'),
    ]);
    const seen: string[] = [];
    const outcome = await publishEnvironment(client, 'w1', 'e1', 'Shared', { delay: async () => undefined, onState: (d) => seen.push(d.state ?? '') });
    assert.strictEqual(outcome.state, 'Success');
    assert.strictEqual(outcome.stoppedWatching, undefined);
    assert.deepStrictEqual(seen, ['Success', 'Running', 'Success']);
    assert.strictEqual(calls[1], 'POST /workspaces/w1/environments/e1/staging/publish?beta=false');
    assert.ok(!calls.some((c) => c.includes('/operations/')), 'the operation isn\'t followed');
    assert.deepStrictEqual(publishDetailsOf({ properties: { publishDetails: { state: 'Failed', componentPublishInfo: { sparkSettings: { state: 'Failed' } } } } }), {
      state: 'Failed',
      components: { sparkSettings: 'Failed' },
    });
  });

  test('publish: one already running is something to wait for; watching can be stopped', async () => {
    const running = fakeClient([json({ properties: { publishDetails: { state: 'Running', startTime: 't1' } } })]);
    await assert.rejects(publishEnvironment(running.client, 'w1', 'e1', 'Shared'), (err: Error) => isWarning(err) && /already being published/.test(err.message));
    const refused = fakeClient([
      json({ properties: {} }),
      json({ errorCode: 'InvalidEnvironmentPublish', message: 'failed due to error: Code = EnvironmentAnotherOngoingPublishProcess.' }, 400),
    ]);
    await assert.rejects(publishEnvironment(refused.client, 'w1', 'e1', 'Shared'), (err: Error) => isWarning(err) && /already being published/.test(err.message));
    const watched = fakeClient([json({ properties: {} }), new Response(null, { status: 202, headers: { Location: 'https://api.fabric.microsoft.com/v1/operations/op1' } })]);
    const outcome = await publishEnvironment(watched.client, 'w1', 'e1', 'Shared', { isCancelled: () => true, delay: async () => undefined });
    assert.strictEqual(outcome.stoppedWatching, 'cancelled');
  });
});

/** `fakeClient`, also recording request bodies. */
function fakeClientWithBodies(responses: Response[]) {
  const bodies: unknown[] = [];
  const calls: string[] = [];
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
