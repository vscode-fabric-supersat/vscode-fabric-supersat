import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

/** Shared log channel ("Output" panel → "Fabric Supersat"). Created lazily on first use. */
export function getLogger(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Fabric Supersat', { log: true });
  return channel;
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
