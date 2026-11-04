import * as vscode from 'vscode';
import { ID_PREFIX } from '../constants';
import { getConfig } from '../util/config';
import { AuthError, type Resource, type TokenProvider } from './types';

/** VS Code's built-in Microsoft (Entra ID) authentication provider. */
export const AUTH_PROVIDER_ID = 'microsoft';

/**
 * Fabric REST API token. `.default` grants whatever Power BI Service permissions are
 * configured (and consented) on the app registration, so adding a permission there
 * needs no code change. Same resource and pattern as Microsoft's own Fabric extension.
 */
export const FABRIC_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';

/** Azure Resource Manager token, used only to list the user's tenants. */
export const ARM_SCOPE = 'https://management.azure.com/.default';

const SCOPES: Record<Resource, string> = { fabric: FABRIC_SCOPE, arm: ARM_SCOPE };

/**
 * Scopes for a session request. The built-in provider reads the special
 * `VSCODE_CLIENT_ID:` and `VSCODE_TENANT:` scopes to choose the app registration and
 * tenant. Without a tenant it uses `organizations` (multi-tenant registrations only).
 *
 * A client ID is required: VS Code's own app (the provider's default) is not
 * pre-authorized by Microsoft for the Fabric API and always fails with AADSTS65002.
 */
export function getSessionScopes(resource: Resource = 'fabric'): string[] {
  const { clientId, tenant } = getConfig().auth;
  if (!clientId) {
    throw new AuthError(
      `Signing in with VS Code needs your own Microsoft Entra app registration. Set "${ID_PREFIX}.auth.clientId" ` +
        '(see "Signing in to Fabric" in the README).',
      { setting: `${ID_PREFIX}.auth` },
    );
  }
  const scopes = [`VSCODE_CLIENT_ID:${clientId}`];
  if (tenant) {
    scopes.push(`VSCODE_TENANT:${tenant}`);
  }
  scopes.push(SCOPES[resource]);
  return scopes;
}

/** Sign-in through VS Code's Accounts menu, using your own app registration. */
export class VscodeSessionProvider implements TokenProvider {
  readonly method = 'vscode';
  readonly label = 'VS Code (Microsoft account)';
  readonly supportsTenantSwitching = true;

  async getToken(resource: Resource, reason: string): Promise<string> {
    // Returns an existing session silently; otherwise prompts, showing `reason`.
    const session = await vscode.authentication.getSession(AUTH_PROVIDER_ID, getSessionScopes(resource), {
      createIfNone: { detail: reason },
    });
    return session.accessToken;
  }

  async signIn(): Promise<string> {
    const session = await vscode.authentication.getSession(AUTH_PROVIDER_ID, getSessionScopes(), {
      createIfNone: { detail: 'Sign in to Microsoft Fabric.' },
    });
    return session.account.label;
  }

  async signOut(): Promise<string> {
    return 'To sign out, use the Accounts menu at the bottom of the Activity Bar.';
  }
}
