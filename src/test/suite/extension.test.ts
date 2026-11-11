// Shared tests: run in desktop VS Code (`npm test`) and in the browser (`npm run test:web`).
import * as assert from 'assert';
import * as vscode from 'vscode';
import { Commands, EXTENSION_FULL_ID } from '../../constants';

suite('Extension', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_FULL_ID);
    assert.ok(ext, 'extension not found');
    await ext.activate();
  });

  test('the notebook reference settings apply in Restricted Mode, like src/fabric-supersat.yaml', () => {
    const json = vscode.extensions.getExtension(EXTENSION_FULL_ID)!.packageJSON as {
      capabilities: { untrustedWorkspaces: { restrictedConfigurations?: string[] } };
    };
    assert.deepStrictEqual(json.capabilities.untrustedWorkspaces.restrictedConfigurations ?? [], []);
  });

  test('registers its commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of Object.values(Commands)) {
      assert.ok(all.includes(id), `missing command ${id}`);
    }
  });
});
