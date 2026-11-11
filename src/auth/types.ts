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
 * buttons: configure sign-in, run a command in a terminal, or open a web page.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly fix: {
      /** Offer the "Configure Sign-In" command. */
      configureSignIn?: boolean;
      terminalCommand?: string;
      link?: { label: string; url: string };
    } = {},
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** The user dismissed a sign-in prompt. Logged, but not shown as an error. */
export class AuthCancelledError extends Error {
  constructor(message = 'Sign-in was cancelled.') {
    super(message);
    this.name = 'AuthCancelledError';
  }
}
