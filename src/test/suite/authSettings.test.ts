import * as assert from 'assert';
import * as vscode from 'vscode';
import { DEFAULT_AUTH_SETTINGS, getAuthSettings, initAuthSettings, updateAuthSettings } from '../../auth/settings';
import { EXTENSION_FULL_ID, ID_PREFIX } from '../../constants';
import { memoryMemento } from './memento';

const KEY = `${ID_PREFIX}.authSettings`;
const CLIENT = '11111111-2222-3333-4444-555555555555';

suite('Sign-in settings', () => {
  teardown(() => initAuthSettings(undefined));

  test('are not VS Code settings, so no settings.json can set them', () => {
    const properties = vscode.extensions.getExtension(EXTENSION_FULL_ID)?.packageJSON.contributes.configuration
      .properties as Record<string, unknown>;
    for (const key of ['auth.method', 'auth.clientId', 'auth.tenant']) {
      assert.ok(!(`${ID_PREFIX}.${key}` in properties), `${key} must not be a contributed setting`);
    }
  });

  test('default when nothing is stored, or before activation', () => {
    assert.deepStrictEqual(getAuthSettings(), DEFAULT_AUTH_SETTINGS);
    initAuthSettings(memoryMemento());
    assert.deepStrictEqual(getAuthSettings(), DEFAULT_AUTH_SETTINGS);
  });

  test('saves valid values', async () => {
    initAuthSettings(memoryMemento());
    await updateAuthSettings({ method: 'vscode', clientId: CLIENT, tenant: 'contoso.onmicrosoft.com' });
    assert.deepStrictEqual(getAuthSettings(), { method: 'vscode', clientId: CLIENT, tenant: 'contoso.onmicrosoft.com' });
    await updateAuthSettings({ tenant: '' });
    assert.strictEqual(getAuthSettings().tenant, '');
    assert.strictEqual(getAuthSettings().clientId, CLIENT);
  });

  test('rejects invalid values and keeps the old ones', async () => {
    initAuthSettings(memoryMemento());
    await updateAuthSettings({ clientId: CLIENT });
    await assert.rejects(updateAuthSettings({ clientId: 'not-a-guid' }));
    await assert.rejects(updateAuthSettings({ tenant: 'x & calc' }));
    await assert.rejects(updateAuthSettings({ tenant: 'a VSCODE_CLIENT_ID:evil' }));
    await assert.rejects(updateAuthSettings({ method: 'other' as never }));
    assert.deepStrictEqual(getAuthSettings(), { ...DEFAULT_AUTH_SETTINGS, clientId: CLIENT });
  });

  test('ignores invalid stored values', () => {
    initAuthSettings(memoryMemento({ [KEY]: { method: 'nope', clientId: 'x y', tenant: 'a;b' } }));
    assert.deepStrictEqual(getAuthSettings(), DEFAULT_AUTH_SETTINGS);
  });
});
