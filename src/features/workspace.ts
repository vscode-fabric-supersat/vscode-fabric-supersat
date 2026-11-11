import * as vscode from 'vscode';
import { Commands } from '../constants';
import { reportError } from '../util/errors';
import type { SavedWorkspace } from '../workspace/service';
import type { Feature } from './feature';

/** "Select Workspace" command, and a status bar item showing the current Fabric workspace. */
export const workspace: Feature = {
  name: 'workspace',
  activate(context, { workspace }) {
    const item = vscode.window.createStatusBarItem('fabric-supersat.workspace', vscode.StatusBarAlignment.Left);
    item.name = 'Fabric Workspace';
    item.command = Commands.selectWorkspace;
    const render = (ws: SavedWorkspace | undefined) => {
      item.text = `$(folder-library) ${ws ? ws.name : 'Select Fabric Workspace'}`;
      item.tooltip = ws ? `Fabric workspace: ${ws.name}\n${ws.id}\n\nClick to change.` : 'Select a Fabric workspace';
    };
    render(workspace.current);
    item.show();

    context.subscriptions.push(
      item,
      workspace.onDidChange(render),
      vscode.commands.registerCommand(Commands.selectWorkspace, async () => {
        try {
          const selected = await workspace.select();
          if (selected) {
            void vscode.window.showInformationMessage(`Fabric workspace set to "${selected.name}".`);
          }
          return selected;
        } catch (err) {
          await reportError('Select workspace', err);
          return undefined;
        }
      }),
    );
  },
};
