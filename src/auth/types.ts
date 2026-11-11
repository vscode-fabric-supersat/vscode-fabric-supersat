import type { ErrorFix, FixableError, QuietError, WarningError } from '../util/errorFix';

/** How the extension gets Microsoft Entra tokens. Chosen with "Configure Sign-In" (see `settings.ts`). */
export type AuthMethod = 'azureCli' | 'vscode' | 'token';

/** The APIs the extension needs tokens for. */
export type Resource =
  /** Fabric REST API (api.fabric.microsoft.com). */
  | 'fabric'
  /** Azure Resource Manager, only used to list tenants in "Configure Sign-In". */
  | 'arm';

/** One way of signing in. Implementations live in `src/auth` (shared) and `src/node` (desktop only). */
export interface TokenProvider {
  readonly method: AuthMethod;
  /** Shown to users, e.g. "Azure CLI". */
  readonly label: string;
  /** Whether "Configure Sign-In" can list tenants with this method (it needs an ARM token). */
  readonly canListTenants: boolean;

  /** Returns a bearer token, prompting the user if needed. `reason` explains why in the prompt. */
  getToken(resource: Resource, reason: string): Promise<string>;
  /** Signs in (prompting if needed) and returns the account name. */
  signIn(): Promise<string>;
  /** Forgets what the extension stored, and returns a message for the user. */
  signOut(): Promise<string>;
}

/**
 * A sign-in problem the user can fix. `reportError` turns the optional fields into
 * buttons: configure sign-in, run a command in a terminal, or open a web page. A warning
 * (see `WarningError`: e.g. sign-in declined, the Azure CLI not installed or not signed in),
 * unless `unexpected` (e.g. output from the Azure CLI that can't be read), then an error.
 */
export class AuthError extends Error implements FixableError, WarningError {
  readonly warning: boolean;

  constructor(
    message: string,
    readonly fix: Pick<ErrorFix, 'configureSignIn' | 'terminalCommand' | 'link'> = {},
    { unexpected = false }: { unexpected?: boolean } = {},
  ) {
    super(message);
    this.name = 'AuthError';
    this.warning = !unexpected;
  }
}

/** The user dismissed a sign-in prompt. Logged, but not shown as an error. */
export class AuthCancelledError extends Error implements QuietError {
  readonly quiet = true;

  constructor(message = 'Sign-in was cancelled.') {
    super(message);
    this.name = 'AuthCancelledError';
  }
}
