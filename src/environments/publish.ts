/**
 * Publishing an environment: an upload changes only its saved state in Fabric, and
 * publishing makes that the state notebooks run with. Publishing can take many minutes
 * (Microsoft's example took about half an hour), so it's started, then watched through the
 * environment's `properties.publishDetails` rather than as a request held open. No `vscode`
 * dependency.
 * ([Microsoft: Publish Environment](https://learn.microsoft.com/rest/api/fabric/environment/items/publish-environment))
 */
import { FabricApiError, type FabricClient, type JsonRecord } from '../fabric/client';
import { ActionNeededError } from '../util/errorFix';

/** Fabric's publish states (`EnvironmentPublishState`); Microsoft says more may be added. */
export type PublishState = 'Success' | 'Failed' | 'Cancelled' | 'Cancelling' | 'Running' | 'Waiting' | (string & {});

/** States a publish ends in. */
const FINAL_STATES: readonly string[] = ['Success', 'Failed', 'Cancelled'];

/** An environment's latest publish, as Fabric reports it. */
export interface PublishDetails {
  state?: PublishState;
  startTime?: string;
  endTime?: string;
  targetVersion?: string;
  /** Each component's state, e.g. `sparkLibraries: Running`. */
  components: Record<string, string>;
}

/** The latest publish's details from a Get Environment response, or `undefined` if it has none. */
export function publishDetailsOf(environment: JsonRecord | undefined): PublishDetails | undefined {
  const properties = object(environment?.properties);
  const details = object(properties?.publishDetails);
  if (!details) {
    return undefined;
  }
  const components: Record<string, string> = {};
  for (const [name, value] of Object.entries(object(details.componentPublishInfo) ?? {})) {
    const state = object(value)?.state;
    if (typeof state === 'string') {
      components[name] = state;
    }
  }
  return {
    ...(typeof details.state === 'string' ? { state: details.state } : {}),
    ...(typeof details.startTime === 'string' ? { startTime: details.startTime } : {}),
    ...(typeof details.endTime === 'string' ? { endTime: details.endTime } : {}),
    ...(typeof details.targetVersion === 'string' ? { targetVersion: details.targetVersion } : {}),
    components,
  };
}

export interface WatchOptions {
  /** Waits between checks (default `setTimeout`); tests pass a fake. */
  delay?: (ms: number) => Promise<void>;
  /** How long between checks (default 15 s). */
  pollMs?: number;
  /** How long to watch before giving up watching (default 60 minutes): the publish goes on in Fabric. */
  timeoutMs?: number;
  /** Stops watching (the publish goes on in Fabric). */
  isCancelled?: () => boolean;
  /** Called with each state seen. */
  onState?: (details: PublishDetails) => void;
  now?: () => number;
}

/** How watching a publish ended. */
export interface PublishOutcome {
  /** The last state seen: `Success`, `Failed` or `Cancelled` if it ended, else the state it was in. */
  state?: PublishState;
  details?: PublishDetails;
  /** Stopped watching before it ended: cancelled by the user, or `timeoutMs` passed. */
  stoppedWatching?: 'cancelled' | 'timedOut';
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;

/**
 * Starts publishing an environment's saved changes, then watches it until it ends (or the
 * watch is cancelled or times out). A publish already running is refused by Fabric; that's
 * reported as something to wait for. Fabric's details may still show the previous publish
 * for a moment after this one starts, so a final state counts only once the details show a
 * publish started after this one was asked for.
 */
export async function publishEnvironment(
  client: FabricClient,
  workspaceId: string,
  environmentId: string,
  name: string,
  options: WatchOptions = {},
): Promise<PublishOutcome> {
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const before = publishDetailsOf(await client.getEnvironment(workspaceId, environmentId));
  if (before?.state && !FINAL_STATES.includes(before.state)) {
    throw new ActionNeededError(`Environment "${name}" is already being published (${before.state}). Wait for it to finish, then publish again.`);
  }
  try {
    await client.publishEnvironment(workspaceId, environmentId);
  } catch (err) {
    if (err instanceof FabricApiError && /AnotherOngoingPublish/i.test(`${err.errorCode} ${err.message}`)) {
      throw new ActionNeededError(`Environment "${name}" is already being published. Wait for it to finish, then publish again.`);
    }
    throw err;
  }
  const deadline = now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let latest: PublishDetails | undefined;
  for (;;) {
    if (options.isCancelled?.()) {
      return { state: latest?.state, details: latest, stoppedWatching: 'cancelled' };
    }
    if (now() >= deadline) {
      return { state: latest?.state, details: latest, stoppedWatching: 'timedOut' };
    }
    await delay(options.pollMs ?? DEFAULT_POLL_MS);
    const details = publishDetailsOf(await client.getEnvironment(workspaceId, environmentId));
    if (!details) {
      continue;
    }
    latest = details;
    options.onState?.(details);
    const isThisPublish = !before || details.startTime !== before.startTime || details.targetVersion !== before.targetVersion;
    if (isThisPublish && details.state && FINAL_STATES.includes(details.state)) {
      return { state: details.state, details };
    }
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
