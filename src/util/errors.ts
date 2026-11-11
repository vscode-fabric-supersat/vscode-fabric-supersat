import * as vscode from 'vscode';
import { Commands } from '../constants';
import { type ErrorFix, fixOf, isQuiet, isWarning } from './errorFix';
import { getLogger } from './logger';
import { notify } from './notify';

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

/** The error's own fix (see `util/errorFix.ts`), else one for a Microsoft Entra error code in its message. */
function fixFor(err: unknown, message: string): ErrorFix {
  const own = fixOf(err);
  if (own) {
    return own;
  }
  const code = /AADSTS\d+/.exec(message)?.[0];
  return (code && ENTRA_HINTS[code]) || {};
}

/** Words that keep their capital when a message continues a sentence (names, not sentence starts). */
const PROPER_NOUNS = new Set(['Fabric', 'Azure', 'Microsoft', 'VS', 'Entra', 'OneLake', 'Power', 'PySpark', 'Python', 'Spark', 'Jupyter', 'Git', 'Windows', 'I']);

/**
 * A message continuing a sentence ("could not proceed: no Fabric workspace…"): its first
 * letter lowercased when its first word is an ordinary capitalised word, not a name, file
 * name, path or acronym.
 */
export function continueSentence(message: string): string {
  const first = message.split(/\s/, 1)[0];
  return /^[A-Z][a-z]+$/.test(first) && !PROPER_NOUNS.has(first) ? message[0].toLowerCase() + message.slice(1) : message;
}

/** How `reportError` logs and shows an error: its level, its text, and the fix it offers. */
export function describeError(action: string, err: unknown): { level: 'info' | 'warn' | 'error'; text: string; fix: ErrorFix } {
  const message = err instanceof Error ? err.message : String(err);
  if (isQuiet(err)) {
    return { level: 'info', text: `${action}: ${message}`, fix: {} };
  }
  const fix = fixFor(err, message);
  // The hint is its own sentence: end the message with a full stop first if it has none.
  const hint = fix.hint ? `${/[.!?]$/.test(message) ? '' : '.'} ${fix.hint}` : '';
  return isWarning(err)
    ? { level: 'warn', text: `${action} could not proceed: ${continueSentence(message)}${hint}`, fix }
    : { level: 'error', text: `${action} failed: ${message}${hint}`, fix };
}

/**
 * Logs an error and shows it to the user with buttons that lead to a fix, without waiting for
 * the notification to be closed. `action` is the
 * command's title, e.g. "Download All Notebooks".
 *
 * - The user cancelled (`QuietError`): logged as info, not shown.
 * - Something the user can see to (`WarningError`, e.g. sign-in declined or no workspace with
 *   the saved name): "<action> could not proceed: …", logged and shown as a warning.
 * - Anything else is unexpected (a bug, or a Fabric failure): "<action> failed: …", logged
 *   with its stack trace and shown as an error.
 */
export async function reportError(action: string, err: unknown): Promise<void> {
  const { level, text, fix } = describeError(action, err);
  if (level === 'info') {
    getLogger().info(text);
    return;
  }
  const warning = level === 'warn';
  if (warning) {
    getLogger().warn(text);
  } else {
    getLogger().error(`${action} failed`, err);
  }

  const runCommand = fix.terminalCommand ? `Run "${fix.terminalCommand}"` : undefined;
  const openLink = fix.link?.label;
  const configure = fix.configureSignIn ? 'Configure Sign-In' : undefined;
  const selectWorkspace = fix.selectWorkspace ? 'Select Workspace' : undefined;
  const openSettings = fix.setting ? 'Open Settings' : undefined;
  const showLog = 'Show Log';
  const buttons = [runCommand, openLink, configure, selectWorkspace, openSettings, showLog].filter((b): b is string => !!b);

  // Not awaited: the command finishes now, and a button still works while the notification is open.
  notify(warning ? 'warning' : 'error', text, buttons, async (choice) => {
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
  });
}
