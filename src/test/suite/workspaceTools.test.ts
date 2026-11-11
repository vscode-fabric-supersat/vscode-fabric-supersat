// Speedups, diagnostics, sync state, workspace metadata, the format test and comparing with a workspace.
import * as assert from 'assert';
import * as vscode from 'vscode';
import { FabricClient, type Item, type Notebook } from '../../fabric/client';
import { checkNotebookFormats, firstJsonDifference, hasFailure, renderFormatReport, replaceIds } from '../../notebooks/formatTest';
import { ReferenceMapper } from '../../notebooks/references';
import { CANCELLED_ERROR, fetchNotebookSources, type RemoteNotebook, summarizeNotebook } from '../../notebooks/remote';
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
  forgetSync,
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
        recordRequest({ kind: 'request', method: 'POST', url: 'x', status: 202, ms: 100, inFlight: 12 });
        recordRequest({ kind: 'throttle', method: 'POST', url: 'x', ms: 5000, bucket: 'platform', reason: 'rate', ratePerSecond: 2.5, burst: 90 });
        recordRequest({ kind: 'throttle', method: 'POST', url: 'x', ms: 3000, bucket: 'platform', reason: 'rate', ratePerSecond: 1.25, burst: 45 });
        recordRequest({ kind: 'throttle', method: 'GET', url: 'x', ms: 10_000, bucket: 'operations', reason: 'capacity', ratePerSecond: 5, burst: 180 });
        recordRequest({ kind: 'request', method: 'POST', url: 'x', status: 429, ms: 100, attempt: 2, inFlight: 7 });
        recordRequest({ kind: 'operation', method: 'POST', url: 'x', ms: 5000, polls: 2, waitedMs: 4000 });
      },
      (_summary, text) => (line = text),
    );
    assert.match(
      line,
      /^Finished Download All Notebooks: 2 requests, 1 long-running operation, up to 12 at once, throttled by Fabric 2 times \(requests paused 8s, rate lowered to 1.25\/s\), Fabric capacity overloaded 1 time \(requests paused 10s\), 1 retried after throttling, \d+(\.\d)?s, of which 4s waiting on Fabric/,
    );
    assert.strictEqual(
      summaryLine({ name: 'X', ms: 372_000, requests: 74, operations: 37, waitedMs: 290_000, retries: 0 }),
      'X: 74 requests, 37 long-running operations, 6m12s, of which 4m50s waiting on Fabric (summed over concurrent requests)',
    );
  });
});

suite('Command log lines', () => {
  test('every command logs "Starting …" then "Finished …", with requests or just its duration', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    await withActivity('Select Workspace', async () => undefined, (_s, line) => log(line), log);
    await withActivity(
      'Delete All Notebooks',
      async () => recordRequest({ kind: 'request', method: 'DELETE', url: 'x', status: 200, ms: 5 }),
      (_s, line) => log(line),
      log,
    );
    assert.strictEqual(lines[0], 'Starting Select Workspace…');
    assert.match(lines[1], /^Finished Select Workspace: \d+(\.\d)?s$/);
    assert.strictEqual(lines[2], 'Starting Delete All Notebooks…');
    assert.match(lines[3], /^Finished Delete All Notebooks: 1 request, \d+(\.\d)?s$/);
    await flushDiagnostics();
  });

  test('a command that throws is logged as failed, and the error still reaches the caller', async () => {
    const lines: string[] = [];
    await assert.rejects(
      withActivity('Sign In to Fabric', async () => { throw new Error('nope'); }, (_s, line) => lines.push(line), (line) => lines.push(line)),
      /nope/,
    );
    assert.strictEqual(lines[0], 'Starting Sign In to Fabric…');
    assert.match(lines[1], /^Finished Sign In to Fabric \(failed\): \d+(\.\d)?s$/);
  });
});

