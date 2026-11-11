import * as vscode from 'vscode';
import { PastedTokenProvider } from './auth/pastedToken';
import { FabricAuth } from './auth/service';
import { initAuthSettings } from './auth/settings';
import type { TokenProvider } from './auth/types';
import { VscodeSessionProvider } from './auth/vscodeSession';
import { FabricClient } from './fabric/client';
import type { Services } from './features/feature';
import { features } from './features';
import { flushDiagnostics, recordRequest } from './util/diagnostics';
import { askToCreateLocalStateDir, onLocalGitignoreRepaired, setLocalStateDirConfirmation } from './util/localState';
import { disposeLogger, getLogger } from './util/logger';
import { withProgress } from './util/progress';
import { NotebookSettings } from './notebooks/notebookSettings';
import { ProjectSettings } from './workspace/projectSettings';
import { showWorkspacePicker, WorkspaceService } from './workspace/service';

/** What differs between the desktop (Node.js) and web (browser) builds. */
export interface Platform {
  readonly name: 'desktop' | 'web';
  /** Sign-in methods only this platform supports (e.g. the Azure CLI on desktop). */
  platformTokenProviders(context: vscode.ExtensionContext): TokenProvider[];
}

/**
 * Shared activation used by both entry points: `src/node/extension.ts` (package.json
 * `main`) and `src/web/extension.ts` (`browser`). One failing feature is logged and does
 * not prevent the others from activating.
 */
export function createExtension(platform: Platform) {
  return {
    async activate(context: vscode.ExtensionContext): Promise<void> {
      const logger = getLogger();
      logger.info(`Activating ${platform.name} build (${vscode.env.appName}, ${vscode.UIKind[vscode.env.uiKind]})`);

      // Always ask before creating a project's .fabric-supersat folder.
      setLocalStateDirConfirmation(askToCreateLocalStateDir);
      // Say so when its .gitignore had to be repaired: files may already have been committed.
      context.subscriptions.push(
        onLocalGitignoreRepaired((gitignore) => {
          const file = vscode.workspace.asRelativePath(gitignore);
          const message =
            `${file} didn't make git ignore everything in the folder, so it was replaced. Its files (workspace metadata ` +
            'with member emails and connection strings, logs, notebooks\' local outputs) aren\'t for source control. ' +
            'If any were committed already, untrack them with "git rm -r --cached .fabric-supersat".';
          logger.warn(message);
          void vscode.window.showWarningMessage(message);
        }),
      );

      // Sign-in settings come from the extension's own state, never from settings files.
      initAuthSettings(context.globalState);
      const auth = new FabricAuth([
        ...platform.platformTokenProviders(context),
        new VscodeSessionProvider(),
        new PastedTokenProvider({
          secrets: context.secrets,
          prompt: (options) => vscode.window.showInputBox(options),
          showHelp: (message) => {
            logger.info(message);
            logger.show(true); // keep focus in the input box
          },
        }),
      ]);
      const fabric = new FabricClient({
        getToken: () => auth.getToken('fabric', 'Fabric Supersat needs to sign in to read your Fabric workspaces.'),
        onRequest: recordRequest,
      });
      const settings = new ProjectSettings();
      const workspace = new WorkspaceService({
        list: async () => withProgress('Loading workspaces…', () => fabric.listWorkspaces()),
        pick: showWorkspacePicker,
        settings,
      });
      context.subscriptions.push(workspace);
      const services: Services = { auth, fabric, workspace, notebookSettings: new NotebookSettings() };

      for (const feature of features) {
        try {
          await feature.activate(context, services);
          logger.debug(`Feature activated: ${feature.name}`);
        } catch (err) {
          logger.error(`Feature "${feature.name}" failed to activate`, err);
        }
      }
    },

    async deactivate(): Promise<void> {
      await flushDiagnostics();
      disposeLogger();
    },
  };
}
