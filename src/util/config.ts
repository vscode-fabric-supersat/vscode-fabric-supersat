import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import type { ReferenceSettings } from '../notebooks/references';

/**
 * Typed accessor for this extension's VS Code settings (see `contributes.configuration`).
 * Sign-in settings are deliberately not VS Code settings: see `auth/settings.ts`.
 */
export function getConfig() {
  const config = vscode.workspace.getConfiguration(ID_PREFIX);
  const uploadMode = (key: string) => (config.get<string>(key) === 'keep' ? ('keep' as const) : ('replace' as const));
  return {
    workspace: {
      name: config.get<string>('workspace.name', '').trim(),
    },
    metadata: {
      /** Whether "Refresh Workspace Information" includes who has which role in the workspace. */
      includeMemberRoles: config.get<boolean>('metadata.includeMemberRoles', true),
    },
    notebooks: {
      /** What upload and download do with lakehouse and environment references (see `notebooks/references.ts`). */
      references: {
        upload: {
          defaultLakehouse: uploadMode('notebooks.upload.defaultLakehouse'),
          otherLakehouses: uploadMode('notebooks.upload.otherLakehouses'),
          environment: uploadMode('notebooks.upload.environment'),
        },
        currentWorkspace: {
          defaultLakehouse: config.get<boolean>('notebooks.currentWorkspace.defaultLakehouse') === true,
          environment: config.get<boolean>('notebooks.currentWorkspace.environment') === true,
        },
      } satisfies ReferenceSettings,
    },
  };
}
