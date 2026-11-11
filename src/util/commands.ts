import * as vscode from 'vscode';
import { withActivity } from './diagnostics';
import { getLogger } from './logger';

/**
 * Registers a command that logs two lines: "Starting <title>…" when it starts and
 * "Finished <title>: …" when it ends, with its Fabric requests and how long it took (see
 * `withActivity`). Every command goes through here, so the log shows where each one begins
 * and ends, and `requests.jsonl` names the command each request was for.
 */
export function registerCommand<A extends unknown[], R>(
  id: string,
  title: string,
  handler: (...args: A) => R | Thenable<R>,
): vscode.Disposable {
  return vscode.commands.registerCommand(id, (...args: A) =>
    withActivity(
      title,
      async () => handler(...args),
      (_summary, line) => getLogger().info(line),
      (line) => getLogger().info(line),
    ),
  );
}
