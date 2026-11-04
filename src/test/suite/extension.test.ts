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

  test('registers its commands', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of Object.values(Commands)) {
      assert.ok(all.includes(id), `missing command ${id}`);
    }
  });
});
