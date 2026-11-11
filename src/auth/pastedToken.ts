import type * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import { FABRIC_AUDIENCES, accountLabel, decodeJwt, isExpired, normalizeToken } from './jwt';
import { AuthCancelledError, AuthError, type Resource, type TokenProvider } from './types';

const SECRET_KEY = `${ID_PREFIX}.pastedToken`;

const AZ_COMMAND = 'az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv';
const NOTEBOOK_COMMAND = "notebookutils.credentials.getToken('pbi')";

const HOW_TO_GET_ONE = `e.g. from \`${AZ_COMMAND}\`, or \`${NOTEBOOK_COMMAND}\` in a Fabric notebook`;

/**
 * The same instructions for the Output panel, where (unlike the input box prompt) the
 * commands can be selected and copied. Each command is on a line of its own.
 */
export const HOW_TO_GET_ONE_LOG = [
  'Paste a Fabric access token into the input box. Get one with either of these:',
  `  Azure CLI:                ${AZ_COMMAND}`,
  `  Fabric notebook (Python): ${NOTEBOOK_COMMAND}`,
].join('\n');

export interface PastedTokenDeps {
  secrets: Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;
  /** Shows the input box; `vscode.window.showInputBox` in the extension. */
  prompt: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
  now?: () => number;
  /** Shows text the user can copy; the extension writes it to the Output panel. */
  showHelp?: (message: string) => void;
}

/**
 * Fallback for VS Code for the Web without an app registration: the user pastes an
 * access token obtained elsewhere. It's kept in VS Code's SecretStorage and works until
 * it expires (typically about an hour), after which the user is asked for a new one.
 */
export class PastedTokenProvider implements TokenProvider {
  readonly method = 'token';
  readonly label = 'Pasted access token';
  readonly canListTenants = false;

  private readonly now: () => number;

  constructor(private readonly deps: PastedTokenDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Returns an error message for an unusable token, or `undefined` if it's fine. */
  validate(raw: string): string | undefined {
    const token = normalizeToken(raw);
    if (!token) {
      return 'Paste an access token.';
    }
    let claims;
    try {
      claims = decodeJwt(token);
    } catch (err) {
      return (err as Error).message;
    }
    if (!claims.aud || !FABRIC_AUDIENCES.includes(claims.aud)) {
      return `This token is for "${claims.aud ?? 'unknown'}", not the Fabric API. Request it for https://api.fabric.microsoft.com.`;
    }
    if (isExpired(claims, this.now())) {
      return 'This token has expired. Get a new one.';
    }
    return undefined;
  }

  async getToken(resource: Resource, reason: string): Promise<string> {
    if (resource !== 'fabric') {
      throw new AuthError(
        'Listing tenants needs the Azure CLI or VS Code sign-in. A pasted token only works for the tenant it was issued in.',
        { configureSignIn: true },
      );
    }
    const stored = await this.deps.secrets.get(SECRET_KEY);
    if (stored && !this.validate(stored)) {
      return stored;
    }
    return this.promptAndStore(stored ? `Your Fabric token has expired. ${reason}` : reason);
  }

  async signIn(): Promise<string> {
    const token = await this.promptAndStore('Sign in to Microsoft Fabric.');
    return accountLabel(decodeJwt(token));
  }

  async signOut(): Promise<string> {
    await this.deps.secrets.delete(SECRET_KEY);
    return 'Removed the stored Fabric access token.';
  }

  private async promptAndStore(reason: string): Promise<string> {
    this.deps.showHelp?.(HOW_TO_GET_ONE_LOG);
    const raw = await this.deps.prompt({
      title: 'Fabric: Paste an Access Token',
      prompt: `${reason} Paste a Fabric access token (${HOW_TO_GET_ONE}). It's stored in VS Code's secret storage until it expires.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => this.validate(value),
    });
    if (raw === undefined) {
      throw new AuthCancelledError();
    }
    const token = normalizeToken(raw);
    await this.deps.secrets.store(SECRET_KEY, token);
    return token;
  }
}
