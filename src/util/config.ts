import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';

/**
 * Typed accessor for this extension's VS Code settings (see `contributes.configuration`).
 * Sign-in settings are deliberately not VS Code settings: see `auth/settings.ts`.
 */
export function getConfig() {
  const config = vscode.workspace.getConfiguration(ID_PREFIX);
  return {
    workspace: {
      name: config.get<string>('workspace.name', '').trim(),
    },
  };
}
