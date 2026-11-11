import * as vscode from 'vscode';
import { PastedTokenProvider } from './auth/pastedToken';
import { FabricAuth } from './auth/service';
import type { TokenProvider } from './auth/types';
import { VscodeSessionProvider } from './auth/vscodeSession';
import { FabricClient } from './fabric/client';
import type { Services } from './features/feature';
import { features } from './features';
import { disposeLogger, getLogger } from './util/logger';
import { WorkspaceService, createWorkspacePicker } from './workspace/service';

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
      });
      const workspace = new WorkspaceService({ pick: createWorkspacePicker(fabric) });
      context.subscriptions.push(workspace);
      const services: Services = { auth, fabric, workspace };

      for (const feature of features) {
        try {
          await feature.activate(context, services);
          logger.debug(`Feature activated: ${feature.name}`);
        } catch (err) {
          logger.error(`Feature "${feature.name}" failed to activate`, err);
        }
      }
    },

    deactivate(): void {
      disposeLogger();
    },
  };
}
