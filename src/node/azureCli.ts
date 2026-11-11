// Desktop only (Node.js extension host): runs the Azure CLI. Never import from shared code.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import * as path from 'node:path';
import { accountLabel, decodeJwt } from '../auth/jwt';
import { SAFE_TENANT } from '../auth/settings';
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
/** `az login` commands suggested by the CLI that are safe to run in a terminal. */
const SAFE_LOGIN_COMMAND = /^az login(?: --[a-z-]+(?: "?[A-Za-z0-9.:/_-]+"?)?)*$/;

export interface AzureCliOptions {
  /** Current sign-in tenant ('' for the CLI's default). Re-checked against `SAFE_TENANT`, since a shell is used on Windows. */
  getTenant: () => string;
  /**
   * True when `az login` can't complete a browser sign-in on this machine (remote
   * extension host, browser-based VS Code, Linux without a display). The suggested
   * `az login` then uses `--use-device-code`.
   */
  preferDeviceCode?: boolean;
  /** Finds the Azure CLI's full path (default: `findExecutable('az')` on `PATH`), or `undefined` if it isn't installed. */
  findAz?: () => string | undefined;
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
  readonly canListTenants = true;

  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly getTenant: () => string;
  private readonly preferDeviceCode: boolean;
  private readonly findAz: () => string | undefined;
  private readonly exec: ExecFn;
  private readonly now: () => number;

  constructor(options: AzureCliOptions) {
    this.getTenant = options.getTenant;
    this.preferDeviceCode = options.preferDeviceCode ?? false;
    this.findAz = options.findAz ?? (() => findExecutable('az'));
    this.exec = options.exec ?? defaultExec;
    this.now = options.now ?? Date.now;
  }

  async getToken(resource: Resource): Promise<string> {
    const tenant = this.getTenant();
    if (tenant && !SAFE_TENANT.test(tenant)) {
      throw new AuthError(`"${tenant}" is not a valid tenant ID or domain.`, { configureSignIn: true });
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
      // Run by its full path, found only in PATH's absolute folders: never an `az` in the
      // current folder (which cmd.exe would otherwise run first), e.g. one in an untrusted repo.
      const az = this.findAz();
      if (!az) {
        throw Object.assign(new Error('The Azure CLI (az) was not found on PATH.'), { code: 'ENOENT' });
      }
      const { stdout } = await this.exec(az, args);
      output = JSON.parse(stdout) as AzTokenOutput;
    } catch (err) {
      throw toAuthError(err, { tenant, preferDeviceCode: this.preferDeviceCode });
    }
    if (!output.accessToken) {
      throw new AuthError('The Azure CLI returned no access token.', {}, { unexpected: true });
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
        `Install it, or choose another sign-in method with "Fabric Supersat: Configure Sign-In".`,
      { link: { label: 'Install Azure CLI', url: INSTALL_URL }, configureSignIn: true },
    );
  }
  if (e instanceof SyntaxError) {
    return new AuthError('The Azure CLI returned output that isn\'t JSON. Run "az account get-access-token" in a terminal to check.', {}, { unexpected: true });
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
  return new AuthError(`Azure CLI: ${firstError || e.message || String(err)}`, {}, { unexpected: true });
}

export interface FindExecutableOptions {
  /** The PATH value; defaults to the extension host's. */
  path?: string;
  /** Windows' executable extensions (PATHEXT); defaults to the extension host's, or `.COM;.EXE;.BAT;.CMD`. */
  pathExt?: string;
  platform?: NodeJS.Platform;
  /** Whether a file exists and can be run; defaults to checking the file system. */
  isExecutable?: (file: string) => boolean;
}

/**
 * The full path of the program `name`, from the folders on PATH, in order, or `undefined`
 * if there is none. Only absolute folders count: an empty or relative PATH entry (such as
 * `.`) would mean the current folder, which may be an untrusted project. On Windows, `name`
 * plus each PATHEXT extension is tried (e.g. `az.cmd`), as cmd.exe would, but the current
 * folder is never searched first.
 */
export function findExecutable(name: string, options: FindExecutableOptions = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const extensions = windows
    ? (options.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        // Lower case, as installed files are named (Windows file names ignore case anyway).
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.startsWith('.'))
    : [''];
  const entries = (options.path ?? process.env.PATH ?? process.env.Path ?? '').split(windows ? ';' : ':');
  for (const entry of entries) {
    const dir = (windows ? entry.trim().replace(/^"(.*)"$/, '$1') : entry).trim();
    if (!dir || !paths.isAbsolute(dir)) {
      continue;
    }
    for (const extension of extensions) {
      const file = paths.join(dir, `${name}${extension}`);
      if (isExecutable(file)) {
        return file;
      }
    }
  }
  return undefined;
}

function defaultIsExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      accessSync(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `file` (a full path) without a shell, except on Windows, where `az` is a .cmd
 * script that needs cmd.exe: there the path is quoted (it usually has spaces, e.g. under
 * `C:\Program Files`). The arguments are fixed or validated (see `SAFE_TENANT`).
 */
const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    const windows = process.platform === 'win32';
    execFile(
      windows ? `"${file}"` : file,
      args,
      { timeout: 60_000, windowsHide: true, shell: windows, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr: String(stderr) }));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });
