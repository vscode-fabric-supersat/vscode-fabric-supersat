import * as vscode from 'vscode';
import { Commands } from '../constants';
import { getLogger } from '../util/logger';
import type { Feature } from './feature';

export const log: Feature = {
  name: 'log',
  activate(context) {
    context.subscriptions.push(
      vscode.commands.registerCommand(Commands.showLog, () => getLogger().show()),
    );
  },
};
