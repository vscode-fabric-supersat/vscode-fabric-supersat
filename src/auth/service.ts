import { type AuthMethodSetting, getAuthSettings } from './settings';
import { getLogger } from '../util/logger';
import { AuthError, type AuthMethod, type Resource, type TokenProvider } from './types';

export type { AuthMethodSetting };

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
        { configureSignIn: true },
      );
    }
    return setting;
  }
  if (available.includes('azureCli')) {
    return 'azureCli';
  }
  return hasClientId && available.includes('vscode') ? 'vscode' : 'token';
}

/** Single entry point for tokens; delegates to the method chosen by the sign-in settings (`settings.ts`). */
export class FabricAuth {
  private readonly providers = new Map<AuthMethod, TokenProvider>();
  /** Token requests under way, by provider, settings and resource (see `getToken`). */
  private readonly pending = new Map<string, Promise<string>>();

  constructor(providers: readonly TokenProvider[]) {
    for (const p of providers) {
      this.providers.set(p.method, p);
    }
  }

  /** The provider for the current settings. */
  get provider(): TokenProvider {
    const { method, clientId } = getAuthSettings();
    const resolved = resolveAuthMethod(method, [...this.providers.keys()], clientId !== '');
    return this.providers.get(resolved)!;
  }

  /** The sign-in methods this platform supports. */
  get availableMethods(): AuthMethod[] {
    return [...this.providers.keys()];
  }

  /**
   * A token for `resource`. Calls made while one is being fetched share it, so many requests
   * at once (bulk commands run up to 128 notebooks) start one `az` process or one sign-in
   * prompt, not one each. A pasted-token prompt asked for again would otherwise cancel the
   * one already showing, failing every request but the last.
   */
  getToken(resource: Resource, reason: string): Promise<string> {
    const provider = this.provider;
    const { clientId, tenant } = getAuthSettings();
    const key = [provider.method, clientId, tenant, resource].join('\n');
    let token = this.pending.get(key);
    if (!token) {
      token = provider.getToken(resource, reason).finally(() => this.pending.delete(key));
      this.pending.set(key, token);
    }
    return token;
  }

  /** Signs in and returns a message naming the account and method. */
  async signIn(): Promise<string> {
    const provider = this.provider;
    const account = await provider.signIn();
    const { tenant } = getAuthSettings();
    const message = `Signed in to Fabric as ${account} (${provider.label}${tenant ? `, tenant ${tenant}` : ''}).`;
    getLogger().info(message);
    return message;
  }

  signOut(): Promise<string> {
    return this.provider.signOut();
  }
}
