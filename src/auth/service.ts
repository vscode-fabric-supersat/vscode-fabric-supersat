import { ID_PREFIX } from '../constants';
import { getConfig } from '../util/config';
import { getLogger } from '../util/logger';
import { AuthError, type AuthMethod, type Resource, type TokenProvider } from './types';

export type AuthMethodSetting = AuthMethod | 'auto';

/**
 * Chooses the sign-in method. `auto` prefers the Azure CLI (desktop only); without it,
 * VS Code sign-in if an app registration is configured, otherwise a pasted token.
 */
export function resolveAuthMethod(
  setting: AuthMethodSetting,
  available: readonly AuthMethod[],
  hasClientId: boolean,
): AuthMethod {
  if (setting !== 'auto') {
    if (!available.includes(setting)) {
      throw new AuthError(
        `The "${setting}" sign-in method isn't available here` +
          (setting === 'azureCli' ? ' (the Azure CLI only works in VS Code Desktop).' : '.'),
        { setting: `${ID_PREFIX}.auth` },
      );
    }
    return setting;
  }
  if (available.includes('azureCli')) {
    return 'azureCli';
  }
  return hasClientId && available.includes('vscode') ? 'vscode' : 'token';
}

/** Single entry point for tokens; delegates to the method chosen by the `auth.method` setting. */
export class FabricAuth {
  private readonly providers = new Map<AuthMethod, TokenProvider>();

  constructor(providers: readonly TokenProvider[]) {
    for (const p of providers) {
      this.providers.set(p.method, p);
    }
  }

  /** The provider for the current settings. */
  get provider(): TokenProvider {
    const { method, clientId } = getConfig().auth;
    const resolved = resolveAuthMethod(method, [...this.providers.keys()], clientId !== '');
    return this.providers.get(resolved)!;
  }

  getToken(resource: Resource, reason: string): Promise<string> {
    return this.provider.getToken(resource, reason);
  }

  /** Signs in and returns a message naming the account and method. */
  async signIn(): Promise<string> {
    const provider = this.provider;
    const account = await provider.signIn();
    const { tenant } = getConfig().auth;
    const message = `Signed in to Fabric as ${account} (${provider.label}${tenant ? `, tenant ${tenant}` : ''}).`;
    getLogger().info(message);
    return message;
  }

  signOut(): Promise<string> {
    return this.provider.signOut();
  }
}
