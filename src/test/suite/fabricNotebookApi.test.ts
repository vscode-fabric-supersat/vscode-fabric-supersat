// Offline tests for the notebook definition endpoints and long-running operations (fetch is faked).
import * as assert from 'assert';
import { FabricApiError, FabricClient, type ItemDefinition, isDefinitionRequest, requestBucket } from '../../fabric/client';
import type { RequestRecord } from '../../util/diagnostics';

const BASE = 'https://api.fabric.microsoft.com/v1';
const OP = `${BASE}/operations/op1`;

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const accepted = (retryAfter = '3') =>
  new Response(null, { status: 202, headers: { Location: OP, 'x-ms-operation-id': 'op1', 'Retry-After': retryAfter } });

function client(responses: Response[]) {
  const calls: Call[] = [];
  const delays: number[] = [];
  const c = new FabricClient({
    getToken: async () => 'tok',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const next = responses.shift();
      if (!next) {
        throw new Error(`Unexpected request: ${String(input)}`);
      }
      return next;
    }) as typeof fetch,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  return { c, calls, delays };
}

const definition: ItemDefinition = {
  parts: [{ path: 'notebook-content.py', payload: 'eA==', payloadType: 'InlineBase64' }],
};

suite('FabricClient: notebook definitions', () => {
  test('getDefinition answered directly (200)', async () => {
    const { c, calls } = client([json({ definition })]);
    assert.deepStrictEqual(await c.getNotebookDefinition('w1', 'n1'), definition);
    assert.deepStrictEqual(calls, [{ method: 'POST', url: `${BASE}/workspaces/w1/notebooks/n1/getDefinition` }]);
  });

  test('getDefinition as a long-running operation: polls, then fetches the result', async () => {
    const { c, calls, delays } = client([
      accepted('3'),
      json({ status: 'Running' }, 200, { 'Retry-After': '2' }),
      // On success, Location points to the result (Microsoft's LRO docs).
      json({ status: 'Succeeded' }, 200, { Location: `${OP}/result` }),
      json({ definition }),
    ]);
    assert.deepStrictEqual(await c.getNotebookDefinition('w1', 'n1', 'ipynb'), definition);
    assert.deepStrictEqual(
      calls.map((x) => `${x.method} ${x.url}`),
      [
        `POST ${BASE}/workspaces/w1/notebooks/n1/getDefinition?format=ipynb`,
        `GET ${OP}`,
        `GET ${OP}`,
        `GET ${OP}/result`,
      ],
    );
    assert.deepStrictEqual(delays, [2000, 2000]);
  });

  test('status checks start 2s after the 202, then wait twice as long each time, never longer than Retry-After', async () => {
    const running = () => json({ status: 'Running' }, 200, { 'Retry-After': '20' });
    const { c, delays } = client([
      accepted('20'),
      running(),
      running(),
      running(),
      running(),
      json({ status: 'Succeeded' }),
    ]);
    await c.updateNotebookDefinition('w1', 'n1', definition);
    assert.deepStrictEqual(delays, [2000, 4000, 8000, 16_000, 20_000]);
    // Retry-After shorter than the first check is honoured; zero still waits a second.
    const short = client([accepted('1'), json({ status: 'Running' }, 200, { 'Retry-After': '0' }), json({ status: 'Succeeded' })]);
    await short.c.updateNotebookDefinition('w1', 'n1', definition);
    assert.deepStrictEqual(short.delays, [1000, 1000]);
  });

  test('without Retry-After, status checks keep doubling from 2s, up to 60s apart', async () => {
    const running = () => json({ status: 'Running' });
    const { c, delays } = client([accepted('20'), ...Array.from({ length: 7 }, running), json({ status: 'Succeeded' })]);
    await c.updateNotebookDefinition('w1', 'n1', definition);
    assert.deepStrictEqual(delays, [2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    // A 202 without Retry-After still gets its first check after 2s.
    const bare = client([new Response(null, { status: 202, headers: { Location: OP } }), json({ status: 'Succeeded' })]);
    await bare.c.updateNotebookDefinition('w1', 'n1', definition);
    assert.deepStrictEqual(bare.delays, [2000]);
  });

  test('an operation times out after 10 minutes by the clock, counting time spent on the checks too', async () => {
    let time = 0;
    let checks = 0;
    const c = new FabricClient({
      getToken: async () => 'tok',
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/updateDefinition')) {
          return accepted('20');
        }
        // Each status check takes 58s to answer, and Fabric asks to wait 2s more.
        checks++;
        time += 58_000;
        return json({ status: 'Running' }, 200, { 'Retry-After': '2' });
      }) as typeof fetch,
      delay: async (ms) => {
        time += ms;
      },
      now: () => time,
    });
    await assert.rejects(c.updateNotebookDefinition('w1', 'n1', definition), (err: FabricApiError) => {
      assert.strictEqual(err.errorCode, 'OperationTimeout');
      return true;
    });
    // 60s a check: the waits alone (2s each) would have allowed 300 checks.
    assert.strictEqual(checks, 10);
  });

  test('an operation’s log record has how long Fabric took to run it (createdTimeUtc to lastUpdatedTimeUtc)', async () => {
    const records: RequestRecord[] = [];
    const responses = [
      accepted('20'),
      json({ status: 'Succeeded', createdTimeUtc: '2026-11-18T21:03:28.100Z', lastUpdatedTimeUtc: '2026-11-18T21:03:30.350Z' }),
    ];
    const c = new FabricClient({
      getToken: async () => 'tok',
      fetch: (async () => responses.shift()!) as typeof fetch,
      delay: async () => undefined,
      onRequest: (r) => records.push(r),
    });
    await c.updateNotebookDefinition('w1', 'n1', definition);
    const operation = records.find((r) => r.kind === 'operation')!;
    assert.deepStrictEqual([operation.polls, operation.waitedMs, operation.fabricMs], [1, 2000, 2250]);
  });

  test('requests count against Fabric’s quota buckets: operation checks and results, or everything else', () => {
    assert.strictEqual(requestBucket(OP), 'operations');
    assert.strictEqual(requestBucket(`${OP}/result`), 'operations');
    assert.strictEqual(requestBucket('https://wabi-west-us-redirect.analysis.windows.net/v1/operations/op1'), 'operations');
    // Fabric's Get Operation State example has a Location without /v1.
    assert.strictEqual(requestBucket('https://api.fabric.microsoft.com/operations/op1/result'), 'operations');
    assert.strictEqual(requestBucket(`${BASE}/workspaces/w1/notebooks/n1/getDefinition`), 'platform');
    assert.strictEqual(requestBucket(`${BASE}/workspaces`), 'platform');
    assert.strictEqual(requestBucket(`${BASE}/workspaces/operations`), 'platform');
  });

  test('getDefinition requests (with or without ?format) count against the definition limit; others don’t', () => {
    assert.ok(isDefinitionRequest(`${BASE}/workspaces/w1/notebooks/n1/getDefinition`));
    assert.ok(isDefinitionRequest(`${BASE}/workspaces/w1/notebooks/n1/getDefinition?format=ipynb`));
    assert.ok(!isDefinitionRequest(`${BASE}/workspaces/w1/notebooks/n1/updateDefinition`));
    assert.ok(!isDefinitionRequest(`${BASE}/workspaces/w1/notebooks`));
    assert.ok(!isDefinitionRequest(OP));
  });

  test('the client holds getDefinition requests to the definition limit', async () => {
    let time = 0;
    const sent: number[] = [];
    const c = new FabricClient({
      getToken: async () => 'tok',
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).includes('getDefinition')) {
          sent.push(time);
        }
        return json({ definition });
      }) as typeof fetch,
      delay: async (ms) => {
        time += ms;
      },
      now: () => time,
      definitionLimit: 2,
    });
    for (let i = 0; i < 3; i++) {
      await c.getNotebookDefinition('w1', `n${i}`, 'ipynb');
    }
    assert.deepStrictEqual(sent, [0, 0, 60_000]);
  });

  test('CapacityLimitExceeded is retried with exponential backoff, without lowering the budget', async () => {
    const records: RequestRecord[] = [];
    const delays: number[] = [];
    let time = 0;
    const busy = () => json({ errorCode: 'CapacityLimitExceeded', message: 'Capacity exceeded' }, 429);
    const responses = [busy(), busy(), busy(), json({ value: [] })];
    const c = new FabricClient({
      getToken: async () => 'tok',
      fetch: (async () => responses.shift()!) as typeof fetch,
      delay: async (ms) => {
        delays.push(ms);
        time += ms;
      },
      now: () => time,
      onRequest: (r) => records.push(r),
    });
    await c.listNotebooks('w1');
    assert.deepStrictEqual(delays, [5000, 10_000, 20_000]);
    assert.deepStrictEqual(c.limiter.budget('platform'), { burst: 180, ratePerSecond: 5 });
    assert.deepStrictEqual(
      records.filter((r) => r.kind === 'throttle').map((r) => [r.reason, r.bucket, r.ms]),
      [
        ['capacity', 'platform', 5000],
        ['capacity', 'platform', 10_000],
        ['capacity', 'platform', 20_000],
      ],
    );
  });

  test('a 429 on a status check pauses only operation requests', async () => {
    let time = 0;
    const order: string[] = [];
    const responses = [
      accepted('3'),
      json({ errorCode: 'RequestBlocked' }, 429, { 'Retry-After': '30' }),
      json({ status: 'Succeeded' }),
    ];
    let throttled!: () => void;
    const pausedOperations = new Promise<void>((r) => (throttled = r));
    const c = new FabricClient({
      getToken: async () => 'tok',
      fetch: (async (input: RequestInfo | URL) => {
        order.push(`${requestBucket(String(input))}@${time}`);
        return String(input).endsWith('/workspaces') ? json({ value: [] }) : responses.shift()!;
      }) as typeof fetch,
      // The clock moves only after other pending work has run, so a paused request can't move it before others are sent.
      delay: async (ms) => {
        await new Promise((r) => setTimeout(r, 0));
        time += ms;
      },
      now: () => time,
      onRequest: (r) => r.kind === 'throttle' && throttled(),
    });
    const update = c.updateNotebookDefinition('w1', 'n1', definition);
    await pausedOperations;
    await c.listWorkspaces();
    await update;
    // The workspace list went out during the operations bucket's 30s pause.
    assert.deepStrictEqual(order, ['platform@0', 'operations@2000', 'platform@2000', 'operations@32000']);
    assert.deepStrictEqual(c.limiter.budget('operations'), { burst: 150, ratePerSecond: 1.5 });
    assert.deepStrictEqual(c.limiter.budget('platform'), { burst: 180, ratePerSecond: 5 });
  });

  test('a failed operation surfaces Fabric’s error', async () => {
    const { c } = client([
      accepted(),
      json({ status: 'Failed', error: { errorCode: 'InvalidDefinition', message: 'Bad notebook' } }),
    ]);
    await assert.rejects(c.updateNotebookDefinition('w1', 'n1', definition), (err: FabricApiError) => {
      assert.deepStrictEqual([err.errorCode, err.message], ['InvalidDefinition', 'Bad notebook']);
      return true;
    });
  });

  test('updateDefinition sends the parts; an empty 200 is success', async () => {
    const { c, calls } = client([new Response(null, { status: 200 })]);
    await c.updateNotebookDefinition('w1', 'n1', definition);
    assert.deepStrictEqual(calls, [
      { method: 'POST', url: `${BASE}/workspaces/w1/notebooks/n1/updateDefinition`, body: { definition } },
    ]);
  });

  test('a finished operation without a Location has no result, and nothing more is fetched', async () => {
    const { c, calls } = client([accepted(), json({ status: 'Succeeded' })]);
    await c.updateNotebookDefinition('w1', 'n1', definition);
    assert.strictEqual(calls.length, 2);
  });

  test('getDefinition that finishes without a result, or with no definition, fails with a clear error', async () => {
    for (const responses of [
      [accepted(), json({ status: 'Succeeded' })],
      [json({})],
      [json({ definition: {} })],
    ]) {
      const { c } = client(responses);
      await assert.rejects(c.getNotebookDefinition('w1', 'n1'), (err: FabricApiError) => {
        assert.ok(err instanceof FabricApiError);
        assert.strictEqual(err.errorCode, 'MissingDefinition');
        assert.match(err.message, /returned no notebook content/);
        return true;
      });
    }
  });

  test('a status check that returns a new Location is followed from then on', async () => {
    const moved = 'https://wabi-west-us-redirect.analysis.windows.net/v1/operations/op1';
    const { c, calls } = client([
      accepted('1'),
      json({ status: 'Running' }, 200, { Location: moved, 'Retry-After': '1' }),
      json({ status: 'Succeeded' }, 200, { Location: `${moved}/result` }),
      json({ definition }),
    ]);
    assert.deepStrictEqual(await c.getNotebookDefinition('w1', 'n1'), definition);
    assert.deepStrictEqual(calls.slice(1).map((x) => x.url), [OP, moved, `${moved}/result`]);
  });

  test('trusts Fabric’s private-link and Power BI API hosts too', async () => {
    for (const host of ['00000000000000000000000000000001.z00.w.api.fabric.microsoft.com', 'api.powerbi.com']) {
      const location = `https://${host}/v1/operations/op1`;
      const { c } = client([
        new Response(null, { status: 202, headers: { Location: location, 'Retry-After': '1' } }),
        json({ status: 'Succeeded' }, 200, { Location: `${location}/result` }),
        json({ definition }),
      ]);
      assert.deepStrictEqual(await c.getNotebookDefinition('w1', 'n1'), definition, host);
    }
  });

  test('listItems lists one item type in a workspace', async () => {
    const lakehouse = { id: 'l1', displayName: 'Bronze', type: 'Lakehouse', workspaceId: 'w 1' };
    const { c, calls } = client([json({ value: [lakehouse] })]);
    assert.deepStrictEqual(await c.listItems('w 1', 'Lakehouse'), [lakehouse]);
    assert.deepStrictEqual(calls, [{ method: 'GET', url: `${BASE}/workspaces/w%201/items?type=Lakehouse` }]);
  });

  test('createNotebook sends the name and definition, and returns the new notebook', async () => {
    const created = { id: 'n2', displayName: 'Load', type: 'Notebook', workspaceId: 'w1' };
    const { c, calls } = client([json(created, 201)]);
    assert.deepStrictEqual(await c.createNotebook('w1', 'Load', definition), created);
    assert.deepStrictEqual(calls[0], {
      method: 'POST',
      url: `${BASE}/workspaces/w1/notebooks`,
      body: { displayName: 'Load', definition },
    });
  });

  test('follows an operation on Fabric’s regional Power BI host, as Fabric really does', async () => {
    // Seen from Fabric (2026-11): getDefinition answered 202 with a Location on a regional host.
    const regional = 'https://wabi-example-region-redirect.analysis.windows.net/v1/operations/00000000-0000-0000-0000-000000000099';
    const { c, calls } = client([
      new Response(null, { status: 202, headers: { Location: regional, 'Retry-After': '1' } }),
      json({ status: 'Succeeded' }, 200, { Location: `${regional}/result` }),
      json({ definition }),
    ]);
    assert.deepStrictEqual(await c.getNotebookDefinition('w1', 'n1'), definition);
    assert.deepStrictEqual(calls.slice(1).map((x) => x.url), [regional, `${regional}/result`]);
  });

  test('refuses hosts that only look like Fabric’s, and plain HTTP', async () => {
    for (const location of [
      'https://analysis.windows.net.evil.example/v1/operations/x',
      'https://evilanalysis.windows.net/v1/operations/x',
      'http://wabi-west-us-redirect.analysis.windows.net/v1/operations/x',
      'https://wabi-west-us-redirect.analysis.windows.net:8443/v1/operations/x',
    ]) {
      const { c, calls } = client([new Response(null, { status: 202, headers: { Location: location } })]);
      await assert.rejects(c.getNotebookDefinition('w1', 'n1'), /Refusing to follow/, location);
      assert.strictEqual(calls.length, 1, location);
    }
  });

  test('refuses to follow an operation Location on another host', async () => {
    const { c, calls } = client([new Response(null, { status: 202, headers: { Location: 'https://evil.example/op' } })]);
    await assert.rejects(c.getNotebookDefinition('w1', 'n1'), /Refusing to follow/);
    assert.strictEqual(calls.length, 1);
  });
});

