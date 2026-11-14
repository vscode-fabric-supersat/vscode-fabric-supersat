// Speedups, diagnostics, sync state, workspace metadata, the format test and comparing with a workspace.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { FabricClient, type Item, type Notebook } from '../../fabric/client';
import { checkNotebookFormats, firstJsonDifference, hasFailure, renderFormatReport, replaceIds } from '../../notebooks/formatTest';
import { ReferenceMapper } from '../../notebooks/references';
import { type RemoteNotebook, summarizeNotebook } from '../../notebooks/remote';
import { toBase64 } from '../../util/base64';
import { mapLimit } from '../../util/concurrency';
import {
  appendCapped,
  flushDiagnostics,
  recordHistory,
  recordRequest,
  type RequestRecord,
  setDiagnosticsTarget,
  summaryLine,
  withActivity,
} from '../../util/diagnostics';
import { collectWorkspaceMetadata, compareWithLocal, renderMetadataMarkdown } from '../../workspace/metadata';
import {
  changedSinceSync,
  hashText,
  readSyncState,
  recordSync,
  workspaceFolderName,
  workspaceStateDir,
} from '../../workspace/state';
import {
  FABRIC_CICD_EXAMPLE_PY,
  SCRATCH2_TSQL_LAKEHOUSE_IPYNB,
  SCRATCH2_TSQL_LAKEHOUSE_PY,
  SCRATCH3_IPYNB,
  SCRATCH3_PY,
  TSQL_NOTEBOOK_IPYNB,
} from './fixtures/fabricSamples';
import { MemFs } from './memFs';

const notebook = (id: string, displayName: string): Notebook => ({ id, displayName, type: 'Notebook', workspaceId: 'w1' });
const remote = (name: string, gitText: string | undefined, ipynbText?: string, gitPath = 'notebook-content.py'): RemoteNotebook => ({
  notebook: notebook(`id-${name}`, name),
  gitPath,
  gitText,
  ipynbText,
});

suite('mapLimit', () => {
  test('runs at most `limit` at once and returns results in order', async () => {
    let running = 0;
    let most = 0;
    const results = await mapLimit([30, 10, 20, 5, 15], 2, async (ms, i) => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i * 10;
    });
    assert.deepStrictEqual(results, [0, 10, 20, 30, 40]);
    assert.strictEqual(most, 2);
  });

  test('skips items not yet started once cancelled', async () => {
    let cancelled = false;
    const results = await mapLimit([1, 2, 3, 4], 1, async (n) => {
      if (n === 2) {
        cancelled = true;
      }
      return n;
    }, () => cancelled);
    assert.deepStrictEqual(results, [1, 2, undefined, undefined]);
  });
});

suite('Fabric request diagnostics', () => {
  test('the client reports each request and each long-running operation, without tokens', async () => {
    const records: RequestRecord[] = [];
    const responses = [
      new Response(null, { status: 202, headers: { Location: 'https://api.fabric.microsoft.com/v1/operations/op1', 'Retry-After': '2' } }),
      new Response(JSON.stringify({ status: 'Succeeded' }), { status: 200 }),
    ];
    const client = new FabricClient({
      getToken: async () => 'secret-token',
      fetch: (async () => responses.shift()!) as typeof fetch,
      delay: async () => undefined,
      onRequest: (r) => records.push(r),
    });
    await client.updateNotebookDefinition('w1', 'n1', { parts: [] });
    assert.deepStrictEqual(
      records.map((r) => [r.kind, r.method, r.url, r.status, r.retryAfterMs, r.polls, r.waitedMs]),
      [
        ['request', 'POST', 'api.fabric.microsoft.com/v1/workspaces/w1/notebooks/n1/updateDefinition', 202, 2000, undefined, undefined],
        ['request', 'GET', 'api.fabric.microsoft.com/v1/operations/op1', 200, undefined, undefined, undefined],
        ['operation', 'POST', 'api.fabric.microsoft.com/v1/workspaces/w1/notebooks/n1/updateDefinition', undefined, undefined, 1, 2000],
      ],
    );
    assert.ok(!JSON.stringify(records).includes('secret-token'));
  });

  test('a command’s requests are summarised in one line', async () => {
    let line = '';
    await withActivity(
      'Download All Notebooks',
      async () => {
        recordRequest({ kind: 'request', method: 'POST', url: 'x', status: 202, ms: 100 });
        recordRequest({ kind: 'request', method: 'POST', url: 'x', status: 429, ms: 100, attempt: 2 });
        recordRequest({ kind: 'operation', method: 'POST', url: 'x', ms: 5000, polls: 2, waitedMs: 4000 });
      },
      (_summary, text) => (line = text),
    );
    assert.match(line, /^Download All Notebooks: 2 requests, 1 long-running operation, 1 retried after throttling, \d+(\.\d)?s, of which 4s waiting on Fabric/);
    assert.strictEqual(
      summaryLine({ name: 'X', ms: 372_000, requests: 74, operations: 37, waitedMs: 290_000, retries: 0 }),
      'X: 74 requests, 37 long-running operations, 6m12s, of which 4m50s waiting on Fabric (summed over concurrent requests)',
    );
  });
});

