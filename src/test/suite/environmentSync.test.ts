// Comparing environments with a workspace, syncing them in both directions, and creating and
// deleting them (src/environments/compare.ts, the environment parts of Sync Workspace, and
// src/features/environmentTools.ts), against a fake Fabric API that answers by URL.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { compareEnvironments, compareOneEnvironment, planEnvironmentSync } from '../../environments/compare';
import { hashEnvironment } from '../../environments/definition';
import { environmentFiles, readEnvironmentFiles } from '../../environments/files';
import { FabricClient } from '../../fabric/client';
import { createEnvironment, deleteEnvironment } from '../../features/environmentTools';
import { runEnvironmentSync } from '../../features/workspaceSync';
import { toBase64 } from '../../util/base64';
import { readSyncState, recordItemSync } from '../../workspace/state';
import { DEFAULT_ENVIRONMENT_SPARK_COMPUTE, PUBLIC_LIBRARIES_ENVIRONMENT_YML } from './fixtures/fabricSamples';
import { MemFs } from './memFs';

const encode = (text: string) => new TextEncoder().encode(text);
const part = (path: string, text: string) => ({ path, payload: toBase64(encode(text)), payloadType: 'InlineBase64' });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

interface FakeEnvironment {
  id: string;
  displayName: string;
  description?: string;
  folderId?: string;
  parts?: { path: string; payload: string; payloadType: string }[];
  /** Answer getDefinition with this error status instead. */
  fails?: number;
}

/** A fake Fabric API for a workspace "w1" with `environments`, answering by URL; records "METHOD path". */
function fakeFabric(environments: FakeEnvironment[], options: { refuseDelete?: boolean } = {}) {
  const calls: string[] = [];
  const client = new FabricClient({
    getToken: async () => 'tok',
    delay: async () => undefined,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const path = String(input).replace('https://api.fabric.microsoft.com/v1', '');
      calls.push(`${method} ${path}`);
      const id = /\/environments\/([^/?]+)/.exec(path)?.[1];
      const env = environments.find((e) => e.id === id);
      if (method === 'GET' && path === '/workspaces/w1/items?type=Environment') {
        return json({ value: environments.map((e) => ({ id: e.id, displayName: e.displayName, description: e.description, folderId: e.folderId, type: 'Environment', workspaceId: 'w1' })) });
      }
      if (method === 'GET' && (path === '/workspaces/w1/folders' || path === '/workspaces/w1/spark/pools')) {
        return json({ value: [] });
      }
      if (method === 'POST' && path.endsWith('/getDefinition') && env) {
        return env.fails ? json({ errorCode: 'Boom', message: 'Fabric failed' }, env.fails) : json({ definition: { parts: env.parts ?? [] } });
      }
      if (method === 'POST' && path.endsWith('/updateDefinition')) {
        return new Response(null, { status: 200 });
      }
      if (method === 'POST' && path === '/workspaces/w1/environments') {
        return json({ id: 'new-id', displayName: JSON.parse(String(init?.body)).displayName }, 201);
      }
      if (method === 'DELETE' && env) {
        return options.refuseDelete ? json({ errorCode: 'InsufficientPrivileges', message: 'Not allowed' }, 403) : new Response(null, { status: 200 });
      }
      if (method === 'PATCH' && env) {
        return json({ id: env.id, displayName: env.displayName });
      }
      throw new Error(`Unexpected request: ${method} ${path}`);
    }) as typeof fetch,
  });
  return { client, calls };
}

