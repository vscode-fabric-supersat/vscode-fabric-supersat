import * as vscode from 'vscode';

/** Runs a task with a "Fabric: <title>" progress notification. */
export function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: ${title}` },
    task,
  );
}