suite('Local diagnostic files, history and sync state', () => {
  const memFs = new MemFs();
  let registration: vscode.Disposable;
  let run = 0;
  let root: vscode.Uri;
  const text = (uri: vscode.Uri) => memFs.text(uri.path);

  suiteSetup(() => {
    registration = vscode.workspace.registerFileSystemProvider('fss-diag-test', memFs);
  });
  suiteTeardown(() => {
    setDiagnosticsTarget();
    registration.dispose();
  });
  setup(async () => {
    root = vscode.Uri.parse(`fss-diag-test:/project${++run}`);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.fabric-supersat'));
  });

  test('requests and history are appended as JSON lines in .fabric-supersat', async () => {
    const dir = vscode.Uri.joinPath(root, '.fabric-supersat');
    setDiagnosticsTarget(async () => dir);
    recordRequest({ kind: 'request', method: 'GET', url: 'api.fabric.microsoft.com/v1/workspaces', status: 200, ms: 42 });
    recordHistory({ action: 'upload', notebook: 'Load', workspace: 'Sales (dev)', result: 'updated', replaced: ['Lakehouse "Bronze": a → b'] });
    await flushDiagnostics();
    const request = JSON.parse(text(vscode.Uri.joinPath(dir, 'diagnostics', 'requests.jsonl'))!.trim());
    assert.strictEqual(request.url, 'api.fabric.microsoft.com/v1/workspaces');
    assert.ok(request.time);
    const history = JSON.parse(text(vscode.Uri.joinPath(dir, 'history.jsonl'))!.trim());
    assert.deepStrictEqual({ ...history, time: undefined }, {
      time: undefined,
      action: 'upload',
      notebook: 'Load',
      workspace: 'Sales (dev)',
      result: 'updated',
      replaced: ['Lakehouse "Bronze": a → b'],
    });
  });

  test('nothing is written without a target (no folder, untrusted, or logging off)', async () => {
    setDiagnosticsTarget(async () => undefined);
    recordRequest({ kind: 'request', method: 'GET', url: 'x', status: 200, ms: 1 });
    await flushDiagnostics();
    assert.strictEqual(text(vscode.Uri.joinPath(root, '.fabric-supersat', 'diagnostics', 'requests.jsonl')), undefined);
  });

  test('a file that would pass its cap is moved to <name>.1 and a new one started', async () => {
    const dir = vscode.Uri.joinPath(root, '.fabric-supersat');
    const file = vscode.Uri.joinPath(dir, 'logs', 'test.log');
    await appendCapped(dir, file, 'aaaaaaaaaa\n', 16);
    await appendCapped(dir, file, 'bbbb\n', 16);
    await appendCapped(dir, file, 'cccccccccc\n', 16);
    assert.strictEqual(text(file), 'cccccccccc\n');
    assert.strictEqual(text(file.with({ path: `${file.path}.1` })), 'aaaaaaaaaa\nbbbb\n');
  });

  test('sync state: notebooks changed since last synced with a workspace', async () => {
    await recordSync(root, 'Sales (dev)', 'Load', 'v1', 'download');
    await Promise.all([recordSync(root, 'Sales (dev)', 'B', 'b', 'upload'), recordSync(root, 'Sales (dev)', 'A', 'a', 'upload')]);
    const state = await readSyncState(root, 'Sales (dev)');
    assert.deepStrictEqual(Object.keys(state.notebooks), ['A', 'B', 'Load'], 'concurrent updates all kept, sorted');
    assert.strictEqual(state.notebooks.Load.hash, await hashText('v1'));
    assert.strictEqual(await changedSinceSync(state, 'Load', 'v1'), false);
    assert.strictEqual(await changedSinceSync(state, 'Load', 'v2'), true);
    assert.strictEqual(await changedSinceSync(state, 'Never synced', 'x'), true);
    assert.deepStrictEqual(await readSyncState(root, 'Other'), { notebooks: {} }, 'per workspace');
    assert.ok(text(vscode.Uri.joinPath(workspaceStateDir(root, 'Sales (dev)'), 'sync-state.json')));
  });

  test('workspace names become safe folder names', () => {
    assert.strictEqual(workspaceFolderName('Sales (dev)'), 'Sales (dev)');
    assert.strictEqual(workspaceFolderName('A/B: "C"?'), 'A%2FB%3A %22C%22%3F');
    assert.strictEqual(workspaceFolderName('100% done.'), '100%25 done%2E');
    assert.strictEqual(workspaceFolderName('..'), '.%2E');
  });
});

