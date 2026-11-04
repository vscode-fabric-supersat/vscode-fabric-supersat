// Desktop entry point (package.json "main"). May use Node.js APIs.
import * as vscode from 'vscode';
import { createExtension } from '../extension';
import { getConfig } from '../util/config';
import { AzureCliTokenProvider } from './azureCli';

export const { activate, deactivate } = createExtension({
  name: 'desktop',
  platformTokenProviders: () => [
    new AzureCliTokenProvider({
      getTenant: () => getConfig().auth.tenant,
      preferDeviceCode: cannotOpenLocalBrowser(),
    }),
  ],
});

/**
 * Whether `az login`'s browser sign-in would fail here: its redirect goes to localhost
 * on the machine running this extension host, which the user's browser can't reach in a
 * remote window (SSH, WSL, containers, tunnels), in browser-based VS Code (Codespaces,
 * Coder, `code serve-web`), or on Linux without a display.
 */
function cannotOpenLocalBrowser(): boolean {
  const headlessLinux =
    process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  return vscode.env.remoteName !== undefined || vscode.env.uiKind === vscode.UIKind.Web || headlessLinux;
}
