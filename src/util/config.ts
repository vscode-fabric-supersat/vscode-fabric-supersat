import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import type { ReferenceSettings } from '../notebooks/references';

/** The default Python version of new Python notebooks (`fabric-supersat.notebooks.pythonVersion`). */
export const DEFAULT_PYTHON_VERSION = '3.12';
/** A Python version as Fabric names it in `jupyter_kernel_name` (`python3.12`): 3.minor. */
export const PYTHON_VERSION_PATTERN = /^3\.\d{1,2}$/;

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
    reports: {
      /**
       * Whether "Refresh Workspace Information" and "Test Notebook Formats" open their Markdown
       * report when done; otherwise a notification offers to open it.
       */
      openWhenDone: config.get<boolean>('reports.openWhenDone', true),
    },
    metadata: {
      /** Whether "Refresh Workspace Information" includes who has which role in the workspace. */
      includeMemberRoles: config.get<boolean>('metadata.includeMemberRoles', true),
    },
    notebooks: {
      /** Python version of new Python (non-Spark) notebooks, e.g. `3.12`; the default if the setting isn't major.minor. */
      pythonVersion: pythonVersion(config.get<string>('notebooks.pythonVersion')),
      /** What upload does with lakehouse and environment references (see `notebooks/references.ts`). */
      references: {
        upload: {
          defaultLakehouse: uploadMode('notebooks.upload.defaultLakehouse'),
          otherLakehouses: uploadMode('notebooks.upload.otherLakehouses'),
          environment: uploadMode('notebooks.upload.environment'),
        },
      } satisfies ReferenceSettings,
    },
  };
}

function pythonVersion(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && PYTHON_VERSION_PATTERN.test(trimmed) ? trimmed : DEFAULT_PYTHON_VERSION;
}
