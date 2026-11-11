import * as vscode from 'vscode';
import { Commands, EXTENSION_FULL_ID } from '../constants';
import type { Feature } from './feature';
import { registerCommand } from '../util/commands';

export const settings: Feature = {
  name: 'settings',
  activate(context) {
    context.subscriptions.push(
      registerCommand(Commands.openSettings, 'Open Settings', () =>
        vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${EXTENSION_FULL_ID}`),
      ),
    );
  },
};
