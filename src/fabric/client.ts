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

  /** Follows `continuationUri` links until every page has been read. */
  private async listAll<T>(firstUrl: string): Promise<T[]> {
    const items: T[] = [];
    let url: string | undefined = firstUrl;
    while (url) {
      const page: Page<T> = await this.get<Page<T>>(url);
      items.push(...(page.value ?? []));
      url = page.continuationUri;
      if (url) {
        this.assertSameOrigin(url);
      }
    }
    return items;
  }

  /** Never send the bearer token to a host other than the API's own. */
  private assertSameOrigin(url: string): void {
    if (new URL(url).origin !== new URL(this.baseUrl).origin) {
      throw new FabricApiError(0, 'UnexpectedContinuationUri', `Refusing to follow ${url}`);
    }
  }

  private async get<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });

      if (response.ok) {
        return (await response.json()) as T;
      }
      if (response.status === 429 && attempt < this.maxRetries) {
        await this.delay(retryAfterMs(response.headers.get('Retry-After')));
        continue;
      }
      throw await toError(response);
    }
  }
}

function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  const valid = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
  return Math.min(valid, MAX_RETRY_AFTER_SECONDS) * 1000;
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
