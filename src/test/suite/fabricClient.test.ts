// Offline tests for the Fabric REST client: fetch is faked, nothing touches the network.
import * as assert from 'assert';
import { FabricApiError, FabricClient } from '../../fabric/client';

const BASE = 'https://api.fabric.microsoft.com/v1';

interface Call {
  url: string;
  auth: string | null;
}

/** Fake fetch that replays `responses` in order and records each request. */
function fakeFetch(responses: Response[]) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') });
    const next = responses.shift();
    if (!next) {
      throw new Error(`Unexpected request: ${String(input)}`);
    }
    return next;
  }) as typeof fetch;
  return { fetchFn, calls };
}

suite('FabricClient: redirects', () => {
  test('every request refuses HTTP redirects, so the token can’t be redirected elsewhere', async () => {
    const redirects: (RequestRedirect | undefined)[] = [];
    const c = new FabricClient({
      getToken: async () => 'tok',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        redirects.push(init?.redirect);
        return new Response(JSON.stringify({ value: [{ id: 'w1', displayName: 'Sales', type: 'Workspace' }] }), { status: 200 });
      }) as typeof fetch,
    });
    assert.deepStrictEqual(await c.listWorkspaces(), [{ id: 'w1', displayName: 'Sales', type: 'Workspace' }]);
    await c.updateNotebookDefinition('w1', 'n1', { parts: [] });
    assert.deepStrictEqual(redirects, ['error', 'error']);
  });
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

function client(responses: Response[], delays: number[] = []) {
  const { fetchFn, calls } = fakeFetch(responses);
  const c = new FabricClient({
    getToken: async () => 'tok',
    fetch: fetchFn,
    delay: async (ms) => {
      delays.push(ms);
    },
  });
  return { c, calls };
}

suite('FabricClient', () => {
  test('lists workspaces with a bearer token', async () => {
    const { c, calls } = client([
      json({ value: [{ id: 'w1', displayName: 'Sales', type: 'Workspace' }] }),
    ]);
    const result = await c.listWorkspaces();
    assert.deepStrictEqual(result.map((w) => w.id), ['w1']);
    assert.deepStrictEqual(calls, [{ url: `${BASE}/workspaces`, auth: 'Bearer tok' }]);
  });

  test('follows continuationUri across pages', async () => {
    const next = `${BASE}/workspaces/w1/notebooks?continuationToken=abc`;
    const { c, calls } = client([
      json({ value: [{ id: 'n1' }], continuationToken: 'abc', continuationUri: next }),
      json({ value: [{ id: 'n2' }] }),
    ]);
    const result = await c.listNotebooks('w1');
    assert.deepStrictEqual(result.map((n) => n.id), ['n1', 'n2']);
    assert.deepStrictEqual(calls.map((x) => x.url), [`${BASE}/workspaces/w1/notebooks`, next]);
  });

  test('refuses a continuationUri on another host (token is not sent)', async () => {
    const { c, calls } = client([
      json({ value: [], continuationUri: 'https://evil.example/steal' }),
    ]);
    await assert.rejects(c.listWorkspaces(), (err: FabricApiError) => {
      assert.strictEqual(err.errorCode, 'UnexpectedContinuationUri');
      return true;
    });
    assert.strictEqual(calls.length, 1);
  });

  test('retries 429 after Retry-After seconds', async () => {
    const delays: number[] = [];
    const { c, calls } = client(
      [json({ errorCode: 'RequestBlocked' }, 429, { 'Retry-After': '2' }), json({ value: [] })],
      delays,
    );
    assert.deepStrictEqual(await c.listWorkspaces(), []);
    assert.deepStrictEqual(delays, [2000]);
    assert.strictEqual(calls.length, 2);
  });

  test('gives up after maxRetries 429 responses', async () => {
    const throttled = () => json({ errorCode: 'RequestBlocked', message: 'Slow down' }, 429);
    const { c } = client([throttled(), throttled(), throttled(), throttled()]);
    await assert.rejects(c.listWorkspaces(), (err: FabricApiError) => {
      assert.strictEqual(err.status, 429);
      assert.strictEqual(err.message, 'Slow down');
      return true;
    });
  });

  test('surfaces Fabric error details', async () => {
    const { c } = client([
      json({ errorCode: 'InsufficientScopes', message: 'Missing scope', requestId: 'r1' }, 403),
    ]);
    await assert.rejects(c.listNotebooks('w1'), (err: FabricApiError) => {
      assert.ok(err instanceof FabricApiError);
      assert.deepStrictEqual(
        [err.status, err.errorCode, err.message, err.requestId],
        [403, 'InsufficientScopes', 'Missing scope', 'r1'],
      );
      return true;
    });
  });

  test('handles non-JSON error bodies', async () => {
    const { c } = client([new Response('<html>Bad gateway</html>', { status: 502 })]);
    await assert.rejects(c.listWorkspaces(), (err: FabricApiError) => {
      assert.strictEqual(err.status, 502);
      assert.match(err.message, /^502/);
      return true;
    });
  });

  test('URL-encodes the workspace ID', async () => {
    const { c, calls } = client([json({ value: [] })]);
    await c.listNotebooks('a/b');
    assert.strictEqual(calls[0].url, `${BASE}/workspaces/a%2Fb/notebooks`);
  });
});
