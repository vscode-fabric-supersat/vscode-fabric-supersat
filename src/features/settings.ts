import * as vscode from 'vscode';
import { Commands, EXTENSION_FULL_ID } from '../constants';
import type { Feature } from './feature';

export const settings: Feature = {
  name: 'settings',
  activate(context) {
    context.subscriptions.push(
      vscode.commands.registerCommand(Commands.openSettings, () =>
        vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_FULL_ID}`),
      ),
    );
  },
};
