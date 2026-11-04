// Desktop only (Node.js extension host): runs the Azure CLI. Never import from shared code.
import { execFile } from 'node:child_process';
import { ID_PREFIX } from '../constants';
import { accountLabel, decodeJwt } from '../auth/jwt';
import { AuthError, type Resource, type TokenProvider } from '../auth/types';

/** Resource URIs passed to `az account get-access-token --resource`. */
export const AZ_RESOURCES: Record<Resource, string> = {
  fabric: 'https://api.fabric.microsoft.com',
  arm: 'https://management.azure.com',
};

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Runs a program. Rejects with an Error that may carry `code` and `stderr`. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<ExecResult>;

/** Refresh tokens this long before they expire. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const INSTALL_URL = 'https://learn.microsoft.com/cli/azure/install-azure-cli';
/** Tenant IDs and domains only; keeps the argument safe even when a shell is used (Windows). */
const SAFE_TENANT = /^[A-Za-z0-9.-]{1,256}$/;
/** `az login` commands suggested by the CLI that are safe to run in a terminal. */
const SAFE_LOGIN_COMMAND = /^az login(?: --[a-z-]+(?: "?[A-Za-z0-9.:/_-]+"?)?)*$/;

export interface AzureCliOptions {
  /** Current `auth.tenant` setting ('' for the CLI's default). */
  getTenant: () => string;
  /**
   * True when `az login` can't complete a browser sign-in on this machine (remote
   * extension host, browser-based VS Code, Linux without a display). The suggested
   * `az login` then uses `--use-device-code`.
   */
  preferDeviceCode?: boolean;
  exec?: ExecFn;
  now?: () => number;
}

interface AzTokenOutput {
  accessToken: string;
  /** Seconds since the epoch (Azure CLI 2.54+). */
  expires_on?: number | string;
}

/**
 * Uses the account the user signed in to with `az login`. No app registration is
 * needed: the Azure CLI is already authorized by Microsoft for the Fabric API, which is
 * also how Microsoft's fabric-cicd library authenticates. Default on desktop.
 */
export class AzureCliTokenProvider implements TokenProvider {
  readonly method = 'azureCli';
  readonly label = 'Azure CLI';
  readonly supportsTenantSwitching = true;

  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly getTenant: () => string;
  private readonly preferDeviceCode: boolean;
  private readonly exec: ExecFn;
  private readonly now: () => number;

  constructor(options: AzureCliOptions) {
    this.getTenant = options.getTenant;
    this.preferDeviceCode = options.preferDeviceCode ?? false;
    this.exec = options.exec ?? defaultExec;
    this.now = options.now ?? Date.now;
  }

  async getToken(resource: Resource): Promise<string> {
    const tenant = this.getTenant();
    if (tenant && !SAFE_TENANT.test(tenant)) {
      throw new AuthError(`"${tenant}" is not a valid tenant ID or domain.`, {
        setting: `${ID_PREFIX}.auth.tenant`,
      });
    }
    const key = `${resource}|${tenant}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now()) {
      return cached.token;
    }

    const args = ['account', 'get-access-token', '--resource', AZ_RESOURCES[resource], '--output', 'json'];
    if (tenant) {
      args.push('--tenant', tenant);
    }
    let output: AzTokenOutput;
    try {
      const { stdout } = await this.exec('az', args);
      output = JSON.parse(stdout) as AzTokenOutput;
    } catch (err) {
      throw toAuthError(err, { tenant, preferDeviceCode: this.preferDeviceCode });
    }
    if (!output.accessToken) {
      throw new AuthError('The Azure CLI returned no access token.');
    }
    this.cache.set(key, { token: output.accessToken, expiresAt: expiryMs(output) });
    return output.accessToken;
  }

  async signIn(): Promise<string> {
    this.cache.clear(); // pick up a different `az login` account
    return accountLabel(decodeJwt(await this.getToken('fabric')));
  }

  async signOut(): Promise<string> {
    this.cache.clear();
    return 'Fabric Supersat uses your Azure CLI login. Run "az logout" to sign out of the Azure CLI.';
  }
}

function expiryMs(output: AzTokenOutput): number {
  const seconds = Number(output.expires_on);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  try {
    const exp = decodeJwt(output.accessToken).exp;
    if (exp) {
      return exp * 1000;
    }
  } catch {
    // Fall through: don't cache an expiry we can't read.
  }
  return 0;
}

/**
 * The `az login` command to offer. Starts from the CLI's own suggestion when it's safe
 * (it may include `--tenant` or `--scope`), then adds:
 * - `--use-device-code` when a browser sign-in can't complete on this machine;
 * - `--allow-no-subscriptions`, because many Fabric users have no Azure subscription and
 *   `az login` otherwise fails with "No subscriptions found". With subscriptions it only
 *   adds tenant-level entries to `az account list`.
 */
export function loginCommand(suggested: string | undefined, tenant: string, preferDeviceCode: boolean): string {
  const parts = [suggested ?? (tenant ? `az login --tenant ${tenant}` : 'az login')];
  if (preferDeviceCode && !parts[0].includes('--use-device-code')) {
    parts.push('--use-device-code');
  }
  if (!parts[0].includes('--allow-no-subscriptions')) {
    parts.push('--allow-no-subscriptions');
  }
  return parts.join(' ');
}

/** Maps Azure CLI failures to errors with a fix the user can click. */
export function toAuthError(
  err: unknown,
  { tenant, preferDeviceCode }: { tenant: string; preferDeviceCode: boolean },
): AuthError {
  const e = err as { code?: unknown; stderr?: string; message?: string };
  const stderr = (e.stderr ?? '').trim();

  if (e.code === 'ENOENT' || /'az' is not recognized|az: (command )?not found/i.test(stderr)) {
    return new AuthError(
      `The Azure CLI isn't installed (or isn't on the PATH of the machine running the VS Code ${preferDeviceCode ? 'remote ' : ''}extension host). ` +
        `Install it, or choose another sign-in method in "${ID_PREFIX}.auth.method".`,
      { link: { label: 'Install Azure CLI', url: INSTALL_URL }, setting: `${ID_PREFIX}.auth` },
    );
  }
  if (e instanceof SyntaxError) {
    return new AuthError('The Azure CLI returned output that isn\'t JSON. Run "az account get-access-token" in a terminal to check.');
  }

  const firstError = stderr.split(/\r?\n/).find((l) => l.startsWith('ERROR:')) ?? stderr.split(/\r?\n/)[0] ?? '';
  if (/az login/.test(stderr)) {
    const suggested = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => SAFE_LOGIN_COMMAND.test(l));
    return new AuthError(`Sign in to the Azure CLI first. ${firstError}`.trim(), {
      terminalCommand: loginCommand(suggested, tenant, preferDeviceCode),
    });
  }
  return new AuthError(`Azure CLI: ${firstError || e.message || String(err)}`);
}

/** Runs `file` without a shell, except on Windows where `az` is a .cmd script. */
const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 60_000, windowsHide: true, shell: process.platform === 'win32', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr: String(stderr) }));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });
