/**
 * Local diagnostic and history files in `.fabric-supersat/` (git-ignored):
 *
 * - `diagnostics/requests.jsonl`: one line per Fabric request (time, command, method, path,
 *   status, duration, retries) and per long-running operation (polls, time waited). Never
 *   tokens or contents. Supports finding out where time goes.
 * - `logs/fabric-supersat.log`: a copy of the Output channel, readable after VS Code closes.
 * - `history.jsonl`: each notebook download and upload: which notebook, which workspace,
 *   when, and which IDs changed.
 *
 * Files are written only while the folder is trusted, only if `.fabric-supersat` already
 * exists (logging never creates it, so it never asks), and only while the
 * `diagnostics.logToFiles` setting is on. Each file is capped: when it would grow past
 * its limit it is renamed to `<name>.1` (replacing an older one) and a new file started.
 */
import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import { assertSafeWritePath, exists, localStateDir, projectRoot } from './localState';

export const REQUESTS_FILE = ['diagnostics', 'requests.jsonl'] as const;
export const LOG_FILE = ['logs', 'fabric-supersat.log'] as const;
export const HISTORY_FILE = ['history.jsonl'] as const;
const MAX_BYTES = 2 * 1024 * 1024;
const FLUSH_MS = 1000;

/** One Fabric HTTP request, or a summary of one long-running operation. */
export interface RequestRecord {
  kind: 'request' | 'operation';
  method: string;
  /** Host and path (with query), never the token. */
  url: string;
  status?: number;
  ms: number;
  /** Requests: the attempt number (retries after 429 are 2, 3...). */
  attempt?: number;
  /** Requests: the Retry-After Fabric asked for, in ms. */
  retryAfterMs?: number;
  /** Operations: how many times its status was polled, and how long was spent waiting between polls. */
  polls?: number;
  waitedMs?: number;
}

export interface HistoryRecord {
  action: 'download' | 'upload';
  notebook: string;
  workspace: string;
  result: 'downloaded' | 'created' | 'updated' | 'failed';
  /** IDs changed on upload (see `notebooks/references.ts`). */
  replaced?: string[];
  error?: string;
}

/** Where the local files go: `.fabric-supersat` in the trusted project, if it exists and logging is on. */
type Target = () => Promise<vscode.Uri | undefined>;

const defaultTarget: Target = async () => {
  const root = projectRoot();
  if (!root || !vscode.workspace.isTrusted) {
    return undefined;
  }
  if (!vscode.workspace.getConfiguration(ID_PREFIX).get<boolean>('diagnostics.logToFiles', true)) {
    return undefined;
  }
  const dir = localStateDir(root);
  return (await exists(dir)) ? dir : undefined;
};

let target: Target = defaultTarget;

/** For tests: where the files go (or `undefined` to write none). Pass nothing to restore the default. */
export function setDiagnosticsTarget(next?: Target): void {
  target = next ?? defaultTarget;
}

/** Lines waiting to be written, per file. */
const pending = new Map<string, { path: readonly string[]; lines: string[] }>();
let timer: ReturnType<typeof setTimeout> | undefined;
/** Writes in order, one at a time. */
let writing: Promise<void> = Promise.resolve();

function queue(path: readonly string[], line: string): void {
  const key = path.join('/');
  const entry = pending.get(key) ?? { path, lines: [] };
  entry.lines.push(line);
  pending.set(key, entry);
  timer ??= setTimeout(() => void flushDiagnostics(), FLUSH_MS);
}

/** Writes everything queued. Called on a timer, at the end of each command, and on deactivation. */
export function flushDiagnostics(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  const batch = [...pending.values()];
  pending.clear();
  writing = writing.then(async () => {
    if (!batch.length) {
      return;
    }
    let dir: vscode.Uri | undefined;
    try {
      dir = await target();
    } catch {
      dir = undefined;
    }
    if (!dir) {
      return;
    }
    for (const { path, lines } of batch) {
      try {
        await appendCapped(dir, vscode.Uri.joinPath(dir, ...path), `${lines.join('\n')}\n`);
      } catch {
        // Diagnostics must never break a command.
      }
    }
  });
  return writing;
}

