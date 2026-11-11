/**
 * Local diagnostic and history files in `.fabric-supersat/` (git-ignored):
 *
 * - `diagnostics/requests.jsonl`: one line per Fabric request (time, command, method, path,
 *   status, duration, retries) and per long-running operation (polls, time waited). Never
 *   tokens or contents. Supports finding out where time goes.
 * - `diagnostics/fabric-supersat.log`: a copy of the Output channel, readable after VS Code closes.
 * - `diagnostics/history.jsonl`: each notebook download and upload: which notebook, which workspace,
 *   when, and which IDs changed.
 *
 * Files are written only while the folder is trusted, only if `.fabric-supersat` already
 * exists (logging never creates it, so it never asks), and only while the
 * `diagnostics.logToFiles` setting is on. Each file is capped: when it would grow past
 * its limit it is renamed to `<name>.1` (replacing an older one) and a new file started.
 */
import * as vscode from 'vscode';
import type { ItemKind } from '../items/kinds';
import { ID_PREFIX } from '../constants';
import { assertSafeWritePath, exists, localStateDir, projectRoot } from './localState';

export const REQUESTS_FILE = ['diagnostics', 'requests.jsonl'] as const;
export const LOG_FILE = ['diagnostics', 'fabric-supersat.log'] as const;
export const HISTORY_FILE = ['diagnostics', 'history.jsonl'] as const;
const MAX_BYTES = 2 * 1024 * 1024;
const FLUSH_MS = 1000;

/**
 * One Fabric HTTP request, a summary of one long-running operation, or a pause of a quota
 * bucket's requests after Fabric throttled one (HTTP 429; `ms` is the pause).
 */
export interface RequestRecord {
  kind: 'request' | 'operation' | 'throttle';
  method: string;
  /** Host and path (with query), never the token. */
  url: string;
  status?: number;
  ms: number;
  /** Requests: the attempt number (retries after 429 are 2, 3...). */
  attempt?: number;
  /** Requests: the Retry-After Fabric asked for, in ms. */
  retryAfterMs?: number;
  /** Requests: how many requests were running when it was sent, itself included. */
  inFlight?: number;
  /** Throttles: the quota bucket paused (`platform` or `operations`). */
  bucket?: 'platform' | 'operations';
  /** Throttles: `rate` (too many requests: the bucket's budget is halved) or `capacity` (the Fabric capacity is overloaded: backoff). */
  reason?: 'rate' | 'capacity';
  /** Throttles: the bucket's budget after it, requests per second and burst. */
  ratePerSecond?: number;
  burst?: number;
  /** Operations: how many times its status was polled, and how long was spent waiting between polls. */
  polls?: number;
  waitedMs?: number;
  /** Operations: how long Fabric took to run it (its createdTimeUtc to lastUpdatedTimeUtc), if Fabric said. */
  fabricMs?: number;
  /**
   * Requests and operations: the long-running operation it belongs to (Fabric's
   * `x-ms-operation-id`), on the request Fabric accepted (202), each status check, the result
   * fetch, and the operation's summary, so they can be matched up.
   */
  operationId?: string;
  /** Status checks: the operation's state Fabric reported (`Running`, `Succeeded`, `Failed`...), and how far along it said it was. */
  state?: string;
  percentComplete?: number;
  /**
   * Operations: how it ended. `succeeded`; `failed` (Fabric reported it failed); `timedOut`
   * (not finished within 10 minutes); or `error` (the client couldn't follow it: a network
   * error, a missing or untrusted operation URL, or a failed result fetch).
   */
  result?: 'succeeded' | 'failed' | 'timedOut' | 'error';
  /** Operations that didn't succeed: Fabric's error code and request ID, if any. */
  errorCode?: string;
  requestId?: string;
}

export interface HistoryRecord {
  action: 'download' | 'upload' | 'delete';
  /** The item's name (a notebook's, or another kind's, which then has `kind`). */
  notebook: string;
  /** The item's kind, when it isn't a notebook. */
  kind?: ItemKind;
  workspace: string;
  result: 'downloaded' | 'created' | 'updated' | 'deleted' | 'failed';
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
  /** The most requests running at once. */
  peak: number;
  /** Times requests were paused because Fabric throttled the rate, for how long in all, and the lowest rate it led to. */
  throttles: number;
  pausedMs: number;
  lowestRate?: number;
  /** Times requests were paused because the Fabric capacity was overloaded, and for how long in all. */
  capacityThrottles: number;
  capacityPausedMs: number;
}
/** Commands running now, oldest first. Requests count towards the latest one still running. */
const running: Activity[] = [];

/** Records one Fabric request (passed to `FabricClient` as `onRequest`). */
export function recordRequest(record: RequestRecord): void {
  const activity = running.at(-1);
  if (activity) {
    if (record.kind === 'request') {
      activity.requests++;
      activity.peak = Math.max(activity.peak, record.inFlight ?? 0);
      if ((record.attempt ?? 1) > 1) {
        activity.retries++;
      }
    } else if (record.kind === 'throttle' && record.reason === 'capacity') {
      activity.capacityThrottles++;
      activity.capacityPausedMs += record.ms;
    } else if (record.kind === 'throttle') {
      activity.throttles++;
      activity.pausedMs += record.ms;
      if (record.ratePerSecond !== undefined) {
        activity.lowestRate = Math.min(activity.lowestRate ?? record.ratePerSecond, record.ratePerSecond);
      }
    } else {
      activity.operations++;
      activity.waitedMs += record.waitedMs ?? 0;
    }
  }
  queue(REQUESTS_FILE, JSON.stringify({ time: new Date().toISOString(), command: activity?.name, ...record }));
}

/** Records a notebook download or upload in `diagnostics/history.jsonl`. */
export function recordHistory(record: HistoryRecord): void {
  queue(HISTORY_FILE, JSON.stringify({ time: new Date().toISOString(), ...record }));
}

/** Copies a log line to `diagnostics/fabric-supersat.log`. */
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
  peak?: number;
  throttles?: number;
  pausedMs?: number;
  lowestRate?: number;
  capacityThrottles?: number;
  capacityPausedMs?: number;
}

/**
 * Runs a command, counting its Fabric requests. `onStart` is told "Starting <name>…", and
 * `report` gets a summary when it ends, whether or not it made requests: "Finished <name>"
 * with its requests and any throttling (e.g. "Finished Download All Notebooks: 74 requests,
 * 37 long-running operations, up to 32 at once, 6m12s, of which 4m50s waiting on Fabric"),
 * or just how long it took; "(failed)" after the name if it threw.
 * Commands rarely overlap; while they do, requests count towards the latest one still
 * running, and a command that finishes stops counting, whatever order they finish in.
 */
export async function withActivity<T>(
  name: string,
  run: () => Promise<T>,
  report: (summary: ActivitySummary, line: string) => void,
  onStart?: (line: string) => void,
): Promise<T> {
  const current: Activity = {
    name,
    started: Date.now(),
    requests: 0,
    operations: 0,
    waitedMs: 0,
    retries: 0,
    peak: 0,
    throttles: 0,
    pausedMs: 0,
    capacityThrottles: 0,
    capacityPausedMs: 0,
  };
  running.push(current);
  onStart?.(`Starting ${name}…`);
  let failed = false;
  try {
    return await run();
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    running.splice(running.indexOf(current), 1);
    const summary = { ...current, ms: Date.now() - current.started };
    report(summary, finishedLine(summary, failed));
    void flushDiagnostics();
  }
}

/** "Finished <name>: …", with the request summary if it made requests, otherwise how long it took. */
export function finishedLine(s: ActivitySummary, failed = false): string {
  const name = failed ? `${s.name} (failed)` : s.name;
  return `Finished ${s.requests ? summaryLine({ ...s, name }) : `${name}: ${duration(s.ms)}`}`;
}

export function summaryLine(s: ActivitySummary): string {
  return (
    `${s.name}: ${s.requests} request${s.requests === 1 ? '' : 's'}` +
    (s.operations ? `, ${s.operations} long-running operation${s.operations === 1 ? '' : 's'}` : '') +
    (s.peak && s.peak > 1 ? `, up to ${s.peak} at once` : '') +
    (s.throttles
      ? `, throttled by Fabric ${s.throttles} time${s.throttles === 1 ? '' : 's'} (requests paused ${duration(s.pausedMs ?? 0)}` +
        (s.lowestRate !== undefined ? `, rate lowered to ${perSecond(s.lowestRate)}` : '') +
        ')'
      : '') +
    (s.capacityThrottles
      ? `, Fabric capacity overloaded ${s.capacityThrottles} time${s.capacityThrottles === 1 ? '' : 's'} (requests paused ${duration(s.capacityPausedMs ?? 0)})`
      : '') +
    (s.retries ? `, ${s.retries} retried after throttling` : '') +
    `, ${duration(s.ms)}` +
    (s.waitedMs ? `, of which ${duration(s.waitedMs)} waiting on Fabric (summed over concurrent requests)` : '')
  );
}

/** A rate such as "2.5/s" (at most two decimals). */
function perSecond(rate: number): string {
  return `${Math.round(rate * 100) / 100}/s`;
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${String(whole % 60).padStart(2, '0')}s`;
}
