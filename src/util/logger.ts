import * as vscode from 'vscode';
import { recordLogLine } from './diagnostics';

let channel: vscode.LogOutputChannel | undefined;

const LEVELS = [
  ['trace', vscode.LogLevel.Trace],
  ['debug', vscode.LogLevel.Debug],
  ['info', vscode.LogLevel.Info],
  ['warn', vscode.LogLevel.Warning],
  ['error', vscode.LogLevel.Error],
] as const;

/**
 * Shared log channel ("Output" panel → "Fabric Supersat"). Created lazily on first use.
 * Lines shown in the channel (at its log level) are also copied to
 * `.fabric-supersat/logs/fabric-supersat.log` (see `util/diagnostics.ts`).
 */
export function getLogger(): vscode.LogOutputChannel {
  if (!channel) {
    const created = vscode.window.createOutputChannel('Fabric Supersat', { log: true });
    for (const [name, level] of LEVELS) {
      const original = created[name].bind(created) as (message: string | Error, ...args: unknown[]) => void;
      (created as unknown as Record<string, unknown>)[name] = (message: string | Error, ...args: unknown[]) => {
        original(message, ...args);
        if (created.logLevel !== vscode.LogLevel.Off && level >= created.logLevel) {
          recordLogLine(name, [message, ...args].map(describe).join(' '));
        }
      };
    }
    channel = created;
  }
  return channel;
}

function describe(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function disposeLogger(): void {
  channel?.dispose();
  channel = undefined;
}
