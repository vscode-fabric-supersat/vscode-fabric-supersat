/**
 * Microsoft Fabric REST API client (https://learn.microsoft.com/rest/api/fabric/).
 *
 * Has no `vscode` dependency and takes `fetch`, the token source and the delay function
 * as inputs, so it runs unchanged on desktop and web and can be unit-tested offline.
 *
 * Every request goes through one `RequestLimiter`, which keeps each of Fabric's quota buckets
 * within budget and pauses a bucket when Fabric throttles it (see `requestLimiter.ts`).
 */

import type { RequestRecord } from '../util/diagnostics';
import { ITEM_KINDS, type ItemKind } from '../items/kinds';
import { type RequestBucket, RequestLimiter, type ThrottleReason } from './requestLimiter';
import type { ErrorFix, FixableError, WarningError } from '../util/errorFix';

export const FABRIC_API_BASE_URL = 'https://api.fabric.microsoft.com/v1';

export interface Workspace {
  id: string;
  displayName: string;
  description?: string;
  /** `Personal`, `Workspace` or `AdminWorkspace`; more may be added. */
  type: string;
  capacityId?: string;
}

export interface Notebook {
  id: string;
  displayName: string;
  description?: string;
  type: 'Notebook';
  workspaceId: string;
  folderId?: string;
}

/** Any Fabric item, e.g. a lakehouse or environment. */
export interface Item {
  id: string;
  displayName: string;
  type: string;
  workspaceId: string;
  description?: string;
  folderId?: string;
}

/** A workspace folder. */
export interface Folder {
  id: string;
  displayName: string;
  parentFolderId?: string;
}

/** A Fabric response kept as returned (metadata is saved as-is). */
export type JsonRecord = Record<string, unknown>;

/** One file of an item definition, e.g. `notebook-content.py`. */
export interface DefinitionPart {
  path: string;
  /** Base64 of the file's bytes. */
  payload: string;
  payloadType: 'InlineBase64';
}

/**
 * An item's content as files. Notebooks come as `fabricGitSource` (the default:
 * `notebook-content.py`, the format Fabric's Git integration uses) or `ipynb`
 * (`notebook-content.ipynb`).
 */
export interface ItemDefinition {
  format?: string;
  parts: DefinitionPart[];
}

/** State of a long-running operation (`GET /operations/{id}`). */
interface OperationState {
  status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed' | 'Undefined';
  createdTimeUtc?: string;
  lastUpdatedTimeUtc?: string;
  error?: ErrorResponse;
}

/** One page of a paginated Fabric list response. */
interface Page<T> {
  value: T[];
  continuationToken?: string;
  continuationUri?: string;
}

/** Fabric's documented error body. */
interface ErrorResponse {
  errorCode?: string;
  message?: string;
  requestId?: string;
}

export class FabricApiError extends Error implements FixableError, WarningError {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'FabricApiError';
  }

  /**
   * A warning, not an error (see `WarningError`): the sign-in expired (401) or the account
   * may not use the workspace (403), which the user sees to. Any other status is unexpected.
   */
  get warning(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /** What the user can do: sign in again (401), or check the workspace (403, 404). */
  get fix(): ErrorFix | undefined {
    if (this.status === 401) {
      return { hint: 'Your sign-in may have expired: run "Fabric Supersat: Sign In to Fabric".', configureSignIn: true };
    }
    if (this.status === 403 || this.status === 404) {
      // Usually a saved workspace that was deleted, or that belongs to another tenant.
      return { hint: 'Check the workspace: run "Fabric Supersat: Select Workspace".', selectWorkspace: true };
    }
    return undefined;
  }
}

export interface FabricClientOptions {
  /** Returns a bearer token for the Fabric API. */
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** How many times to retry a request answered with 429 (Too Many Requests). */
  maxRetries?: number;
  /** The most requests to run at once; defaults to `MAX_CONCURRENT_REQUESTS`. */
  maxConcurrentRequests?: number;
  /** Each quota bucket's budget; defaults to each bucket's own (see `RequestLimiter`). */
  burst?: number;
  ratePerSecond?: number;
  /** Definition requests allowed in any minute; defaults to `DEFINITION_LIMIT`. */
  definitionLimit?: number;
  /** Waits for the given number of milliseconds; replaceable in tests. */
  delay?: (ms: number) => Promise<void>;
  /** The current time in ms; replaceable in tests. */
  now?: () => number;
  /** Told about each HTTP request and each long-running operation, for diagnostics. Never given tokens. */
  onRequest?: (record: RequestRecord) => void;
}

/**
 * Statuses that usually mean a passing fault in Fabric or on the way to it (a gateway or
 * service briefly unavailable), retried like a network error: at most `MAX_TRANSIENT_RETRIES`
 * times, after Fabric's `Retry-After` if it sends one, otherwise 1s, 2s, 4s.
 */
const TRANSIENT_STATUSES = [500, 502, 503, 504];
const MAX_TRANSIENT_RETRIES = 3;
const FIRST_TRANSIENT_RETRY_MS = 1000;
/**
 * Hosts Fabric may send us to besides the API's own. The token is for the Power BI / Fabric
 * API, which these hosts serve:
 * - `.analysis.windows.net`: long-running operations polled on a regional Power BI back end,
 *   e.g. https://wabi-<region>-redirect.analysis.windows.net/v1/operations/{id} (seen 2026-11).
 * - `.fabric.microsoft.com`: the API, including private-link workspace hosts
 *   (`<workspace>.z<xx>.w.api.fabric.microsoft.com`, as Microsoft's fabric-cicd builds them).
 * - `.powerbi.com`: the Power BI API (`api.powerbi.com`), which fabric-cicd also accepts.
 * Microsoft's fabric-cicd and Fabric VS Code extension follow `Location` to any host; this
 * stays stricter so the token can't be sent elsewhere.
 */
const TRUSTED_HOST_SUFFIXES = ['.analysis.windows.net', '.fabric.microsoft.com', '.powerbi.com'];
/**
 * Long-running operations (e.g. exporting a big notebook) are followed for at most this long,
 * by the clock from when Fabric accepted the request: waits between status checks, time in the
 * limiter and the checks themselves all count.
 */
const MAX_OPERATION_SECONDS = 10 * 60;
/**
 * The longest `Retry-After` honoured for a rate 429, a 5xx retry or a status check: Fabric's
 * quota windows are a minute, so a longer one is taken to be a mistake. Without one, status
 * checks keep doubling up to this.
 */
const MAX_RETRY_AFTER_SECONDS = 60;
/**
 * The longest `Retry-After` honoured for `CapacityLimitExceeded`: an overloaded capacity can
 * need longer than a minute. The same limit as a long-running operation's.
 */
const MAX_CAPACITY_RETRY_AFTER_MS = MAX_OPERATION_SECONDS * 1000;
/**
 * A long-running operation's first status check is this long after Fabric accepts it, and
 * each next one twice as long after the last, but never later than Fabric's `Retry-After`.
 * Fabric asks for 20s, though notebook operations took 0.4-2.3s (seen 2026-11); polls count
 * against their own quota bucket, not the Platform one. Without a `Retry-After`, the checks
 * keep doubling (2s, 4s, 8s...) up to `MAX_RETRY_AFTER_SECONDS`.
 */
const FIRST_POLL_MS = 2000;
/** The shortest wait between status checks, whatever `Retry-After` says. */
const MIN_POLL_MS = 1000;

export class FabricClient {
  private readonly getToken: () => Promise<string>;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onRequest: (record: RequestRecord) => void;
  /** When requests may be sent: each quota bucket's budget, and how many run at once. */
  readonly limiter: RequestLimiter;