suite('FabricClient: diagnostics records for long-running operations', () => {
  /** A client over `responses` that keeps every diagnostics record. */
  function recording(responses: Response[], now?: () => number) {
    const records: RequestRecord[] = [];
    const c = new FabricClient({
      getToken: async () => 'tok',
      fetch: (async () => {
        const next = responses.shift();
        if (!next) {
          throw new Error('Unexpected request');
        }
        return next;
      }) as typeof fetch,
      delay: async () => undefined,
      ...(now ? { now } : {}),
      onRequest: (r) => records.push(r),
    });
    return { c, records };
  }
  const operation = (records: RequestRecord[]) => records.find((r) => r.kind === 'operation')!;

  test('every line of an operation has its ID; status checks have Fabric’s state and progress; the summary says it succeeded', async () => {
    const { c, records } = recording([
      new Response(null, { status: 202, headers: { Location: OP, 'x-ms-operation-id': 'op-42' } }),
      json({ status: 'Running', percentComplete: 40 }),
      json({ status: 'Succeeded', percentComplete: 100 }, 200, { Location: `${OP}/result` }),
      json({ definition }),
    ]);
    await c.getNotebookDefinition('w1', 'n1');
    const requests = records.filter((r) => r.kind === 'request');
    assert.deepStrictEqual(requests.map((r) => r.operationId), ['op-42', 'op-42', 'op-42', 'op-42']);
    assert.deepStrictEqual(requests.map((r) => [r.state, r.percentComplete]), [
      [undefined, undefined],
      ['Running', 40],
      ['Succeeded', 100],
      [undefined, undefined],
    ]);
    const summary = operation(records);
    assert.deepStrictEqual([summary.operationId, summary.result, summary.errorCode], ['op-42', 'succeeded', undefined]);
  });

  test('without x-ms-operation-id, the ID comes from the operation URL', async () => {
    const { c, records } = recording([accepted(), json({ status: 'Succeeded' })]);
    await c.updateNotebookDefinition('w1', 'n1', definition);
    assert.strictEqual(operation(records).operationId, 'op1');
  });

  test('a failed operation’s summary has Fabric’s error code and request ID', async () => {
    const { c, records } = recording([
      accepted(),
      json({ status: 'Failed', error: { errorCode: 'InvalidDefinition', message: 'Bad notebook', requestId: 'req-9' } }),
    ]);
    await assert.rejects(c.updateNotebookDefinition('w1', 'n1', definition));
    const summary = operation(records);
    assert.deepStrictEqual([summary.result, summary.errorCode, summary.requestId], ['failed', 'InvalidDefinition', 'req-9']);
  });

  test('a timed-out operation, and one the client couldn’t follow, say so', async () => {
    let time = 0;
    const slow = recording(
      [accepted(), ...Array.from({ length: 3 }, () => json({ status: 'Running' }))],
      () => (time += 300_000), // each look at the clock is 5 minutes on
    );
    await assert.rejects(slow.c.updateNotebookDefinition('w1', 'n1', definition));
    assert.deepStrictEqual([operation(slow.records).result, operation(slow.records).errorCode], ['timedOut', 'OperationTimeout']);

    const lost = recording([accepted(), json({ status: 'Running' }, 200, { Location: 'https://evil.example/op' })]);
    await assert.rejects(lost.c.updateNotebookDefinition('w1', 'n1', definition));
    assert.deepStrictEqual([operation(lost.records).result, operation(lost.records).errorCode], ['error', 'UntrustedOperationUrl']);
  });

  test('a DELETE or PATCH answered 202 is followed to the end, not taken as done', async () => {
    const del = recording([
      new Response(null, { status: 202, headers: { Location: OP } }),
      json({ status: 'Running' }),
      json({ status: 'Succeeded' }),
    ]);
    await del.c.deleteNotebook('w1', 'n1');
    assert.deepStrictEqual([operation(del.records).method, operation(del.records).polls, operation(del.records).result], ['DELETE', 2, 'succeeded']);

    const failedDelete = recording([
      new Response(null, { status: 202, headers: { Location: OP } }),
      json({ status: 'Failed', error: { errorCode: 'ItemLocked', message: 'Locked' } }),
    ]);
    await assert.rejects(failedDelete.c.deleteNotebook('w1', 'n1'), /Locked/);

    const patch = recording([
      new Response(null, { status: 202, headers: { Location: OP } }),
      json({ status: 'Succeeded' }, 200, { Location: `${OP}/result` }),
      json({ id: 'n1', displayName: 'N', description: 'd' }),
    ]);
    assert.strictEqual((await patch.c.updateNotebook('w1', 'n1', { description: 'd' })).description, 'd');
    // A 200, as Fabric documents, is unchanged: one request, no operation.
    const plain = recording([new Response(null, { status: 200 })]);
    await plain.c.deleteNotebook('w1', 'n1');
    assert.deepStrictEqual(plain.records.map((r) => [r.kind, r.status]), [['request', 200]]);
  });
});
