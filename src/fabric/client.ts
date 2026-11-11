/**
 * Minimal Microsoft Fabric REST API client (https://learn.microsoft.com/rest/api/fabric/).
 *
 * Has no `vscode` dependency and takes `fetch`, the token source and the delay function
 * as inputs, so it runs unchanged on desktop and web and can be unit-tested offline.
 */

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

export class FabricApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'FabricApiError';
  }
}

export interface FabricClientOptions {
  /** Returns a bearer token for the Fabric API. */
  getToken: () => Promise<string>;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** How many times to retry a request answered with 429 (Too Many Requests). */
  maxRetries?: number;
  /** Waits for the given number of milliseconds; replaceable in tests. */
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_AFTER_SECONDS = 5;
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
/** Long-running operations (e.g. exporting a big notebook) are polled for at most this long. */
const MAX_OPERATION_SECONDS = 10 * 60;
const MAX_RETRY_AFTER_SECONDS = 60;

export class FabricClient {
  private readonly getToken: () => Promise<string>;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(options: FabricClientOptions) {
    this.getToken = options.getToken;
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? FABRIC_API_BASE_URL).replace(/\/+$/, '');
    this.maxRetries = options.maxRetries ?? 3;
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  /** A notebook's content. Omit `format` for Fabric's Git format (`notebook-content.py`). */
  getNotebookDefinition(workspaceId: string, notebookId: string, format?: 'ipynb'): Promise<ItemDefinition> {
    const query = format ? `?format=${format}` : '';
    return this.send<{ definition: ItemDefinition }>(
      'POST',
      `${this.notebookUrl(workspaceId, notebookId)}/getDefinition${query}`,
    ).then((r) => r.definition);
  }

  /** Replaces a notebook's content. */
  async updateNotebookDefinition(workspaceId: string, notebookId: string, definition: ItemDefinition): Promise<void> {
    await this.send('POST', `${this.notebookUrl(workspaceId, notebookId)}/updateDefinition`, { definition });
  }

  /** Creates a notebook with the given content, and description if given. */
  createNotebook(
    workspaceId: string,
    displayName: string,
    definition: ItemDefinition,
    description?: string,
  ): Promise<Notebook> {
    return this.send<Notebook>('POST', `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/notebooks`, {
      displayName,
      ...(description ? { description } : {}),
      definition,
    });
  }

  /** Changes a notebook's properties (not its content). */
  async updateNotebook(
    workspaceId: string,
    notebookId: string,
    properties: { description?: string; displayName?: string },
  ): Promise<Notebook> {
    const response = await this.fetchWithRetry(this.notebookUrl(workspaceId, notebookId), 'PATCH', properties);
    return (await readJson(response)) as Notebook;
  }

  private notebookUrl(workspaceId: string, notebookId: string): string {
    return `${this.baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/notebooks/${encodeURIComponent(notebookId)}`;
  }

  /**
   * Sends a request that may be a long-running operation: a 202 response is polled at its
   * `Location` until it finishes, then its result is fetched from the `Location` of the final
   * status (none means the operation has no result). As in Microsoft's fabric-cicd and Fabric
   * VS Code extension, a newer `Location` from any status check is followed from then on.
   * https://learn.microsoft.com/rest/api/fabric/articles/long-running-operation
   */
  private async send<T>(method: 'POST', url: string, body?: unknown): Promise<T> {
    const response = await this.fetchWithRetry(url, method, body);
    if (response.status !== 202) {
      return (await readJson(response)) as T;
    }
    let location = response.headers.get('Location');
    if (!location) {
      throw new FabricApiError(202, 'MissingLocation', 'Fabric accepted the request but gave no operation to follow.');
    }
    this.assertTrusted(location, 'UntrustedOperationUrl');
    let wait = retryAfterMs(response.headers.get('Retry-After'));
    for (let waited = 0; ; waited += wait) {
      if (waited > MAX_OPERATION_SECONDS * 1000) {
        throw new FabricApiError(0, 'OperationTimeout', `Fabric didn't finish the operation within ${MAX_OPERATION_SECONDS / 60} minutes.`);
      }
      await this.delay(wait);
      const poll = await this.fetchWithRetry(location, 'GET');
      const state = (await poll.json()) as OperationState;
      const next = poll.headers.get('Location');
      if (state.status === 'Succeeded') {
        // Operations that return content (e.g. getDefinition) point to it with Location.
        if (!next) {
          return undefined as T;
        }
        this.assertTrusted(next, 'UntrustedOperationUrl');
        return (await readJson(await this.fetchWithRetry(next, 'GET'))) as T;
      }
      if (state.status === 'Failed' || state.status === 'Undefined') {
        throw new FabricApiError(
          0,
          state.error?.errorCode ?? 'OperationFailed',
          state.error?.message ?? 'The Fabric operation failed.',
          state.error?.requestId,
        );
      }
      if (next && next !== location) {
        this.assertTrusted(next, 'UntrustedOperationUrl');
        location = next;
      }
      wait = retryAfterMs(poll.headers.get('Retry-After'), 1);
    }
  }

  /** Follows `continuationUri` links until every page has been read. */
  private async listAll<T>(firstUrl: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = firstUrl;
    while (url) {
      const page: Page<T> = await this.get<Page<T>>(url);
      items.push(...(page.value ?? []));
      url = page.continuationUri;
      if (url) {
        this.assertTrusted(url, 'UnexpectedContinuationUri');
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

  /** Sends a request, retrying 429s. Returns successful responses (and `allowed` statuses); throws otherwise. */
  private async fetchWithRetry(
    url: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    allowed: readonly number[] = [],
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const response = await this.fetchFn(url, {
        method,
        // The token must only go where `assertTrusted` allows; Fabric doesn't use HTTP redirects.
        redirect: 'error',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (response.ok || allowed.includes(response.status)) {
        return response;
      }
      if (response.status === 429 && attempt < this.maxRetries) {
        await this.delay(retryAfterMs(response.headers.get('Retry-After')));
        continue;
      }
      throw await toError(response);
    }
  }
}

function retryAfterMs(header: string | null, defaultSeconds = DEFAULT_RETRY_AFTER_SECONDS): number {
  const seconds = Number(header);
  const valid = header !== null && Number.isFinite(seconds) && seconds >= 0 ? seconds : defaultSeconds;
  return Math.min(valid, MAX_RETRY_AFTER_SECONDS) * 1000;
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