  constructor(options: FabricClientOptions) {
    this.getToken = options.getToken;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? FABRIC_API_BASE_URL).replace(/\/+$/, '');
    // A 429 pauses the bucket's every request (see RequestLimiter), so retrying is cheap: more retries than one request alone would get.
    this.maxRetries = options.maxRetries ?? 6;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.onRequest = options.onRequest ?? (() => undefined);
    this.limiter = new RequestLimiter({
      maxConcurrent: options.maxConcurrentRequests,
      burst: options.burst,
      ratePerSecond: options.ratePerSecond,
      definitionLimit: options.definitionLimit,
      delay: this.delay,
      now: options.now,
    });
  }

  /** Workspaces the signed-in user can access. */
  listWorkspaces(): Promise<Workspace[]> {
    return this.listAll<Workspace>(`${this.baseUrl}/workspaces`);
  }

  /** Notebooks in a workspace, including those in nested folders. */
  listNotebooks(workspaceId: string): Promise<Notebook[]> {
    return this.listAll<Notebook>(
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/notebooks`,
    );
  }

  /** Items in a workspace: all of them, or one type (e.g. its lakehouses or environments). */
  listItems(workspaceId: string, type?: string): Promise<Item[]> {
    const query = type ? `?type=${encodeURIComponent(type)}` : '';
    return this.listAll<Item>(`${this.workspaceUrl(workspaceId)}/items${query}`);
  }

  /** A workspace's properties (capacity, region, and so on). */
  getWorkspace(workspaceId: string): Promise<JsonRecord> {
    return this.get<JsonRecord>(this.workspaceUrl(workspaceId));
  }

  /** A workspace's folders (`parentFolderId` links them into a tree). */
  listFolders(workspaceId: string): Promise<Folder[]> {
    return this.listAll<Folder>(`${this.workspaceUrl(workspaceId)}/folders`);
  }

  /**
   * Creates a folder in the workspace root, or in `parentFolderId`. Not retried after a network
   * error or 5xx: Fabric may have created it anyway, and a second try would fail as a duplicate.
   */
  createFolder(workspaceId: string, displayName: string, parentFolderId?: string): Promise<Folder> {
    return this.send<Folder>(
      'POST',
      `${this.workspaceUrl(workspaceId)}/folders`,
      { displayName, ...(parentFolderId ? { parentFolderId } : {}) },
      { retryTransient: false },
    );
  }

  /** A lakehouse, with its OneLake paths and SQL analytics endpoint in `properties`. */
  getLakehouse(workspaceId: string, lakehouseId: string): Promise<JsonRecord> {
    return this.get<JsonRecord>(`${this.workspaceUrl(workspaceId)}/lakehouses/${encodeURIComponent(lakehouseId)}`);
  }

  /** A lakehouse's tables (not available for lakehouses with schemas). */
  listLakehouseTables(workspaceId: string, lakehouseId: string): Promise<JsonRecord[]> {
    return this.listAll<JsonRecord>(`${this.workspaceUrl(workspaceId)}/lakehouses/${encodeURIComponent(lakehouseId)}/tables`);
  }

  /** A workspace's warehouses, with their connection strings in `properties`. */
  listWarehouses(workspaceId: string): Promise<JsonRecord[]> {
    return this.listAll<JsonRecord>(`${this.workspaceUrl(workspaceId)}/warehouses`);
  }

  /** An environment, with its publish state in `properties`. */
  getEnvironment(workspaceId: string, environmentId: string): Promise<JsonRecord> {
    return this.get<JsonRecord>(`${this.workspaceUrl(workspaceId)}/environments/${encodeURIComponent(environmentId)}`);
  }

  /** The workspace's Git connection (provider, repository, branch), if any. */
  getGitConnection(workspaceId: string): Promise<JsonRecord> {
    return this.get<JsonRecord>(`${this.workspaceUrl(workspaceId)}/git/connection`);
  }

  /** The workspace's Spark settings (pools, environment, jobs). */
  getSparkSettings(workspaceId: string): Promise<JsonRecord> {
    return this.get<JsonRecord>(`${this.workspaceUrl(workspaceId)}/spark/settings`);
  }

  /** Who has which role in the workspace (needs a role that can see them). */
  listRoleAssignments(workspaceId: string): Promise<JsonRecord[]> {
    return this.listAll<JsonRecord>(`${this.workspaceUrl(workspaceId)}/roleAssignments`);
  }

  private workspaceUrl(workspaceId: string): string {
    return `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}`;
  }

  /** A notebook's content. Omit `format` for Fabric's Git format (`notebook-content.py`). */
  getNotebookDefinition(workspaceId: string, notebookId: string, format?: 'ipynb'): Promise<ItemDefinition> {
    const query = format ? `?format=${format}` : '';
    return this.getDefinition(`${this.notebookUrl(workspaceId, notebookId)}/getDefinition${query}`, 'notebook');
  }

  /** Environments in a workspace, including those in nested folders. */
  listEnvironments(workspaceId: string): Promise<Item[]> {
    return this.listItems(workspaceId, 'Environment');
  }

  /**
   * An environment's content: `Setting/Sparkcompute.yml`, `Libraries/PublicLibraries/environment.yml`,
   * `Libraries/CustomLibraries/<file>` and `.platform`, each optional
   * ([Microsoft: Environment definition](https://learn.microsoft.com/rest/api/fabric/articles/item-management/definitions/environment-definition)).
   */
  getEnvironmentDefinition(workspaceId: string, environmentId: string): Promise<ItemDefinition> {
    return this.getDefinition(
      `${this.itemUrl(workspaceId, 'environment', environmentId)}/getDefinition`,
      'environment',
    );
  }

  /**
   * Creates an environment, with its definition (its saved state in Fabric: not published),
   * description and folder. Not retried on passing faults, since Fabric may have created it
   * anyway (as for notebooks): uploading again finds it by name.
   */
  createEnvironment(
    workspaceId: string,
    displayName: string,
    definition: ItemDefinition | undefined,
    description?: string,
    folderId?: string,
  ): Promise<Item> {
    return this.send<Item>(
      'POST',
      `${this.workspaceUrl(workspaceId)}/environments`,
      {
        displayName,
        ...(description ? { description } : {}),
        ...(folderId ? { folderId } : {}),
        ...(definition ? { definition } : {}),
      },
      { retryTransient: false },
    );
  }

  /** Replaces an environment's definition: its saved state in Fabric, which still has to be published to take effect. */
  async updateEnvironmentDefinition(workspaceId: string, environmentId: string, definition: ItemDefinition): Promise<void> {
    await this.send('POST', `${this.itemUrl(workspaceId, 'environment', environmentId)}/updateDefinition`, { definition });
  }

  /**
   * Starts publishing an environment's saved changes. Returns once Fabric has accepted it,
   * without waiting for it to finish (it can take many minutes): watch `getEnvironment`'s
   * `properties.publishDetails.state`. Fabric refuses a second publish while one is running.
   * `beta=false` asks for the release version of the API, as Microsoft requires.
   */
  async publishEnvironment(workspaceId: string, environmentId: string): Promise<void> {
    await this.send('POST', `${this.itemUrl(workspaceId, 'environment', environmentId)}/staging/publish?beta=false`, undefined, {
      followOperation: false,
    });
  }

  /** The workspace's custom Spark pools (not the starter pool). */
  listWorkspacePools(workspaceId: string): Promise<JsonRecord[]> {
    return this.listAll<JsonRecord>(`${this.workspaceUrl(workspaceId)}/spark/pools`);
  }

  /** An item's definition from its `getDefinition` URL (a long-running operation). */
  private async getDefinition(url: string, what: string): Promise<ItemDefinition> {
    const result = await this.send<{ definition?: ItemDefinition } | undefined>('POST', url);
    // An operation that succeeded without a result, or an unexpected body: say so, rather than fail later.
    const definition = result?.definition;
    if (!definition || !Array.isArray(definition.parts)) {
      throw new FabricApiError(
        0,
        'MissingDefinition',
        `Fabric reported the ${what} export as finished but returned no ${what} content. Try again; if it keeps happening, check the ${what} in Fabric.`,
      );
    }
    return definition;
  }

  /** Replaces a notebook's content. */
  async updateNotebookDefinition(workspaceId: string, notebookId: string, definition: ItemDefinition): Promise<void> {
    await this.send('POST', `${this.notebookUrl(workspaceId, notebookId)}/updateDefinition`, { definition });
  }

  /**
   * Creates a notebook with the given content, and description if given. The request itself
   * isn't retried after a network error or 5xx: Fabric may have created the notebook anyway.
   * Uploading again finds it by name and updates it.
   */
  createNotebook(
    workspaceId: string,
    displayName: string,
    definition: ItemDefinition,
    description?: string,
    folderId?: string,
  ): Promise<Notebook> {
    return this.send<Notebook>(
      'POST',
      `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/notebooks`,
      { displayName, ...(description ? { description } : {}), ...(folderId ? { folderId } : {}), definition },
      { retryTransient: false },
    );
  }

  /**
   * Moves an item (e.g. a notebook) into a folder, or to the workspace root when `targetFolderId`
   * is omitted. Items that belong to it move with it.
   */
  async moveItem(workspaceId: string, itemId: string, targetFolderId?: string): Promise<void> {
    await this.send(
      'POST',
      `${this.workspaceUrl(workspaceId)}/items/${encodeURIComponent(itemId)}/move`,
      targetFolderId ? { targetFolderId } : {},
    );
  }

  /** Changes a notebook's properties (not its content). */
  updateNotebook(
    workspaceId: string,
    notebookId: string,
    properties: { description?: string; displayName?: string },
  ): Promise<Notebook> {
    return this.updateItem<Notebook>(workspaceId, 'notebook', notebookId, properties);
  }

  /** Changes an item's properties (not its content), through its kind's API (e.g. `/environments/{id}`). */
  updateItem<T = Item>(
    workspaceId: string,
    kind: ItemKind,
    itemId: string,
    properties: { description?: string; displayName?: string },
  ): Promise<T> {
    // Fabric documents only 200, but a 202 would be followed like any other operation.
    return this.send<T>('PATCH', this.itemUrl(workspaceId, kind, itemId), properties);
  }

  /**
   * Deletes a notebook. Fabric keeps it in the workspace's recycle bin when the workspace
   * has one turned on; otherwise it is gone.
   */
  deleteNotebook(workspaceId: string, notebookId: string): Promise<void> {
    return this.deleteItem(workspaceId, 'notebook', notebookId);
  }

  /** Deletes an item, through its kind's API (as `deleteNotebook` does for a notebook). */
  async deleteItem(workspaceId: string, kind: ItemKind, itemId: string): Promise<void> {
    // Fabric documents only 200, but a 202 is followed rather than taken as done.
    await this.send('DELETE', this.itemUrl(workspaceId, kind, itemId));
  }

  private notebookUrl(workspaceId: string, notebookId: string): string {
    return this.itemUrl(workspaceId, 'notebook', notebookId);
  }

  /** An item's URL in its kind's API, e.g. `/workspaces/{id}/environments/{id}`. */
  private itemUrl(workspaceId: string, kind: ItemKind, itemId: string): string {
    return `${this.workspaceUrl(workspaceId)}/${ITEM_KINDS[kind].apiPath}/${encodeURIComponent(itemId)}`;
  }

  /**
   * Sends a request that may be a long-running operation: a 202 response is polled at its
   * `Location` until it finishes, then its result is fetched from the `Location` of the final
   * status (none means the operation has no result). As in Microsoft's fabric-cicd and Fabric
   * VS Code extension, a newer `Location` from any status check is followed from then on.
   * https://learn.microsoft.com/rest/api/fabric/articles/long-running-operation
   */
  private async send<T>(method: 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, options: RetryOptions = {}): Promise<T> {
    const started = Date.now();
    const response = await this.fetchWithRetry(url, method, body, options);
    if (response.status !== 202) {
      return (await readJson(response)) as T;
    }
    if (options.followOperation === false) {
      return undefined as T;
    }
    const stats: OperationStats = { polls: 0, waitedMs: 0, operationId: operationIdOf(response) };
    try {
      return await this.followOperation<T>(response, stats);
    } catch (err) {
      // Not a failure Fabric reported, nor a timeout: the client couldn't follow the operation.
      if (!stats.result) {
        stats.result = 'error';
        if (err instanceof FabricApiError) {
          stats.errorCode = err.errorCode;
          stats.requestId = err.requestId;
        }
      }
      throw err;
    } finally {
      this.onRequest({ kind: 'operation', method, url: describeUrl(url), ms: Date.now() - started, ...stats });
    }
  }

  private async followOperation<T>(response: Response, stats: OperationStats): Promise<T> {
    let location = response.headers.get('Location');
    if (!location) {
      throw new FabricApiError(202, 'MissingLocation', 'Fabric accepted the request but gave no operation to follow.');
    }
    this.assertTrusted(location, 'UntrustedOperationUrl');
    const { operationId } = stats;
    const deadline = this.now() + MAX_OPERATION_SECONDS * 1000;
    // 2s, 4s, 8s... each capped by the latest Retry-After (see FIRST_POLL_MS).
    let backoff = FIRST_POLL_MS;
    let wait = pollWait(backoff, parseRetryAfter(response.headers.get('Retry-After'), this.now()));
    for (;;) {
      await this.delay(wait);
      stats.waitedMs += wait;
      stats.polls++;
      const poll = await this.fetchWithRetry(location, 'GET', undefined, { operationId, statusCheck: true });
      const state = (await poll.json()) as OperationState;
      const fabricMs = Date.parse(state.lastUpdatedTimeUtc ?? '') - Date.parse(state.createdTimeUtc ?? '');
      if (Number.isFinite(fabricMs) && fabricMs >= 0) {
        stats.fabricMs = fabricMs;
      }
      const next = poll.headers.get('Location');
      if (state.status === 'Succeeded') {
        // Operations that return content (e.g. getDefinition) point to it with Location.
        if (next) {
          this.assertTrusted(next, 'UntrustedOperationUrl');
          const result = (await readJson(await this.fetchWithRetry(next, 'GET', undefined, { operationId }))) as T;
          stats.result = 'succeeded';
          return result;
        }
        stats.result = 'succeeded';
        return undefined as T;
      }
      if (state.status === 'Failed' || state.status === 'Undefined') {
        stats.result = 'failed';
        stats.errorCode = state.error?.errorCode ?? 'OperationFailed';
        stats.requestId = state.error?.requestId;
        throw new FabricApiError(0, stats.errorCode, state.error?.message ?? 'The Fabric operation failed.', stats.requestId);
      }
      if (this.now() >= deadline) {
        stats.result = 'timedOut';
        stats.errorCode = 'OperationTimeout';
        throw new FabricApiError(0, 'OperationTimeout', `Fabric didn't finish the operation within ${MAX_OPERATION_SECONDS / 60} minutes.`);
      }
      if (next && next !== location) {
        this.assertTrusted(next, 'UntrustedOperationUrl');
        location = next;
      }
      backoff *= 2;
      wait = pollWait(backoff, parseRetryAfter(poll.headers.get('Retry-After'), this.now()));
    }
  }

  /** Follows `continuationUri` links until every page has been read. */
  private async listAll<T>(firstUrl: string): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let url: string | undefined = firstUrl;
    while (url) {
      seen.add(url);
      const page: Page<T> = await this.get<Page<T>>(url);
      items.push(...(page.value ?? []));
      url = page.continuationUri;
      if (url) {
        this.assertTrusted(url, 'UnexpectedContinuationUri');
        // A page link already read would list the same pages again, forever.
        if (seen.has(url)) {
          throw new FabricApiError(0, 'RepeatedContinuationUri', `Fabric sent a link to a page already read (${describeUrl(url)}); stopped listing.`);
        }
      }
    }
    return items;
  }

  /**
   * Never send the bearer token anywhere but the API's own host or Fabric's other HTTPS
   * hosts (`TRUSTED_HOST_SUFFIXES`).
   */
  private assertTrusted(url: string, errorCode: string): void {
    const target = new URL(url);
    const trusted =
      target.origin === new URL(this.baseUrl).origin ||
      (target.protocol === 'https:' &&
        !target.port &&
        TRUSTED_HOST_SUFFIXES.some((suffix) => target.hostname.toLowerCase().endsWith(suffix)));
    if (!trusted) {
      throw new FabricApiError(0, errorCode, `Refusing to follow ${url}`);
    }
  }

  private async get<T>(url: string): Promise<T> {
    return (await (await this.fetchWithRetry(url, 'GET')).json()) as T;
  }

  /**
   * Sends a request when the limiter allows, retrying 429s: each pauses every request in
   * the same quota bucket (see `RequestLimiter.throttled`). Also retries network errors and
   * `TRANSIENT_STATUSES`, unless `retryTransient` is false (a request Fabric may have acted
   * on, such as creating an item). Returns successful responses; throws otherwise.
   *
   * The token is fetched once the limiter lets the request go, right before it is sent, so a
   * long wait for the budget (up to a minute, or more when throttled) can't leave it expired.
   */
  private async fetchWithRetry(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    { retryTransient = true, operationId, statusCheck = false }: RetryOptions = {},
  ): Promise<Response> {
    const bucket = requestBucket(url);
    let throttles = 0;
    let transientRetries = 0;
    for (let attempt = 0; ; attempt++) {
      const inFlight = await this.limiter.acquire(bucket, isDefinitionRequest(url));
      let started = Date.now();
      let response: Response | undefined;
      let networkError: unknown;
      try {
        const token = await this.getToken();
        const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
        if (body !== undefined) {
          headers['Content-Type'] = 'application/json';
        }
        started = Date.now();
        try {
          response = await this.fetchFn(url, {
            method,
            // The token must only go where `assertTrusted` allows; Fabric doesn't use HTTP redirects.
            redirect: 'error',
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
          });
        } catch (err) {
          networkError = err;
        }
      } finally {
        this.limiter.release();
      }

      if (!response) {
        this.onRequest({
          kind: 'request',
          method,
          url: describeUrl(url),
          status: 0,
          ms: Date.now() - started,
          attempt: attempt + 1,
          inFlight,
          ...(operationId ? { operationId } : {}),
        });
        if (retryTransient && transientRetries < MAX_TRANSIENT_RETRIES) {
          await this.delay(FIRST_TRANSIENT_RETRY_MS * 2 ** transientRetries++);
          continue;
        }
        throw networkError;
      }
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'), this.now());
      // The operation a 202 starts, or the one this status check or result fetch belongs to.
      const operation = response.status === 202 ? operationIdOf(response) : operationId;
      const ms = Date.now() - started;
      this.onRequest({
        kind: 'request',
        method,
        url: describeUrl(url),
        status: response.status,
        ms,
        attempt: attempt + 1,
        inFlight,
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
        ...(operation ? { operationId: operation } : {}),
        ...(statusCheck && response.ok ? await operationProgress(response) : {}),
      });

      if (response.status !== 429) {
        this.limiter.succeeded(bucket);
      }
      if (response.ok) {
        return response;
      }
      // A DELETE retried after a transient failure may have worked the first time.
      if (method === 'DELETE' && response.status === 404 && transientRetries > 0) {
        return response;
      }
      if (retryTransient && TRANSIENT_STATUSES.includes(response.status) && transientRetries < MAX_TRANSIENT_RETRIES) {
        const backoff = FIRST_TRANSIENT_RETRY_MS * 2 ** transientRetries++;
        await this.delay(capped(retryAfter, MAX_RETRY_AFTER_SECONDS * 1000) ?? backoff);
        continue;
      }
      if (response.status === 429 && throttles++ < this.maxRetries) {
        const reason = await throttleReason(response);
        // An overloaded capacity may ask for longer than a quota window; the rate never needs more than one.
        const maxWaitMs = reason === 'capacity' ? MAX_CAPACITY_RETRY_AFTER_MS : MAX_RETRY_AFTER_SECONDS * 1000;
        const throttled = this.limiter.throttled(bucket, reason, capped(retryAfter, maxWaitMs));
        if (throttled.pausedMs) {
          this.onRequest({
            kind: 'throttle',
            method,
            url: describeUrl(url),
            ms: throttled.pausedMs,
            bucket,
            reason,
            ratePerSecond: throttled.ratePerSecond,
            burst: throttled.burst,
          });
        }
        continue;
      }
      throw await toError(response);
    }
  }
}

