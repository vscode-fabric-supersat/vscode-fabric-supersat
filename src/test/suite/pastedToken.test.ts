import * as assert from 'assert';
import type * as vscode from 'vscode';
import { accountLabel, decodeJwt, isExpired, normalizeToken } from '../../auth/jwt';
import { PastedTokenProvider } from '../../auth/pastedToken';
import { AuthCancelledError, AuthError } from '../../auth/types';
import { fakeJwt, nowSeconds } from './jwtHelper';

const valid = () =>
  fakeJwt({ aud: 'https://api.fabric.microsoft.com', exp: nowSeconds() + 3600, upn: 'ada@contoso.com' });

suite('JWT helpers', () => {
  test('decodes claims, including non-ASCII names', () => {
    const claims = decodeJwt(fakeJwt({ aud: 'x', name: 'Zoë' }));
    assert.deepStrictEqual(claims, { aud: 'x', name: 'Zoë' });
  });

  test('rejects things that are not JWTs', () => {
    assert.throws(() => decodeJwt('nope'), /Not a JWT/);
    assert.throws(() => decodeJwt('a.!!!.c'), /Not a JWT/);
  });

  test('normalizes pasted values and picks a readable account name', () => {
    assert.strictEqual(normalizeToken('  Bearer abc \n'), 'abc');
    assert.strictEqual(accountLabel({ preferred_username: 'p', unique_name: 'u' }), 'p');
    assert.strictEqual(accountLabel({ appid: 'a1' }), 'app a1');
  });

  test('treats tokens close to expiry as expired', () => {
    const now = 1_000_000_000_000;
    assert.strictEqual(isExpired({ exp: now / 1000 + 30 }, now), true);
    assert.strictEqual(isExpired({ exp: now / 1000 + 3600 }, now), false);
    assert.strictEqual(isExpired({}, now), true);
  });
});

suite('PastedTokenProvider', () => {
  function setup(answers: (string | undefined)[]) {
    const store = new Map<string, string>();
    const prompts: vscode.InputBoxOptions[] = [];
    const help: string[] = [];
    const provider = new PastedTokenProvider({
      secrets: {
        get: async (k) => store.get(k),
        store: async (k, v) => void store.set(k, v),
        delete: async (k) => void store.delete(k),
      },
      prompt: async (options) => {
        prompts.push(options);
        return answers.shift();
      },
      showHelp: (message) => help.push(message),
    });
    return { provider, store, prompts, help };
  }

  test('validates audience and expiry as the user types', () => {
    const { provider } = setup([]);
    assert.strictEqual(provider.validate(valid()), undefined);
    assert.match(provider.validate('')!, /Paste an access token/);
    assert.match(provider.validate(fakeJwt({ aud: 'https://graph.microsoft.com', exp: nowSeconds() + 3600 }))!, /not the Fabric API/);
    assert.match(provider.validate(fakeJwt({ aud: 'https://api.fabric.microsoft.com', exp: nowSeconds() - 10 }))!, /expired/);
  });

  test('signs in, stores the token, then reuses it without prompting', async () => {
    const token = valid();
    const { provider, store, prompts } = setup([`Bearer ${token}`]);
    assert.strictEqual(await provider.signIn(), 'ada@contoso.com');
    assert.deepStrictEqual([...store.values()], [token]);
    assert.strictEqual(await provider.getToken('fabric', 'why'), token);
    assert.strictEqual(prompts.length, 1);
    assert.strictEqual(prompts[0].password, true);
  });

  test('shows the copyable commands each time it prompts', async () => {
    const { provider, help } = setup([valid()]);
    await provider.signIn();
    assert.strictEqual(help.length, 1);
    const lines = help[0].split('\n');
    assert.ok(lines.some((l) => l.endsWith(' az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv')));
    assert.ok(lines.some((l) => l.endsWith(" notebookutils.credentials.getToken('pbi')")));
  });

  test('asks again when the stored token has expired', async () => {
    const fresh = valid();
    const { provider, store, prompts } = setup([fresh]);
    store.set('fabric-supersat.pastedToken', fakeJwt({ aud: 'https://api.fabric.microsoft.com', exp: nowSeconds() - 5 }));
    assert.strictEqual(await provider.getToken('fabric', 'List notebooks.'), fresh);
    assert.match(prompts[0].prompt!, /has expired/);
  });

  test('cancelling the prompt is a cancellation, not an error', async () => {
    const { provider } = setup([undefined]);
    await assert.rejects(provider.getToken('fabric', 'why'), AuthCancelledError);
  });

  test('cannot provide ARM tokens, so Switch Tenant explains why', async () => {
    const { provider } = setup([]);
    await assert.rejects(provider.getToken('arm', 'why'), AuthError);
  });

  test('sign out deletes the stored token', async () => {
    const { provider, store } = setup([valid()]);
    await provider.signIn();
    await provider.signOut();
    assert.strictEqual(store.size, 0);
  });
});
