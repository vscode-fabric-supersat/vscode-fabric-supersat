import * as assert from 'assert';
import * as vscode from 'vscode';
import { AuthError } from '../../auth/types';
import { ARM_SCOPE, FABRIC_SCOPE, getSessionScopes } from '../../auth/vscodeSession';
import { ID_PREFIX } from '../../constants';

suite('VS Code sign-in scopes', () => {
  const config = () => vscode.workspace.getConfiguration(ID_PREFIX);
  const set = (key: string, value: string | undefined) =>
    config().update(key, value, vscode.ConfigurationTarget.Global);

  teardown(async () => {
    await set('auth.clientId', undefined);
    await set('auth.tenant', undefined);
  });

  test('requires a client ID (VS Code’s own app is not authorized for Fabric)', () => {
    assert.throws(() => getSessionScopes(), (err: AuthError) => {
      assert.ok(err instanceof AuthError);
      assert.strictEqual(err.fix.setting, `${ID_PREFIX}.auth`);
      return true;
    });
  });

  test('requests the Fabric .default scope with the client ID, and the tenant when set', async () => {
    await set('auth.clientId', ' my-client ');
    assert.deepStrictEqual(getSessionScopes(), ['VSCODE_CLIENT_ID:my-client', FABRIC_SCOPE]);

    await set('auth.tenant', 'contoso.onmicrosoft.com');
    assert.deepStrictEqual(getSessionScopes(), [
      'VSCODE_CLIENT_ID:my-client',
      'VSCODE_TENANT:contoso.onmicrosoft.com',
      FABRIC_SCOPE,
    ]);
  });

  test('uses the same client and tenant for the tenant-listing (ARM) token', async () => {
    await set('auth.clientId', 'my-client');
    await set('auth.tenant', 'tid');
    assert.deepStrictEqual(getSessionScopes('arm'), ['VSCODE_CLIENT_ID:my-client', 'VSCODE_TENANT:tid', ARM_SCOPE]);
  });
});