interface RetryOptions {
  /** Whether to retry network errors and `TRANSIENT_STATUSES` (default true). */
  retryTransient?: boolean;
  /**
   * Whether to follow a long-running operation (a 202) to its end (default true). `false`
   * returns `undefined` once Fabric accepts it, for operations that can outlast
   * `MAX_OPERATION_SECONDS` and are watched another way (e.g. publishing an environment).
   */
  followOperation?: boolean;
  /** The long-running operation the request belongs to, for its diagnostics record. */
  operationId?: string;
  /** A status check: its record also has the operation's `state` and `percentComplete`. */
  statusCheck?: boolean;
}

/** What a long-running operation's summary record says about it (see `RequestRecord`). */
type OperationStats = Pick<RequestRecord, 'operationId' | 'fabricMs' | 'result' | 'errorCode' | 'requestId'> & {
  polls: number;
  waitedMs: number;
};

/**
 * A 202's operation ID: Fabric's `x-ms-operation-id`, or else the ID at the end of its
 * `Location` (`.../operations/{id}`).
 */
function operationIdOf(response: Response): string | undefined {
  const header = response.headers.get('x-ms-operation-id')?.trim();
  if (header) {
    return header;
  }
  const location = response.headers.get('Location');
  try {
    return location ? /\/operations\/([^/]+)\/?$/i.exec(new URL(location).pathname)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

/** A status check's state and progress, read from a copy of its body (the caller reads the body itself). */
async function operationProgress(response: Response): Promise<Pick<RequestRecord, 'state' | 'percentComplete'>> {
  try {
    const body = (await response.clone().json()) as { status?: unknown; percentComplete?: unknown };
    return {
      ...(typeof body.status === 'string' ? { state: body.status } : {}),
      ...(typeof body.percentComplete === 'number' ? { percentComplete: body.percentComplete } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Which of Fabric's quota buckets a request counts against: long-running operation status
 * and results (`/v1/operations/...`, on the API's host or a regional one), or everything
 * else (Platform APIs).
 */
export function requestBucket(url: string): RequestBucket {
  // Fabric's own examples have both /v1/operations/{id} and /operations/{id}.
  return /^(\/v1)?\/operations(\/|$)/i.test(new URL(url).pathname) ? 'operations' : 'platform';
}

/** Whether a request gets an item's definition (`.../getDefinition`), which Fabric limits more tightly (see `RequestLimiter`). */
export function isDefinitionRequest(url: string): boolean {
  return /\/getDefinition$/i.test(new URL(url).pathname);
}

/** Why Fabric throttled a request (a 429): its overloaded capacity, or too many requests. */
async function throttleReason(response: Response): Promise<ThrottleReason> {
  try {
    const body = (await response.clone().json()) as ErrorResponse;
    return body?.errorCode === 'CapacityLimitExceeded' ? 'capacity' : 'rate';
  } catch {
    return 'rate';
  }
}

/**
 * The wait before a status check: the backoff, but never longer than Retry-After (or
 * `MAX_RETRY_AFTER_SECONDS` without one) or shorter than MIN_POLL_MS.
 */
function pollWait(backoffMs: number, retryAfterMs: number | undefined): number {
  return Math.max(MIN_POLL_MS, Math.min(backoffMs, retryAfterMs ?? MAX_RETRY_AFTER_SECONDS * 1000, MAX_RETRY_AFTER_SECONDS * 1000));
}

/** A URL for the diagnostics log: host, path and query only. */
function describeUrl(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}${u.search}`;
}

/**
 * Fabric's `Retry-After` in ms, or `undefined` if there is none or it can't be read. HTTP
 * allows a number of seconds (`120`) or a date (`Fri, 20 Nov 2026 22:51:00 GMT`); a date
 * already past means no wait. Anything else (negative, `NaN`, `Infinity`, text) is ignored
 * rather than guessed at, and each caller caps what it accepts.
 */
export function parseRetryAfter(header: string | null, now: number): number | undefined {
  const text = header?.trim();
  if (!text) {
    return undefined;
  }
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text) * 1000;
  }
  // A date has letters (the day and month names); without them Date.parse would read e.g. "-5" as a year.
  const date = /[a-z]/i.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** `ms` no longer than `maxMs`, or `undefined` if there is no `ms`. */
function capped(ms: number | undefined, maxMs: number): number | undefined {
  return ms === undefined ? undefined : Math.min(ms, maxMs);
}

/** The body as JSON, or `undefined` for an empty body (e.g. a 200 from updateDefinition). */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function toError(response: Response): Promise<FabricApiError> {
  let body: ErrorResponse = {};
  try {
    body = (await response.json()) as ErrorResponse;
  } catch {
    // Not JSON (e.g. a gateway error page); fall back to the status text.
  }
  const message = body.message ?? `${response.status} ${response.statusText}`.trim();
  return new FabricApiError(response.status, body.errorCode, message, body.requestId);
}