suite('Overlapping commands', () => {
  test('requests count towards the latest command still running, whatever order commands finish in', async () => {
    const summaries: Record<string, number> = {};
    const report = (s: { name: string; requests: number }) => (summaries[s.name] = s.requests);
    const request = () => recordRequest({ kind: 'request', method: 'GET', url: 'x', status: 200, ms: 1 });
    let finishA!: () => void;
    let finishB!: () => void;
    const a = withActivity('A', () => new Promise<void>((r) => (finishA = r)).then(request), report);
    request(); // A
    const b = withActivity('B', () => new Promise<void>((r) => (finishB = r)).then(request), report);
    request(); // B, the latest running
    finishA(); // A's last request goes to B (still the latest running); then A finishes first.
    await a;
    request(); // B: A has finished
    finishB();
    await b;
    // With nothing running, requests count towards no command (not a finished one).
    request();
    assert.deepStrictEqual(summaries, { A: 1, B: 4 });
    await flushDiagnostics(); // Don't leave the queued lines for another test.
  });
});

suite('Fetching notebooks from Fabric', () => {
  const definition = (path: string, text: string) =>
    new Response(JSON.stringify({ definition: { parts: [{ path, payload: toBase64(new TextEncoder().encode(text)), payloadType: 'InlineBase64' }] } }));

  test('a notebook’s two exports are fetched at once, and the client’s limit caps the requests running', async () => {
    let running = 0;
    let most = 0;
    const client = new FabricClient({
      getToken: async () => 'tok',
      delay: async () => undefined,
      maxConcurrentRequests: 3,
      fetch: (async (input: RequestInfo | URL) => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return String(input).includes('format=ipynb') ? definition('notebook-content.ipynb', SCRATCH3_IPYNB) : definition('notebook-content.py', SCRATCH3_PY);
      }) as typeof fetch,
    });
    const notebooks = [notebook('a', 'A'), notebook('b', 'B'), notebook('c', 'C')];
    // Two notebooks at a time, two exports each: four requests would run, but the client allows three.
    const results = await fetchNotebookSources(client, 'w1', notebooks, { source: 'both', concurrency: 2 });
    assert.strictEqual(most, 3);
    assert.ok(results.every((r) => r.gitText === SCRATCH3_PY && r.ipynbText === SCRATCH3_IPYNB));
  });

  test('cancelling returns every notebook: those not reached are marked cancelled, not left out', async () => {
    let cancelled = false;
    const client = new FabricClient({
      getToken: async () => 'tok',
      delay: async () => undefined,
      fetch: (async () => {
        cancelled = true; // The user cancels while the first notebook is being fetched.
        return definition('notebook-content.py', SCRATCH3_PY);
      }) as typeof fetch,
    });
    const results = await fetchNotebookSources(client, 'w1', [notebook('a', 'A'), notebook('b', 'B')], { isCancelled: () => cancelled });
    assert.deepStrictEqual(
      results.map((r) => [r.notebook.displayName, r.gitText !== undefined, r.cancelled ?? false]),
      [['A', true, false], ['B', false, true]],
    );
    assert.strictEqual(results[1].error, CANCELLED_ERROR);
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
    // Line endings don't count (a local file may have CRLF on Windows).
    await recordSync(root, 'Sales (dev)', 'Multi', 'a\nb\n', 'download');
    const after = await readSyncState(root, 'Sales (dev)');
    assert.strictEqual(await changedSinceSync(after, 'Multi', 'a\r\nb\r\n'), false);
    assert.deepStrictEqual(await readSyncState(root, 'Other'), { notebooks: {} }, 'per workspace');
    assert.ok(text(vscode.Uri.joinPath(workspaceStateDir(root, 'Sales (dev)'), 'sync-state.json')));
  });

  test('sync state: changes made while a write is under way share the next write; none are lost', async () => {
    let writes = 0;
    const listener = memFs.onDidChangeFile((events) => {
      writes += events.filter((e) => e.uri.path.endsWith('/sync-state.json') && e.type !== vscode.FileChangeType.Deleted).length;
    });
    try {
      const names = Array.from({ length: 100 }, (_, i) => `NB ${String(i).padStart(3, '0')}`);
      await Promise.all(names.map((name) => recordSync(root, 'Bulk', name, name, 'download')));
      assert.ok(writes <= 3, `100 records took ${writes} writes`);
      assert.deepStrictEqual(Object.keys((await readSyncState(root, 'Bulk')).notebooks), names);

      // As Delete All does: each notebook forgotten as its DELETE returns, plus one never recorded.
      writes = 0;
      await Promise.all([...names.slice(1), 'Never recorded'].map((name) => forgetSync(root, 'Bulk', name.toLowerCase())));
      assert.ok(writes <= 3, `100 deletions took ${writes} writes`);
      assert.deepStrictEqual(Object.keys((await readSyncState(root, 'Bulk')).notebooks), [names[0]]);

      // Changes arriving one after another, each after the last write finished, each still write.
      writes = 0;
      await recordSync(root, 'Bulk', 'Late 1', 'x', 'upload');
      await recordSync(root, 'Bulk', 'Late 2', 'y', 'upload');
      assert.strictEqual(writes, 2);
      // Nothing to change: nothing written.
      writes = 0;
      await forgetSync(root, 'Bulk', 'Never recorded');
      assert.strictEqual(writes, 0);
    } finally {
      listener.dispose();
    }
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
          ['knownContent', 'pass'],
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
    assert.deepStrictEqual(tsql.checks.map((c) => c.status), ['pass', 'skip', 'skip', 'skip', 'skip', 'skip']);
    assert.match(tsql.checks[1].detail!, /T-SQL/);
    assert.strictEqual(tsql.language, 'T-SQL');

    // The two exports disagreeing about T-SQL is itself a failure.
    const disagree = await checkNotebookFormats(remote('Report', '-- Fabric notebook source\n', TSQL_NOTEBOOK_IPYNB, 'notebook-content.sql'));
    assert.strictEqual(disagree.checks[0].status, 'fail');
    assert.match(disagree.checks[0].detail!, /Download decides from the Git-format file/);
  });

  test('unknown header keys and cell types are reported as a warning', async () => {
    const py = SCRATCH3_PY.replace('# META   "kernel_info"', '# META   "future_key": 1,\n# META   "kernel_info"');
    const ipynb = JSON.stringify({ ...JSON.parse(SCRATCH3_IPYNB), cells: [...JSON.parse(SCRATCH3_IPYNB).cells, { cell_type: 'raw', source: 'x', metadata: {} }] });
    const result = await checkNotebookFormats(remote('Future', py, ipynb));
    const known = result.checks.find((c) => c.id === 'knownContent')!;
    assert.strictEqual(known.status, 'warn');
    assert.match(known.detail!, /Header keys in notebook-content\.py that aren't known.*: future_key\./);
    assert.match(known.detail!, /Cell types in the \.ipynb .*: raw \(1\)/);
    // Generating the .py from that .ipynb is refused (raw cell), which is a failure.
    assert.strictEqual(result.checks.find((c) => c.id === 'pyFromIpynb')?.status, 'fail');
  });

  test('uploading back to its own workspace: references check', async () => {
    const own = new ReferenceMapper(async () => [{ id: '00000000-0000-0000-0000-000000000009', displayName: 'WithoutSchema' }], '00000000-0000-0000-0000-000000000010');
    const result = await checkNotebookFormats(remote('Example', FABRIC_CICD_EXAMPLE_PY), own);
    assert.strictEqual(result.checks.find((c) => c.id === 'references')?.status, 'pass');
  });

  test('IDs in samples are replaced consistently; the "current workspace" zeros are kept', () => {
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
    assert.match(report, /^# Notebook format test: Sales \\\(dev\\\)/, 'the workspace name is shown as it is (escaped)');
    assert.match(report, /- Notebooks: 3\n- All checks passed: 1\n- With warnings: 0\n- With failures: 2/);
    assert.match(report, /\| Good \| PySpark \| ✅ \| ✅ \| ✅ \| ✅ \| – \|/);
    assert.match(report, /### Bad[\s\S]*❌ \*\*\.py generated from \.ipynb matches Fabric’s \.py\*\*/);
    assert.match(report, /### Gone\n\nNot fetched: 404 Not Found/);
  });

  test('a cancelled run: unchecked notebooks aren’t failures, and the report says it’s incomplete', async () => {
    const results = [
      await checkNotebookFormats(remote('Good', SCRATCH3_PY, SCRATCH3_IPYNB)),
      await checkNotebookFormats({ notebook: notebook('y', 'Later'), error: CANCELLED_ERROR, cancelled: true }),
    ];
    assert.ok(!hasFailure(results[1]));
    assert.strictEqual(results[1].cancelled, true);
    const report = renderFormatReport('Sales', '2026-11-15T00:00:00Z', results);
    assert.match(report, /- All checks passed: 1\n- With warnings: 0\n- With failures: 0\n- Not checked \(cancelled\): 1/);
    assert.match(report, /\*\*The run was cancelled\*\*: 1 of 2 notebooks weren't checked\. The samples from the previous run were kept/);
    assert.match(report, /\| Later \| – cancelled \|/);
    assert.doesNotMatch(report, /### Later/);
  });

  test('JSON differences name the path', () => {
    assert.strictEqual(firstJsonDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), undefined);
    assert.strictEqual(firstJsonDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), '$.a[1].b: Fabric has 2, generated has 3');
    assert.strictEqual(firstJsonDifference({ a: 1 }, {}), '$.a: Fabric has 1, generated has missing');
    // Fabric's .ipynb says "lakehouse": null where its .py (and so the generated .ipynb) leaves it out.
    assert.strictEqual(firstJsonDifference({ metadata: { dependencies: { lakehouse: null } } }, { metadata: { dependencies: {} } }), undefined);
    assert.strictEqual(firstJsonDifference({ metadata: { dependencies: null } }, { metadata: {} }), undefined);
    // Elsewhere, null and missing still differ.
    assert.strictEqual(firstJsonDifference({ cells: [{ execution_count: null }] }, { cells: [{}] }), '$.cells[0].execution_count: Fabric has null, generated has missing');
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
    const { metadata: m, notebooks } = await collectWorkspaceMetadata(client, { id: 'ws', name: 'Sales' }, {
      notebookDetails: true,
      memberRoles: true,
      concurrency: 4,
      account: 'me@contoso.com',
      local,
    });
    assert.deepStrictEqual(notebooks?.map((n) => n.notebook.displayName).sort(), ['Example', 'Fabric Only'], 'every notebook fetched is returned, for the cache');
    assert.deepStrictEqual(m.summary.itemTypes, [
      { type: 'Notebook', count: 2 },
      { type: 'Lakehouse', count: 1 },
      { type: 'Warehouse', count: 1 },
    ]);
    assert.deepStrictEqual(m.summary.notebookLanguages, [{ language: 'PySpark', count: 2 }]);
    assert.deepStrictEqual(m.summary.local, { Same: 1, Different: 0, 'Only in Fabric': 1, 'Not Supported': 0, 'Not Fetched': 0, 'Only Local': 1 });
    assert.deepStrictEqual(m.folders.map((f) => f.path), ['Bronze', 'Bronze/Loads']);
    const example = m.notebooks.find((n) => n.name === 'Example')!;
    assert.deepStrictEqual(example.defaultLakehouse, { id: '00000000-0000-0000-0000-000000000009', name: 'WithoutSchema', workspace: 'this workspace' });
    assert.strictEqual(example.folder, 'Bronze/Loads');
    assert.strictEqual(m.lakehouses[0].oneLakeTablesPath, 'abfss://tables');
    assert.deepStrictEqual(m.onlyLocal, ['Local Only']);
    assert.deepStrictEqual(m.unavailable.map((u) => u.section), ['Member roles']);
    assert.match(m.unavailable[0].reason, /Not allowed/);

    assert.strictEqual(m.notebooks.find((n) => n.name === 'Example')!.local, 'Same', 'statuses are title case in the .json too');
    const md = renderMetadataMarkdown(m, 'Sales.json');
    assert.match(md, /^# Sales\n\nFabric workspace information, refreshed .* as me@contoso\.com\./);
    assert.match(md, /run "Refresh Workspace Information" again to refresh it\. The same data is in Sales\.json\./);
    assert.match(md, /## Summary\n\n\| Item type \| Count \|\n\| --- \| --- \|\n\| Notebook \| 2 \|/);
    assert.match(md, /\| \*\*Total\*\* \| \*\*4\*\* \|/);
    assert.match(md, /\| Only in Fabric \| 1 \|/);
    assert.match(md, /\| Example \| Bronze\/Loads \| PySpark \|.*\| Same \|/);
    assert.match(md, /\| Local Only \|  \|  \|  \|  \| Only Local \|/, 'local-only notebooks are rows of the notebooks table');
    assert.doesNotMatch(md, /Only in `src\/Notebooks`/);
    assert.match(md, /SQL connection string:\n\n```\nx\.datawarehouse\.fabric\.microsoft\.com\n```/);
    assert.match(md, /Raw \\\| data/, 'pipes in cells are escaped');
    assert.match(md, /```csv\ntype,name,id\n/);
    assert.match(md, /## Not available\n\n\| Section \| Reason \|\n\| --- \| --- \|\n\| Member roles \|/);
  });

  test('without notebook details or member roles, no notebook content is fetched', async () => {
    const { metadata: m, notebooks } = await collectWorkspaceMetadata(client, { id: 'ws', name: 'Sales' }, { notebookDetails: false, memberRoles: false, concurrency: 2 });
    assert.strictEqual(notebooks, undefined, 'nothing to cache');
    assert.strictEqual(m.summary.notebookLanguages, undefined);
    assert.strictEqual(m.roles, undefined);
    assert.deepStrictEqual(m.unavailable, []);
    assert.strictEqual(m.notebooks[0].language, undefined);
  });

  test('cancelled while fetching notebook details: the summary says how many weren’t fetched', async () => {
    let calls = 0;
    const { metadata: m } = await collectWorkspaceMetadata(client, { id: 'ws', name: 'Sales' }, {
      notebookDetails: true,
      memberRoles: false,
      concurrency: 1,
      local,
      onProgress: (message) => (calls += message.startsWith('notebook ') ? 1 : 0),
      isCancelled: () => calls >= 1,
    });
    assert.strictEqual(m.summary.notebooksCancelled, 1);
    const cancelled = m.notebooks.find((n) => n.error === CANCELLED_ERROR);
    assert.ok(cancelled, 'the notebook not fetched is listed, with why');
    assert.strictEqual(cancelled.local, 'Not Fetched');
    assert.match(renderMetadataMarkdown(m), /\*\*Cancelled\*\*: details of 1 notebook weren't fetched\./);
  });

  test('without the item list, no notebook is called local-only and nothing is returned for the cache', async () => {
    const failing = new FabricClient({
      getToken: async () => 'tok',
      delay: async () => undefined,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const key = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
        const body = key === 'GET /v1/workspaces/ws/items' ? undefined : routes[key];
        return body === undefined
          ? new Response(JSON.stringify({ errorCode: 'InsufficientPrivileges', message: 'Not allowed' }), { status: 403 })
          : new Response(JSON.stringify(body), { status: 200 });
      }) as typeof fetch,
    });
    const { metadata: m, notebooks } = await collectWorkspaceMetadata(failing, { id: 'ws', name: 'Sales' }, {
      notebookDetails: true,
      memberRoles: false,
      concurrency: 2,
      local,
    });
    assert.ok(m.unavailable.some((u) => u.section === 'Items'));
    assert.strictEqual(m.onlyLocal, undefined);
    assert.strictEqual(notebooks, undefined);
  });

  test('compares as downloading would write the file ("current workspace" settings applied)', async () => {
    const workspaceId = '00000000-0000-0000-0000-000000000010';
    const fabric = remote('Example', FABRIC_CICD_EXAMPLE_PY);
    const zeros = FABRIC_CICD_EXAMPLE_PY.replace(workspaceId, '00000000-0000-0000-0000-000000000000');
    const files = (py: string) => ({ names: ['Example'], readPy: async () => py });
    assert.strictEqual(await compareWithLocal(fabric, files(FABRIC_CICD_EXAMPLE_PY), workspaceId), 'Same');
    // A local file with CRLF line endings (e.g. git on Windows) is still the same.
    assert.strictEqual(await compareWithLocal(fabric, files(FABRIC_CICD_EXAMPLE_PY.replace(/\n/g, '\r\n')), workspaceId), 'Same');
    assert.strictEqual(await compareWithLocal(fabric, files(zeros), workspaceId), 'Different');
    assert.strictEqual(await compareWithLocal(fabric, files(zeros), workspaceId, { defaultLakehouse: true, environment: false }), 'Same');
    assert.strictEqual(await compareWithLocal(fabric, { names: [], readPy: async () => undefined }, workspaceId), 'Only in Fabric');
    assert.strictEqual(await compareWithLocal({ notebook: notebook('x', 'X'), error: 'boom' }, files(''), workspaceId), 'Not Fetched');
    assert.strictEqual(await compareWithLocal(remote('S', '-- x', undefined, 'notebook-content.sql'), files(''), workspaceId), 'Not Supported');
  });
});
