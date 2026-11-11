import * as assert from 'assert';
import { FabricAuth, resolveAuthMethod } from '../../auth/service';
import { AuthCancelledError, AuthError, type AuthMethod, type TokenProvider } from '../../auth/types';

suite('resolveAuthMethod', () => {
  const desktop = ['azureCli', 'vscode', 'token'] as const;
  const web = ['vscode', 'token'] as const;

  test('auto uses the Azure CLI on desktop', () => {
    assert.strictEqual(resolveAuthMethod('auto', desktop, false), 'azureCli');
    assert.strictEqual(resolveAuthMethod('auto', desktop, true), 'azureCli');
  });

  test('auto on web: VS Code sign-in with a client ID, otherwise a pasted token', () => {
    assert.strictEqual(resolveAuthMethod('auto', web, true), 'vscode');
    assert.strictEqual(resolveAuthMethod('auto', web, false), 'token');
  });

  test('an explicit method wins', () => {
    assert.strictEqual(resolveAuthMethod('token', desktop, true), 'token');
    assert.strictEqual(resolveAuthMethod('vscode', desktop, false), 'vscode');
  });

  test('the Azure CLI is rejected on web with a fix', () => {
    assert.throws(() => resolveAuthMethod('azureCli', web, false), (err: AuthError) => {
      assert.ok(err instanceof AuthError);
      assert.match(err.message, /only works in VS Code Desktop/);
      assert.strictEqual(err.fix.configureSignIn, true);
      return true;
    });
  });
});

suite('FabricAuth.getToken', () => {
  /** One fake provider per method, all counting into `calls`; each fetch finishes when `finish` is called. */
  function fakeAuth() {
    const calls: string[] = [];
    const finishers: ((outcome: string | Error) => void)[] = [];
    const provider = (method: AuthMethod): TokenProvider => ({
      method,
      label: method,
      canListTenants: false,
      getToken: (resource) => {
        calls.push(resource);
        return new Promise<string>((resolve, reject) =>
          finishers.push((outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome))),
        );
      },
      signIn: async () => 'me',
      signOut: async () => '',
    });
    const auth = new FabricAuth([provider('azureCli'), provider('vscode'), provider('token')]);
    return { auth, calls, finish: (outcome: string | Error) => finishers.splice(0).forEach((f) => f(outcome)) };
  }

  test('requests made while a token is being fetched share it: one az process or sign-in prompt', async () => {
    const { auth, calls, finish } = fakeAuth();
    const tokens = Promise.all(Array.from({ length: 128 }, () => auth.getToken('fabric', 'why')));
    const arm = auth.getToken('arm', 'why');
    assert.deepStrictEqual(calls, ['fabric', 'arm']);
    finish('tok');
    assert.ok((await tokens).every((t) => t === 'tok'));
    assert.strictEqual(await arm, 'tok');
    // Once it has finished, the next request asks the provider again (which keeps its own cache).
    const again = auth.getToken('fabric', 'why');
    assert.deepStrictEqual(calls, ['fabric', 'arm', 'fabric']);
    finish('tok2');
    assert.strictEqual(await again, 'tok2');
  });

  test('a cancelled sign-in fails every request that shared it, and the next one asks again', async () => {
    const { auth, calls, finish } = fakeAuth();
    const shared = [auth.getToken('fabric', 'why'), auth.getToken('fabric', 'why')];
    finish(new AuthCancelledError());
    for (const p of shared) {
      await assert.rejects(p, AuthCancelledError);
    }
    const next = auth.getToken('fabric', 'why');
    assert.strictEqual(calls.length, 2);
    finish('tok');
    assert.strictEqual(await next, 'tok');
  });
});
