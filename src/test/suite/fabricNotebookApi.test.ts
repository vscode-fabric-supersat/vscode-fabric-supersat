// Offline tests for the notebook definition endpoints and long-running operations (fetch is faked).
import * as assert from 'assert';
import { FabricApiError, FabricClient, type ItemDefinition } from '../../fabric/client';

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
    assert.deepStrictEqual(delays, [3000, 2000]);
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
