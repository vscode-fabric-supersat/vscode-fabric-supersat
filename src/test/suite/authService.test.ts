import * as assert from 'assert';
import { resolveAuthMethod } from '../../auth/service';
import { AuthError } from '../../auth/types';

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