suite('Notebook summaries and the format test', () => {
  test('summarises a notebook’s language and references from its header', () => {
    assert.deepStrictEqual(summarizeNotebook('notebook-content.py', FABRIC_CICD_EXAMPLE_PY), {
      language: 'PySpark',
      kernel: 'synapse_pyspark',
      cells: 1,
      defaultLakehouse: {
        id: '00000000-0000-0000-0000-000000000009',
        name: 'WithoutSchema',
        workspaceId: '00000000-0000-0000-0000-000000000010',
      },
      otherLakehouses: [],
      environment: undefined,
      warehouses: [],
    });
    assert.strictEqual(summarizeNotebook('notebook-content.py', SCRATCH2_TSQL_LAKEHOUSE_PY).language, 'Python');
    assert.strictEqual(summarizeNotebook('notebook-content.sql', '-- Fabric notebook source\n').language, 'Spark SQL');
  });

  test('real Fabric exports pass every check', async () => {
    for (const [py, ipynb] of [
      [SCRATCH2_TSQL_LAKEHOUSE_PY, SCRATCH2_TSQL_LAKEHOUSE_IPYNB],
      [SCRATCH3_PY, SCRATCH3_IPYNB],
    ]) {
      const result = await checkNotebookFormats(remote('N', py, ipynb));
      assert.deepStrictEqual(
        result.checks.map((c) => [c.id, c.status]),
        [
          ['supported', 'pass'],
          ['pyRoundTrip', 'pass'],
          ['pyFromIpynb', 'pass'],
          ['ipynbFromPy', 'pass'],
          ['references', 'skip'],
        ],
      );
      assert.ok(!hasFailure(result));
    }
  });

  test('a mismatch fails with the first difference; a T-SQL notebook is skipped', async () => {
    const result = await checkNotebookFormats(remote('Mixed', SCRATCH3_PY, SCRATCH2_TSQL_LAKEHOUSE_IPYNB));
    const fromIpynb = result.checks.find((c) => c.id === 'pyFromIpynb')!;
    assert.strictEqual(fromIpynb.status, 'fail');
    assert.match(fromIpynb.detail!, /^First difference at line \d+/);
    assert.ok(hasFailure(result));

    const sqlHeader = '-- Fabric notebook source\n\n-- METADATA ********************\n\n-- META {\n-- META   "kernel_info": {\n-- META     "name": "sqldatawarehouse"\n-- META   }\n-- META }\n';
    const tsql = await checkNotebookFormats(remote('Report', sqlHeader, TSQL_NOTEBOOK_IPYNB, 'notebook-content.sql'));
    assert.deepStrictEqual(tsql.checks.map((c) => c.status), ['pass', 'skip', 'skip', 'skip', 'skip']);
    assert.match(tsql.checks[1].detail!, /T-SQL/);
    assert.strictEqual(tsql.language, 'T-SQL');

    // The two exports disagreeing about T-SQL is itself a failure.
    const disagree = await checkNotebookFormats(remote('Report', '-- Fabric notebook source\n', TSQL_NOTEBOOK_IPYNB, 'notebook-content.sql'));
    assert.strictEqual(disagree.checks[0].status, 'fail');
    assert.match(disagree.checks[0].detail!, /Download decides from the Git-format file/);
  });

  test('uploading back to its own workspace: references check', async () => {
    const own = new ReferenceMapper(async () => [{ id: '00000000-0000-0000-0000-000000000009', displayName: 'WithoutSchema' }], '00000000-0000-0000-0000-000000000010');
    const result = await checkNotebookFormats(remote('Example', FABRIC_CICD_EXAMPLE_PY), own);
    assert.strictEqual(result.checks.find((c) => c.id === 'references')?.status, 'pass');
  });

  test('IDs in samples are replaced consistently; the "same workspace" zeros are kept', () => {
    const a = 'x 6EFD09F3-db4a-492f-a66f-0b3690985ea9 y dff2733d-8f28-47e4-a50f-484472a0ce79 00000000-0000-0000-0000-000000000000';
    const b = '"6efd09f3-db4a-492f-a66f-0b3690985ea9"';
    assert.deepStrictEqual(replaceIds([a, b]), [
      'x 00000000-0000-0000-0000-000000000001 y 00000000-0000-0000-0000-000000000002 00000000-0000-0000-0000-000000000000',
      '"00000000-0000-0000-0000-000000000001"',
    ]);
  });

  test('the report summarises results and details each failure', async () => {
    const results = [
      await checkNotebookFormats(remote('Good', SCRATCH3_PY, SCRATCH3_IPYNB)),
      await checkNotebookFormats(remote('Bad', SCRATCH3_PY, SCRATCH2_TSQL_LAKEHOUSE_IPYNB)),
      await checkNotebookFormats({ notebook: notebook('x', 'Gone'), error: '404 Not Found' }),
    ];
    const report = renderFormatReport('Sales (dev)', '2026-11-14T00:00:00Z', results);
    assert.match(report, /^# Notebook format test: Sales \(dev\)/);
    assert.match(report, /- Notebooks: 3\n- All checks passed: 1\n- With warnings: 0\n- With failures: 2/);
    assert.match(report, /\| Good \| PySpark \| ✅ \| ✅ \| ✅ \| ✅ \| – \|/);
    assert.match(report, /### Bad[\s\S]*❌ \*\*\.py generated from \.ipynb matches Fabric’s \.py\*\*/);
    assert.match(report, /### Gone\n\nNot fetched: 404 Not Found/);
  });

  test('JSON differences name the path', () => {
    assert.strictEqual(firstJsonDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), undefined);
    assert.strictEqual(firstJsonDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), '$.a[1].b: Fabric has 2, generated has 3');
    assert.strictEqual(firstJsonDifference({ a: 1 }, {}), '$.a: Fabric has 1, generated has missing');
  });
});

suite('Workspace metadata and comparing with local notebooks', () => {
  const items: Item[] = [
    { id: 'nb1', displayName: 'Example', type: 'Notebook', workspaceId: 'ws', folderId: 'f2' },
    { id: 'nb2', displayName: 'Fabric Only', type: 'Notebook', workspaceId: 'ws' },
    { id: '00000000-0000-0000-0000-000000000009', displayName: 'WithoutSchema', type: 'Lakehouse', workspaceId: 'ws', description: 'Raw | data' },
    { id: 'wh1', displayName: 'Sales DW', type: 'Warehouse', workspaceId: 'ws' },
  ];
  /** Fabric's Git-format export (what metadata and compare fetch). */
  const definition = (py: string) => ({
    definition: { parts: [{ path: 'notebook-content.py', payload: toBase64(new TextEncoder().encode(py)), payloadType: 'InlineBase64' }] },
  });
  const routes: Record<string, unknown> = {
    'GET /v1/workspaces/ws': { id: 'ws', displayName: 'Sales', type: 'Workspace', capacityId: 'cap1' },
    'GET /v1/workspaces/ws/items': { value: items },
    'GET /v1/workspaces/ws/folders': { value: [{ id: 'f1', displayName: 'Bronze' }, { id: 'f2', displayName: 'Loads', parentFolderId: 'f1' }] },
    'GET /v1/workspaces/ws/lakehouses/00000000-0000-0000-0000-000000000009': {
      properties: { oneLakeTablesPath: 'abfss://tables', sqlEndpointProperties: { connectionString: 'x.datawarehouse.fabric.microsoft.com', id: 'sql1' } },
    },
    'GET /v1/workspaces/ws/lakehouses/00000000-0000-0000-0000-000000000009/tables': { value: [{ name: 'sales', type: 'Managed', format: 'Delta' }] },
    'GET /v1/workspaces/ws/warehouses': { value: [{ id: 'wh1', displayName: 'Sales DW', properties: { connectionString: 'dw.fabric.microsoft.com' } }] },
    'GET /v1/workspaces/ws/git/connection': { gitConnectionState: 'NotConnected' },
    'GET /v1/workspaces/ws/spark/settings': { pool: { starterPool: { maxNodeCount: 1 } } },
    'POST /v1/workspaces/ws/notebooks/nb1/getDefinition': definition(FABRIC_CICD_EXAMPLE_PY.replace('00000000-0000-0000-0000-000000000010', 'ws')),
    'POST /v1/workspaces/ws/notebooks/nb2/getDefinition': definition(SCRATCH3_PY),
  };
  const client = new FabricClient({
    getToken: async () => 'tok',
    delay: async () => undefined,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
      if (key === 'GET /v1/workspaces/ws/roleAssignments') {
        return new Response(JSON.stringify({ errorCode: 'InsufficientPrivileges', message: 'Not allowed' }), { status: 403 });
      }
      const body = routes[key];
      return body === undefined
        ? new Response(JSON.stringify({ message: `No route ${key}` }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch,
  });
  const local = {
    names: ['Example', 'Local Only'],
    readPy: async (name: string) => (name === 'Example' ? FABRIC_CICD_EXAMPLE_PY.replace('00000000-0000-0000-0000-000000000010', 'ws') : '# Fabric notebook source\n'),
  };

  test('collects every section, lists what was refused, and compares notebooks with local files', async () => {
    const m = await collectWorkspaceMetadata(client, { id: 'ws', name: 'Sales' }, {
      notebookDetails: true,
      memberRoles: true,
      concurrency: 4,
      account: 'me@contoso.com',
      local,
    });
    assert.deepStrictEqual(m.summary.itemTypes, [
      { type: 'Notebook', count: 2 },
      { type: 'Lakehouse', count: 1 },
      { type: 'Warehouse', count: 1 },
    ]);
    assert.deepStrictEqual(m.summary.notebookLanguages, [{ language: 'PySpark', count: 2 }]);
    assert.deepStrictEqual(m.summary.local, { same: 1, different: 0, 'only in Fabric': 1, 'not supported': 0, 'not fetched': 0, 'only local': 1 });
    assert.deepStrictEqual(m.folders.map((f) => f.path), ['Bronze', 'Bronze/Loads']);
    const example = m.notebooks.find((n) => n.name === 'Example')!;
    assert.deepStrictEqual(example.defaultLakehouse, { id: '00000000-0000-0000-0000-000000000009', name: 'WithoutSchema', workspace: 'this workspace' });
    assert.strictEqual(example.folder, 'Bronze/Loads');
    assert.strictEqual(m.lakehouses[0].oneLakeTablesPath, 'abfss://tables');
    assert.deepStrictEqual(m.onlyLocal, ['Local Only']);
    assert.deepStrictEqual(m.unavailable.map((u) => u.section), ['Member roles']);
    assert.match(m.unavailable[0].reason, /Not allowed/);

    const md = renderMetadataMarkdown(m);
    assert.match(md, /^# Sales\n\nFabric workspace metadata, downloaded .* as me@contoso\.com\./);
    assert.match(md, /## Summary\n\n\| Item type \| Count \|\n\| --- \| --- \|\n\| Notebook \| 2 \|/);
    assert.match(md, /\| \*\*Total\*\* \| \*\*4\*\* \|/);
    assert.match(md, /\| only in Fabric \| 1 \|/);
    assert.match(md, /SQL connection string:\n\n```\nx\.datawarehouse\.fabric\.microsoft\.com\n```/);
    assert.match(md, /Raw \\\| data/, 'pipes in cells are escaped');
    assert.match(md, /```csv\ntype,name,id\n/);
    assert.match(md, /## Not available\n\n\| Section \| Reason \|\n\| --- \| --- \|\n\| Member roles \|/);
  });

  test('without notebook details or member roles, no notebook content is fetched', async () => {
    const m = await collectWorkspaceMetadata(client, { id: 'ws', name: 'Sales' }, { notebookDetails: false, memberRoles: false, concurrency: 2 });
    assert.strictEqual(m.summary.notebookLanguages, undefined);
    assert.strictEqual(m.roles, undefined);
    assert.deepStrictEqual(m.unavailable, []);
    assert.strictEqual(m.notebooks[0].language, undefined);
  });

  test('compares as downloading would write the file ("same workspace" settings applied)', async () => {
    const workspaceId = '00000000-0000-0000-0000-000000000010';
    const fabric = remote('Example', FABRIC_CICD_EXAMPLE_PY);
    const zeros = FABRIC_CICD_EXAMPLE_PY.replace(workspaceId, '00000000-0000-0000-0000-000000000000');
    const files = (py: string) => ({ names: ['Example'], readPy: async () => py });
    assert.strictEqual(await compareWithLocal(fabric, files(FABRIC_CICD_EXAMPLE_PY), workspaceId), 'same');
    assert.strictEqual(await compareWithLocal(fabric, files(zeros), workspaceId), 'different');
    assert.strictEqual(await compareWithLocal(fabric, files(zeros), workspaceId, { defaultLakehouse: true, environment: false }), 'same');
    assert.strictEqual(await compareWithLocal(fabric, { names: [], readPy: async () => undefined }, workspaceId), 'only in Fabric');
    assert.strictEqual(await compareWithLocal({ notebook: notebook('x', 'X'), error: 'boom' }, files(''), workspaceId), 'not fetched');
    assert.strictEqual(await compareWithLocal(remote('S', '-- x', undefined, 'notebook-content.sql'), files(''), workspaceId), 'not supported');
  });
});
