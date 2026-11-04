// Offline tests for listing Entra tenants via Azure Resource Manager (fetch is faked).
import * as assert from 'assert';
import { ARM_BASE_URL, listTenants } from '../../fabric/tenants';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fakeFetch(responses: Response[]) {
  const urls: string[] = [];
  const auth: (string | null)[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    auth.push(new Headers(init?.headers).get('Authorization'));
    const next = responses.shift();
    if (!next) {
      throw new Error(`Unexpected request: ${String(input)}`);
    }
    return next;
  }) as typeof fetch;
  return { fetchFn, urls, auth };
}

const token = async () => 'arm-tok';

suite('listTenants', () => {
  test('follows nextLink and keeps only the fields we use', async () => {
    const next = `${ARM_BASE_URL}/tenants?api-version=2022-12-01&$skiptoken=x`;
    const { fetchFn, urls, auth } = fakeFetch([
      json({
        value: [{ tenantId: 't1', displayName: 'Contoso', defaultDomain: 'contoso.com', id: '/tenants/t1' }],
        nextLink: next,
      }),
      json({ value: [{ tenantId: 't2' }] }),
    ]);
    const tenants = await listTenants(token, fetchFn);
    assert.deepStrictEqual(tenants, [
      { tenantId: 't1', displayName: 'Contoso', defaultDomain: 'contoso.com' },
      { tenantId: 't2', displayName: undefined, defaultDomain: undefined },
    ]);
    assert.deepStrictEqual(urls, [`${ARM_BASE_URL}/tenants?api-version=2022-12-01`, next]);
    assert.deepStrictEqual(auth, ['Bearer arm-tok', 'Bearer arm-tok']);
  });

  test('refuses a nextLink on another host', async () => {
    const { fetchFn, urls } = fakeFetch([json({ value: [], nextLink: 'https://evil.example/x' })]);
    await assert.rejects(listTenants(token, fetchFn), /Refusing to follow/);
    assert.strictEqual(urls.length, 1);
  });

  test('surfaces the ARM error message', async () => {
    const { fetchFn } = fakeFetch([
      json({ error: { code: 'InvalidAuthenticationToken', message: 'The access token is invalid.' } }, 401),
    ]);
    await assert.rejects(listTenants(token, fetchFn), /Listing tenants failed: The access token is invalid\./);
  });
});