suite('Environment compare and sync', () => {
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
  const settings = (name: string) => vscode.Uri.joinPath(environmentFiles(root, name).folder, 'Setting', 'Sparkcompute.yml');

  /** The workspace: "Same" (also local, CRLF), "Changed" (local differs), "Remote" (only in Fabric), "Broken" (can't be fetched). Local: also "Mine". */
  async function setUpBothSides(): Promise<FakeEnvironment[]> {
    await write(settings('Same'), DEFAULT_ENVIRONMENT_SPARK_COMPUTE.replace(/\n/g, '\r\n'));
    await write(settings('Changed'), DEFAULT_ENVIRONMENT_SPARK_COMPUTE.replace('max_executors: 9', 'max_executors: 4'));
    await write(settings('Mine'), DEFAULT_ENVIRONMENT_SPARK_COMPUTE);
    await write(settings('Broken'), DEFAULT_ENVIRONMENT_SPARK_COMPUTE);
    const parts = [part('Setting/Sparkcompute.yml', DEFAULT_ENVIRONMENT_SPARK_COMPUTE), part('.platform', '{}')];
    return [
      { id: 'e1', displayName: 'same', parts },
      { id: 'e2', displayName: 'Changed', description: 'Shared', parts },
      { id: 'e3', displayName: 'Remote', parts: [...parts, part('Libraries/PublicLibraries/environment.yml', PUBLIC_LIBRARIES_ENVIRONMENT_YML)] },
      { id: 'e4', displayName: 'Broken', fails: 500 },
    ];
  }

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-envsync-test', memFs);
  });
  suiteTeardown(() => registration.dispose());
  setup(async () => {
    root = vscode.Uri.parse(`fss-envsync-test:/project${++run}`);
    await write(vscode.Uri.joinPath(root, '.fabric-supersat', '.gitignore'), '*\n');
  });

  test('compares every environment: same (line endings aside), different, only in Fabric, only local, not fetched', async () => {
    const environments = await setUpBothSides();
    await recordItemSync(root, 'Sales', 'environment', 'Mine', 'old', 'upload');
    const { comparisons, cancelled } = await compareEnvironments(fakeFabric(environments).client, root, workspace);
    assert.strictEqual(cancelled, false);
    assert.deepStrictEqual(
      comparisons.map((c) => [c.name, c.status]),
      [
        ['Broken', 'Not Fetched'],
        ['Changed', 'Different'],
        ['Remote', 'Only in Fabric'],
        ['Same', 'Same'],
        ['Mine', 'Only Local'],
      ],
    );
    assert.deepStrictEqual(comparisons[1].properties?.differences.map((d) => [d.property, d.fabric, d.downloadOnly]), [['description', 'Shared', true]]);
    const state = await readSyncState(root, 'Sales');
    assert.deepStrictEqual(Object.keys(state.environments), ['Same'], 'the same one is recorded as synced; the local-only one forgotten');
    assert.strictEqual(state.environments.Same.hash, await hashEnvironment(await readEnvironmentFiles(environmentFiles(root, 'Same'))));
    // One environment alone: only its definition is fetched.
    const one = fakeFabric(environments);
    assert.strictEqual((await compareOneEnvironment(one.client, root, workspace, 'Changed')).status, 'Different');
    assert.deepStrictEqual(one.calls.filter((c) => c.includes('getDefinition')), ['POST /workspaces/w1/environments/e2/getDefinition']);
    assert.strictEqual((await compareOneEnvironment(one.client, root, workspace, 'Mine')).status, 'Only Local');
  });

  test('plans like notebooks in each direction; not fetched is left alone', async () => {
    const { comparisons } = await compareEnvironments(fakeFabric(await setUpBothSides()).client, root, workspace);
    const up = planEnvironmentSync('toWorkspace', comparisons);
    assert.deepStrictEqual(up.changes.map((c) => [c.name, c.action]), [['Changed', 'overwrite'], ['Mine', 'create'], ['Remote', 'delete']]);
    assert.deepStrictEqual(up.skipped.map((s) => s.name), ['Broken']);
    const down = planEnvironmentSync('toLocal', comparisons);
    assert.deepStrictEqual(down.changes.map((c) => [c.name, c.action]), [['Changed', 'overwrite'], ['Remote', 'create'], ['Mine', 'delete']]);
  });

  test('syncing to the workspace uploads, creates and deletes there; uploaded ones are listed for publishing', async () => {
    const environments = await setUpBothSides();
    const { comparisons } = await compareEnvironments(fakeFabric(environments).client, root, workspace);
    const plan = planEnvironmentSync('toWorkspace', comparisons);
    const { client, calls } = fakeFabric(environments);
    const result = await runEnvironmentSync(client, root, workspace, 'toWorkspace', plan.changes, comparisons);
    assert.deepStrictEqual(result.actions, { Changed: 'overwrite', Mine: 'create', Remote: 'delete' });
    assert.ok(calls.includes('POST /workspaces/w1/environments/e2/updateDefinition'));
    assert.ok(calls.includes('POST /workspaces/w1/environments'));
    assert.ok(calls.includes('DELETE /workspaces/w1/environments/e3'));
    assert.deepStrictEqual(result.uploaded.sort((a, b) => a.name.localeCompare(b.name)), [
      { id: 'e2', name: 'Changed' },
      { id: 'new-id', name: 'Mine' },
    ]);
    const state = await readSyncState(root, 'Sales');
    assert.deepStrictEqual(Object.keys(state.environments).sort(), ['Changed', 'Mine', 'Same']);
  });

  test('syncing to src/Environments downloads and deletes local folders', async () => {
    const environments = await setUpBothSides();
    const { comparisons } = await compareEnvironments(fakeFabric(environments).client, root, workspace);
    const plan = planEnvironmentSync('toLocal', comparisons);
    const result = await runEnvironmentSync(fakeFabric(environments).client, root, workspace, 'toLocal', plan.changes, comparisons);
    assert.deepStrictEqual(result.actions, { Changed: 'overwrite', Remote: 'create', Mine: 'delete' });
    assert.strictEqual(text(settings('Changed')), DEFAULT_ENVIRONMENT_SPARK_COMPUTE);
    assert.strictEqual(text(vscode.Uri.joinPath(environmentFiles(root, 'Remote').folder, 'Libraries', 'PublicLibraries', 'environment.yml')), PUBLIC_LIBRARIES_ENVIRONMENT_YML);
    assert.strictEqual(text(settings('Mine')), undefined);
    assert.deepStrictEqual(result.uploaded, []);
  });

  test('Create New Environment writes the default settings; an existing one is refused', async () => {
    const files = await createEnvironment(root, 'Fresh');
    assert.strictEqual(text(settings('Fresh')), DEFAULT_ENVIRONMENT_SPARK_COMPUTE, 'as Fabric makes a default environment');
    assert.strictEqual(text(files.properties), undefined, 'no <Name>.yaml until it has something to say');
    await assert.rejects(createEnvironment(root, 'Fresh'), /already exists/);
    await assert.rejects(createEnvironment(root, 'Bad:Name'), /can't be saved as a folder/);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('Delete Environment: Local Only, Workspace Only and Both; a refusal from Fabric leaves the local files', async () => {
    await write(settings('Old'), DEFAULT_ENVIRONMENT_SPARK_COMPUTE);
    const files = environmentFiles(root, 'Old');
    const remote = { id: 'e9', displayName: 'Old' };
    const refused = fakeFabric([{ ...remote }], { refuseDelete: true });
    const failed = await deleteEnvironment(refused.client, root, workspace, files, remote, 'Both');
    assert.match(failed.failed ?? '', /Not allowed/);
    assert.ok(text(settings('Old')), 'local files kept');

    await recordItemSync(root, 'Sales', 'environment', 'Old', 'h', 'download');
    const { client, calls } = fakeFabric([{ ...remote }]);
    const both = await deleteEnvironment(client, root, workspace, files, remote, 'Both');
    assert.deepStrictEqual(calls, ['DELETE /workspaces/w1/environments/e9']);
    assert.strictEqual(both.deletedFolder?.toString(), files.folder.toString());
    assert.strictEqual(text(settings('Old')), undefined);
    assert.deepStrictEqual((await readSyncState(root, 'Sales')).environments, {}, 'forgotten in the sync state');

    await write(settings('Old'), DEFAULT_ENVIRONMENT_SPARK_COMPUTE);
    const local = fakeFabric([]);
    await deleteEnvironment(local.client, root, workspace, files, undefined, 'Local Only');
    assert.deepStrictEqual(local.calls, []);
    assert.strictEqual(text(settings('Old')), undefined);
  });
});