/** Appends `text`, starting a new file (keeping one older) when the file would pass `MAX_BYTES`. */
export async function appendCapped(dir: vscode.Uri, file: vscode.Uri, text: string, maxBytes = MAX_BYTES): Promise<void> {
  await assertSafeWritePath(dir, file);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
  const added = new TextEncoder().encode(text);
  let existing: Uint8Array = new Uint8Array();
  try {
    existing = await vscode.workspace.fs.readFile(file);
  } catch {
    // No file yet.
  }
  if (existing.length && existing.length + added.length > maxBytes) {
    const older = file.with({ path: `${file.path}.1` });
    await assertSafeWritePath(dir, older);
    await vscode.workspace.fs.rename(file, older, { overwrite: true });
    existing = new Uint8Array();
  }
  const next = new Uint8Array(existing.length + added.length);
  next.set(existing);
  next.set(added, existing.length);
  await vscode.workspace.fs.writeFile(file, next);
}

/** The command currently running, which requests are counted against. */
interface Activity {
  name: string;
  started: number;
  requests: number;
  operations: number;
  waitedMs: number;
  retries: number;
}
let activity: Activity | undefined;

/** Records one Fabric request (passed to `FabricClient` as `onRequest`). */
export function recordRequest(record: RequestRecord): void {
  if (activity) {
    if (record.kind === 'request') {
      activity.requests++;
      if ((record.attempt ?? 1) > 1) {
        activity.retries++;
      }
    } else {
      activity.operations++;
      activity.waitedMs += record.waitedMs ?? 0;
    }
  }
  queue(REQUESTS_FILE, JSON.stringify({ time: new Date().toISOString(), command: activity?.name, ...record }));
}

/** Records a notebook download or upload in `history.jsonl`. */
export function recordHistory(record: HistoryRecord): void {
  queue(HISTORY_FILE, JSON.stringify({ time: new Date().toISOString(), ...record }));
}

/** Copies a log line to `logs/fabric-supersat.log`. */
export function recordLogLine(level: string, message: string): void {
  queue(LOG_FILE, `${new Date().toISOString()} [${level}] ${message}`);
}

export interface ActivitySummary {
  name: string;
  ms: number;
  requests: number;
  operations: number;
  waitedMs: number;
  retries: number;
}

/**
 * Runs a command, counting its Fabric requests, and reports a one-line summary (e.g.
 * "Download All Notebooks: 74 requests, 37 operations, 6m12s, 4m50s waiting on Fabric").
 * Commands rarely overlap; if they do, requests count towards the latest.
 */
export async function withActivity<T>(
  name: string,
  run: () => Promise<T>,
  report: (summary: ActivitySummary, line: string) => void,
): Promise<T> {
  const previous = activity;
  const current: Activity = { name, started: Date.now(), requests: 0, operations: 0, waitedMs: 0, retries: 0 };
  activity = current;
  try {
    return await run();
  } finally {
    activity = previous;
    if (current.requests) {
      const summary = { ...current, ms: Date.now() - current.started };
      report(summary, summaryLine(summary));
    }
    void flushDiagnostics();
  }
}

export function summaryLine(s: ActivitySummary): string {
  return (
    `${s.name}: ${s.requests} request${s.requests === 1 ? '' : 's'}` +
    (s.operations ? `, ${s.operations} long-running operation${s.operations === 1 ? '' : 's'}` : '') +
    (s.retries ? `, ${s.retries} retried after throttling` : '') +
    `, ${duration(s.ms)}` +
    (s.waitedMs ? `, of which ${duration(s.waitedMs)} waiting on Fabric (summed over concurrent requests)` : '')
  );
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
}
