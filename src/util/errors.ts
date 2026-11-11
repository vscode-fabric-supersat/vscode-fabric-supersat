import * as vscode from 'vscode';
import { AuthCancelledError, AuthError } from '../auth/types';
import { Commands } from '../constants';
import { FabricApiError } from '../fabric/client';
import { WorkspaceNameError } from '../workspace/service';
import { getLogger } from './logger';

const CONFIGURE = '"Fabric Supersat: Configure Sign-In"';

/** Fixes for Microsoft Entra (AADSTS…) errors from VS Code sign-in with an app registration. */
const ENTRA_HINTS: Record<string, { hint: string; configureSignIn?: boolean }> = {
  // First-party app (e.g. VS Code's own) not pre-authorized for the Fabric API.
  AADSTS65002: { hint: `Use your own app registration: set its client ID with ${CONFIGURE}.`, configureSignIn: true },
  // Single-tenant app used with the multi-tenant `organizations` endpoint.
  AADSTS50194: { hint: `Your app registration is single-tenant: set its tenant with ${CONFIGURE}.`, configureSignIn: true },
  // Client ID not found in the tenant.
  AADSTS700016: { hint: `Check the client ID and tenant with ${CONFIGURE}.`, configureSignIn: true },
  // Redirect URI not registered on the app.
  AADSTS50011: {
    hint: 'Add the redirect URIs http://localhost and https://vscode.dev/redirect to your app registration.',
  },
  // Device code fallback needs public client flows.
  AADSTS7000218: { hint: 'Enable "Allow public client flows" on your app registration.' },
  // Permission not granted and user consent not allowed.
  AADSTS65001: { hint: 'Grant consent for the API permissions on your app registration (may need an admin).' },
  AADSTS90094: { hint: 'An admin must grant consent for the API permissions on your app registration.' },
};

interface Fix {
  hint?: string;
  /** A VS Code setting to open. Never a sign-in setting: those use `configureSignIn`. */
  setting?: string;
  configureSignIn?: boolean;
  /** Offer the "Select Workspace" command. */
  selectWorkspace?: boolean;
  terminalCommand?: string;
  link?: { label: string; url: string };
}

function fixFor(err: unknown, message: string): Fix {
  if (err instanceof AuthError) {
    return err.fix;
  }
  if (err instanceof FabricApiError && err.status === 401) {
    return { hint: 'Your sign-in may have expired: run "Fabric Supersat: Sign In to Fabric".', configureSignIn: true };
  }
  if (err instanceof WorkspaceNameError) {
    return { selectWorkspace: true };
  }
  if (err instanceof FabricApiError && (err.status === 403 || err.status === 404)) {
    // Usually a saved workspace that was deleted, or that belongs to another tenant.
    return { hint: 'Check the workspace: run "Fabric Supersat: Select Workspace".', selectWorkspace: true };
  }
  const code = /AADSTS\d+/.exec(message)?.[0];
  return (code && ENTRA_HINTS[code]) || {};
}

/** Logs an error and shows it to the user with buttons that lead to a fix. */
export async function reportError(action: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof AuthCancelledError) {
    getLogger().info(`${action}: ${message}`);
    return;
  }
  getLogger().error(`${action} failed`, err);

  const fix = fixFor(err, message);
  const runCommand = fix.terminalCommand ? `Run "${fix.terminalCommand}"` : undefined;
  const openLink = fix.link?.label;
  const configure = fix.configureSignIn ? 'Configure Sign-In' : undefined;
  const selectWorkspace = fix.selectWorkspace ? 'Select Workspace' : undefined;
  const openSettings = fix.setting ? 'Open Settings' : undefined;
  const showLog = 'Show Log';
  const buttons = [runCommand, openLink, configure, selectWorkspace, openSettings, showLog].filter((b): b is string => !!b);

  const text = `${action} failed: ${message}${fix.hint ? ` ${fix.hint}` : ''}`;
  const choice = await vscode.window.showErrorMessage(text, ...buttons);
  if (choice === undefined) {
    return;
  }
  if (choice === runCommand && fix.terminalCommand) {
    const terminal = vscode.window.createTerminal('Fabric Supersat: Azure CLI');
    terminal.show();
    terminal.sendText(fix.terminalCommand);
  } else if (choice === openLink && fix.link) {
    await vscode.env.openExternal(vscode.Uri.parse(fix.link.url));
  } else if (choice === selectWorkspace) {
    await vscode.commands.executeCommand(Commands.selectWorkspace);
  } else if (choice === configure) {
    await vscode.commands.executeCommand(Commands.configureSignIn);
  } else if (choice === openSettings && fix.setting) {
    await vscode.commands.executeCommand('workbench.action.openSettings', fix.setting);
  } else if (choice === showLog) {
    await vscode.commands.executeCommand(Commands.showLog);
  }
}
