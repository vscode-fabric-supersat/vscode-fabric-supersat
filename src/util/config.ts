import * as vscode from 'vscode';
import type { AuthMethodSetting } from '../auth/service';
import { ID_PREFIX } from '../constants';

/** Typed accessor for this extension's settings (see `contributes.configuration`). */
export function getConfig() {
  const config = vscode.workspace.getConfiguration(ID_PREFIX);
  return {
    auth: {
      method: config.get<AuthMethodSetting>('auth.method', 'auto'),
      clientId: config.get<string>('auth.clientId', '').trim(),
      tenant: config.get<string>('auth.tenant', '').trim(),
    },
    workspace: {
      id: config.get<string>('workspace.id', '').trim(),
      name: config.get<string>('workspace.name', '').trim(),
    },
  };
}
