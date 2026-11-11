import * as assert from 'assert';
import { initAuthSettings, updateAuthSettings } from '../../auth/settings';
import { AuthError } from '../../auth/types';
import { ARM_SCOPE, FABRIC_SCOPE, getSessionScopes } from '../../auth/vscodeSession';
import { memoryMemento } from './memento';

const CLIENT = '11111111-2222-3333-4444-555555555555';

suite('VS Code sign-in scopes', () => {
  setup(() => initAuthSettings(memoryMemento()));
  teardown(() => initAuthSettings(undefined));

  test('requires a client ID (VS Code’s own app is not authorized for Fabric)', () => {
    assert.throws(() => getSessionScopes(), (err: AuthError) => {
      assert.ok(err instanceof AuthError);
      assert.strictEqual(err.fix.configureSignIn, true);
      return true;
    });
  });

  test('requests the Fabric .default scope with the client ID, and the tenant when set', async () => {
    await updateAuthSettings({ clientId: ` ${CLIENT} ` });
    assert.deepStrictEqual(getSessionScopes(), [`VSCODE_CLIENT_ID:${CLIENT}`, FABRIC_SCOPE]);

    await updateAuthSettings({ tenant: 'contoso.onmicrosoft.com' });
    assert.deepStrictEqual(getSessionScopes(), [
      `VSCODE_CLIENT_ID:${CLIENT}`,
      'VSCODE_TENANT:contoso.onmicrosoft.com',
      FABRIC_SCOPE,
    ]);
  });

  test('uses the same client and tenant for the tenant-listing (ARM) token', async () => {
    await updateAuthSettings({ clientId: CLIENT, tenant: 'tid' });
    assert.deepStrictEqual(getSessionScopes('arm'), [`VSCODE_CLIENT_ID:${CLIENT}`, 'VSCODE_TENANT:tid', ARM_SCOPE]);
  });
});
