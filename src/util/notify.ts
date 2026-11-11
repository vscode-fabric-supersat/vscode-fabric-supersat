import * as vscode from 'vscode';
import { getLogger } from './logger';

export type NotifyLevel = 'info' | 'warning' | 'error';

const SHOW = {
  info: vscode.window.showInformationMessage,
  warning: vscode.window.showWarningMessage,
  error: vscode.window.showErrorMessage,
} as const;

/**
 * Shows a non-modal notification with buttons without waiting for it. A notification with
 * buttons stays open until it's clicked or closed (and only hides into the notification
 * centre, still open), so a command that awaited it wouldn't finish until then, and nor would
 * anything waiting on the command. `onChoice` runs when a button is clicked; an error it
 * throws is logged.
 *
 * Use an awaited modal (`{ modal: true }`) instead when the command needs the answer to go on.
 */
export function notify(
  level: NotifyLevel,
  message: string,
  buttons: readonly string[],
  onChoice?: (choice: string) => unknown,
): void {
  SHOW[level](message, ...buttons).then(
    async (choice) => {
      if (choice === undefined || !onChoice) {
        return;
      }
      try {
        await onChoice(choice);
      } catch (err) {
        getLogger().error(`"${choice}" failed`, err);
      }
    },
    (err: unknown) => getLogger().error('Showing a notification failed', err),
  );
}
