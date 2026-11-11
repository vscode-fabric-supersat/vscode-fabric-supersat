import * as vscode from 'vscode';
import { Commands, ID_PREFIX } from '../constants';
import type { FabricAuth } from '../auth/service';
import { AuthError } from '../auth/types';
import { listTenants } from '../fabric/tenants';
import { getConfig } from '../util/config';
import { reportError } from '../util/errors';
import { getLogger } from '../util/logger';
import type { WorkspaceService } from '../workspace/service';
import type { Feature } from './feature';

/** "Sign In to Fabric", "Sign Out" and "Switch Tenant", for whichever sign-in method is configured. */
export const fabricAuth: Feature = {
  name: 'fabricAuth',
  activate(context, { auth, workspace }) {
    context.subscriptions.push(
      vscode.commands.registerCommand(Commands.signIn, async () => {
        try {
          const message = await auth.signIn();
          void vscode.window.showInformationMessage(message);
          return message;
        } catch (err) {
          await reportError('Sign in to Fabric', err);
          return undefined;
        }
      }),

      vscode.commands.registerCommand(Commands.signOut, async () => {
        try {
          const message = await auth.signOut();
          getLogger().info(message);
          void vscode.window.showInformationMessage(message);
        } catch (err) {
          await reportError('Sign out', err);
        }
      }),

      vscode.commands.registerCommand(Commands.switchTenant, async () => {
        try {
          return await switchTenant(auth, workspace);
        } catch (err) {
          await reportError('Switch tenant', err);
          return undefined;
        }
      }),
    );
  },
};

/**
 * Lets the user pick one of their tenants, stores it in the `auth.tenant` setting (user
 * scope) and signs in to it. Clears the saved workspace when the tenant changes, since
 * workspaces belong to a tenant. Returns the chosen tenant ID.
 */
async function switchTenant(auth: FabricAuth, workspace: WorkspaceService): Promise<string | undefined> {
  const provider = auth.provider;
  if (!provider.supportsTenantSwitching) {
    throw new AuthError(
      `Switch Tenant isn't available with "${provider.label}". Use the Azure CLI or VS Code sign-in.`,
      { setting: `${ID_PREFIX}.auth` },
    );
  }
  const tenants = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Fabric: Loading tenants…' },
    () => listTenants(() => auth.getToken('arm', 'Fabric Supersat needs to list your Microsoft Entra tenants.')),
  );
  const current = getConfig().auth.tenant.toLowerCase();
  const picked = await vscode.window.showQuickPick(
    tenants
      .map((t) => {
        const isCurrent =
          !!current && (t.tenantId.toLowerCase() === current || t.defaultDomain?.toLowerCase() === current);
        return {
          label: t.displayName ?? t.defaultDomain ?? t.tenantId,
          description: [t.defaultDomain, isCurrent ? '(current)' : ''].filter(Boolean).join(' '),
          detail: t.tenantId,
          tenantId: t.tenantId,
          isCurrent,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
    {
      title: 'Fabric: Switch Tenant',
      placeHolder: tenants.length ? 'Tenant to use for Fabric' : 'No tenants found',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (!picked) {
    return undefined;
  }

  await vscode.workspace
    .getConfiguration(ID_PREFIX)
    .update('auth.tenant', picked.tenantId, vscode.ConfigurationTarget.Global);
  getLogger().info(`Switched Fabric tenant to ${picked.label} (${picked.tenantId})`);
  if (!picked.isCurrent && workspace.current) {
    await workspace.save(undefined);
    getLogger().info('Cleared the saved Fabric workspace (it belongs to the previous tenant)');
  }
  void vscode.window.showInformationMessage(await auth.signIn());
  return picked.tenantId;
}
