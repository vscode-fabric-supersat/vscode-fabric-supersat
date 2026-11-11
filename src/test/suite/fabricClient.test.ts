// Offline tests for the Fabric REST client: fetch is faked, nothing touches the network.
import * as assert from 'assert';
import { FabricApiError, FabricClient, type FabricClientOptions, parseRetryAfter } from '../../fabric/client';
import type { RequestRecord } from '../../util/diagnostics';

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

/** A client over `responses`, on a fake clock that `delay` moves on (recording each delay). */
function client(responses: Response[], delays: number[] = [], options: Partial<FabricClientOptions> = {}) {
  const { fetchFn, calls } = fakeFetch(responses);
  const records: RequestRecord[] = [];
  let time = 0;
  const c = new FabricClient({
    getToken: async () => 'tok',
    fetch: fetchFn,
    delay: async (ms) => {
      delays.push(ms);
      time += ms;
    },
    now: () => time,
    onRequest: (r) => records.push(r),
    ...options,
  });
  return { c, calls, records };
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

  test('Retry-After above 60s: honoured for an overloaded capacity (up to 10 minutes), capped at 60s for the rate', async () => {
    const pauseFor = async (errorCode: string, retryAfter: string) => {
      const { c, records } = client([json({ errorCode }, 429, { 'Retry-After': retryAfter }), json({ value: [] })]);
      await c.listWorkspaces();
      return records.find((r) => r.kind === 'throttle')?.ms;
    };
    assert.strictEqual(await pauseFor('CapacityLimitExceeded', '300'), 300_000);
    assert.strictEqual(await pauseFor('CapacityLimitExceeded', '3600'), 600_000);
    assert.strictEqual(await pauseFor('RequestBlocked', '300'), 60_000);
  });

  test('Retry-After as an HTTP date is honoured; one that can’t be read falls back to the default pause', async () => {
    // The fake clock starts at 0 (1 Jan 1970), so this date is 90s away.
    const { c, records } = client([
      json({ errorCode: 'CapacityLimitExceeded' }, 429, { 'Retry-After': 'Thu, 01 Jan 1970 00:01:30 GMT' }),
      json({ value: [] }),
    ]);
    await c.listWorkspaces();
    assert.strictEqual(records.find((r) => r.kind === 'throttle')?.ms, 90_000);
    const bad = client([json({ errorCode: 'RequestBlocked' }, 429, { 'Retry-After': '-5' }), json({ value: [] })]);
    await bad.c.listWorkspaces();
    assert.strictEqual(bad.records.find((r) => r.kind === 'throttle')?.ms, 5000);
  });

  test('parseRetryAfter: seconds or an HTTP date; anything else is ignored', () => {
    const now = Date.parse('2026-11-20T22:00:00Z');
    assert.strictEqual(parseRetryAfter('120', now), 120_000);
    assert.strictEqual(parseRetryAfter(' 2.5 ', now), 2500);
    assert.strictEqual(parseRetryAfter('0', now), 0);
    assert.strictEqual(parseRetryAfter('Fri, 20 Nov 2026 22:00:45 GMT', now), 45_000);
    assert.strictEqual(parseRetryAfter('Fri, 20 Nov 2026 21:00:00 GMT', now), 0, 'a date already past means no wait');
    for (const header of [null, '', '  ', '-5', 'abc', 'NaN', 'Infinity', '1e3', 'Someday']) {
      assert.strictEqual(parseRetryAfter(header, now), undefined, String(header));
    }
  });

  test('gives up after maxRetries (6) 429 responses', async () => {
    const throttled = () => json({ errorCode: 'RequestBlocked', message: 'Slow down' }, 429);
    const { c, calls } = client(Array.from({ length: 7 }, throttled));
    await assert.rejects(c.listWorkspaces(), (err: FabricApiError) => {
      assert.strictEqual(err.status, 429);
      assert.strictEqual(err.message, 'Slow down');
      return true;
    });
    assert.strictEqual(calls.length, 7);
  });

  test('a 429 pauses every request in its quota bucket, not just the throttled one, and halves the bucket’s budget', async () => {
    // Two requests at once: the first is throttled, so the second waits for the pause too.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const delays: number[] = [];
    const responses: Record<string, Response[]> = {
      a: [json({ errorCode: 'RequestBlocked' }, 429, { 'Retry-After': '3' }), json({ value: [] })],
      b: [json({ value: [] })],
    };
    let time = 0;
    const records: RequestRecord[] = [];
    const c = new FabricClient({
      getToken: async () => 'tok',
      fetch: (async (input: RequestInfo | URL) => {
        const key = String(input).includes('/workspaces/a/') ? 'a' : 'b';
        order.push(`${key}@${time}`);
        return responses[key].shift()!;
      }) as typeof fetch,
      delay: async (ms) => {
        delays.push(ms);
        time += ms;
      },
      now: () => time,
      onRequest: (r) => {
        records.push(r);
        if (r.kind === 'throttle') {
          release(); // b starts once a has been throttled
        }
      },
    });
    const a = c.listNotebooks('a');
    await held;
    const b = c.listNotebooks('b');
    await Promise.all([a, b]);
    // Neither a's retry nor b is sent before the pause ends.
    assert.deepStrictEqual([order[0], [...order.slice(1)].sort()], ['a@0', ['a@3000', 'b@3000']]);
    assert.deepStrictEqual(delays, [3000]);
    assert.deepStrictEqual(c.limiter.budget('platform'), { burst: 90, ratePerSecond: 2.5 });
    assert.strictEqual(c.limiter.maxConcurrent, 32);
    assert.deepStrictEqual(
      records.filter((r) => r.kind === 'throttle').map((r) => [r.ms, r.bucket, r.reason, r.ratePerSecond, r.burst]),
      [[3000, 'platform', 'rate', 2.5, 90]],
    );
  });

  test('never runs more requests at once than the limit; each request records how many were running', async () => {
    let running = 0;
    let most = 0;
    const records: RequestRecord[] = [];
    const c = new FabricClient({
      getToken: async () => 'tok',
      maxConcurrentRequests: 3,
      onRequest: (r) => records.push(r),
      fetch: (async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return json({ value: [] });
      }) as typeof fetch,
    });
    await Promise.all(Array.from({ length: 10 }, (_, i) => c.listNotebooks(`w${i}`)));
    assert.strictEqual(most, 3);
    assert.strictEqual(Math.max(...records.map((r) => r.inFlight ?? 0)), 3);
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

  test('handles non-JSON error bodies (after retrying the 502)', async () => {
    const badGateway = () => new Response('<html>Bad gateway</html>', { status: 502 });
    const { c } = client([badGateway(), badGateway(), badGateway(), badGateway()]);
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

  test('refuses a continuationUri it has already read, rather than listing forever', async () => {
    const first = `${BASE}/workspaces/w1/notebooks`;
    const second = `${first}?continuationToken=abc`;
    const { c, calls } = client([
      json({ value: [{ id: 'n1' }], continuationUri: second }),
      json({ value: [{ id: 'n2' }], continuationUri: second }),
    ]);
    await assert.rejects(c.listNotebooks('w1'), (err: FabricApiError) => {
      assert.strictEqual(err.errorCode, 'RepeatedContinuationUri');
      return true;
    });
    assert.strictEqual(calls.length, 2);
    // Pointing back at the first page is refused too.
    const back = client([json({ value: [], continuationUri: first })]);
    await assert.rejects(back.c.listNotebooks('w1'), /page already read/);
  });

  test('retries 5xx: 1s, 2s, 4s, or Fabric’s Retry-After', async () => {
    const delays: number[] = [];
    const { c, calls } = client(
      [
        new Response(null, { status: 503 }),
        new Response(null, { status: 500 }),
        new Response(null, { status: 503, headers: { 'Retry-After': '7' } }),
        json({ value: [{ id: 'w1' }] }),
      ],
      delays,
    );
    assert.deepStrictEqual((await c.listWorkspaces()).map((w) => w.id), ['w1']);
    assert.strictEqual(calls.length, 4);
    assert.deepStrictEqual(delays, [1000, 2000, 7000]);
  });

  test('retries a network error, then gives up after 3 retries with the error', async () => {
    let sent = 0;
    const c = new FabricClient({
      getToken: async () => 'tok',
      delay: async () => undefined,
      fetch: (async () => {
        sent++;
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await assert.rejects(c.listWorkspaces(), /fetch failed/);
    assert.strictEqual(sent, 4);
  });

  test('creating a notebook isn’t retried after a 5xx, since Fabric may have created it', async () => {
    const { c, calls } = client([new Response(null, { status: 503 })]);
    await assert.rejects(c.createNotebook('w1', 'N', { parts: [] }), (err: FabricApiError) => err.status === 503);
    assert.strictEqual(calls.length, 1);
  });

  test('a DELETE retried after a 5xx that finds the notebook gone counts as deleted', async () => {
    const { c, calls } = client([new Response(null, { status: 502 }), json({ errorCode: 'ItemNotFound' }, 404)]);
    await c.deleteNotebook('w1', 'n1');
    assert.strictEqual(calls.length, 2);
    // A 404 on the first attempt is still an error.
    const once = client([json({ errorCode: 'ItemNotFound' }, 404)]);
    await assert.rejects(once.c.deleteNotebook('w1', 'n1'), (err: FabricApiError) => err.status === 404);
  });

  test('the token is fetched once the limiter lets the request go, so a long wait can’t leave it stale', async () => {
    const events: string[] = [];
    let time = 0;
    const c = new FabricClient({
      getToken: async () => {
        events.push(`token@${time}`);
        return 'tok';
      },
      fetch: (async () => {
        events.push(`send@${time}`);
        return json({ value: [] });
      }) as typeof fetch,
      delay: async (ms) => {
        time += ms;
      },
      now: () => time,
    });
    c.limiter.throttled('platform', 'rate', 30_000);
    await c.listWorkspaces();
    const [token, send] = events.map((e) => Number(e.split('@')[1]));
    assert.deepStrictEqual(events.map((e) => e.split('@')[0]), ['token', 'send']);
    assert.ok(token >= 30_000 && token === send, events.join(', '));
  });
});
