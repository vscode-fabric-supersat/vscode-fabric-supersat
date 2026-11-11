import * as vscode from 'vscode';
import { Commands } from '../constants';
import { reportError } from '../util/errors';
import type { SavedWorkspace } from '../workspace/service';
import type { Feature } from './feature';
import { registerCommand } from '../util/commands';

/** "Select Workspace" command, and a status bar item showing the selected Fabric workspace. */
export const workspace: Feature = {
  name: 'workspace',
  activate(context, { workspace }) {
    const item = vscode.window.createStatusBarItem('fabric-supersat.workspace', vscode.StatusBarAlignment.Left);
    item.name = 'Fabric Workspace';
    item.command = Commands.selectWorkspace;
    const render = (ws: SavedWorkspace | undefined) => {
      item.text = `$(folder-library) ${ws ? ws.name : 'Select Fabric Workspace'}`;
      item.tooltip = ws ? `Selected Fabric workspace: ${ws.name}\n\nClick to change.` : 'Select a Fabric workspace';
    };
    render(workspace.selected);
    item.show();

    context.subscriptions.push(
      item,
      workspace.onDidChange(render),
      registerCommand(Commands.selectWorkspace, 'Select Workspace', async () => {
        try {
          const selected = await workspace.select();
          if (selected?.nameShared) {
            void vscode.window.showWarningMessage(
              `Fabric workspace set to "${selected.name}" (ID ${selected.id}). Other workspaces have the same name, ` +
                'so this ID is used until VS Code restarts; then you will be asked to pick again. ' +
                'Renaming the workspaces in Fabric avoids this.',
            );
          } else if (selected) {
            void vscode.window.showInformationMessage(`Fabric workspace set to "${selected.name}".`);
          }
          return selected;
        } catch (err) {
          await reportError('Select Workspace', err);
          return undefined;
        }
      }),
    );
  },
};
