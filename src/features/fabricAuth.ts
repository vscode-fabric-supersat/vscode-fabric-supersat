import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { FabricAuth } from '../auth/service';
import {
  type AuthMethodSetting,
  getAuthSettings,
  updateAuthSettings,
  validateClientId,
  validateTenant,
} from '../auth/settings';
import { AuthCancelledError } from '../auth/types';
import { listTenants, type Tenant } from '../fabric/tenants';
import { reportError } from '../util/errors';
import { getLogger } from '../util/logger';
import type { WorkspaceService } from '../workspace/service';
import type { Feature } from './feature';

/** "Sign In to Fabric", "Sign Out" and "Configure Sign-In" (including the tenant), for whichever sign-in method is configured. */
export const fabricAuth: Feature = {
  name: 'fabricAuth',
  activate(context, { auth, workspace }) {
    context.subscriptions.push(
      vscode.commands.registerCommand(Commands.signIn, async () => {
        try {
          workspace.forgetIds(); // The account may have changed (e.g. a new `az login`).
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
          workspace.forgetIds();
          const message = await auth.signOut();
          getLogger().info(message);
          void vscode.window.showInformationMessage(message);
        } catch (err) {
          await reportError('Sign out', err);
        }
      }),

      vscode.commands.registerCommand(Commands.configureSignIn, async () => {
        try {
          await configureSignIn(auth, workspace);
        } catch (err) {
          await reportError('Configure sign-in', err);
        }
      }),
    );
  },
};

const METHODS: Record<AuthMethodSetting, { label: string; detail: string }> = {
  auto: {
    label: 'Auto',
    detail: 'Desktop: Azure CLI. Web: VS Code sign-in if a client ID is set, otherwise a pasted token.',
  },
  azureCli: { label: 'Azure CLI', detail: 'Your `az login` account. No app registration needed. Desktop only.' },
  vscode: {
    label: 'VS Code (app registration)',
    detail: "VS Code's Accounts menu, with your own Microsoft Entra app registration (needs a client ID).",
  },
  token: { label: 'Pasted token', detail: 'Paste an access token obtained elsewhere. Lasts about an hour.' },
};

/**
 * Shows the sign-in settings and lets the user change one. These are kept in the
 * extension's own state, never in a settings file (see `auth/settings.ts`).
 */
async function configureSignIn(auth: FabricAuth, workspace: WorkspaceService): Promise<void> {
  const current = getAuthSettings();
  const choice = await vscode.window.showQuickPick(
    [
      { id: 'method', label: 'Sign-in method', description: METHODS[current.method].label },
      { id: 'clientId', label: 'App registration client ID', description: current.clientId || 'not set' },
      { id: 'tenant', label: 'Tenant', description: current.tenant || 'default' },
    ] as const,
    { title: 'Fabric: Configure Sign-In', placeHolder: 'Setting to change' },
  );
  if (!choice) {
    return;
  }

  if (choice.id === 'method') {
    const available = auth.availableMethods;
    const picked = await vscode.window.showQuickPick(
      (Object.keys(METHODS) as AuthMethodSetting[])
        .filter((m) => m === 'auto' || available.includes(m))
        .map((method) => ({
          method,
          label: METHODS[method].label,
          description: method === current.method ? '(current)' : undefined,
          detail: METHODS[method].detail,
        })),
      { title: 'Fabric: Sign-In Method' },
    );
    if (picked && picked.method !== current.method) {
      await updateAuthSettings({ method: picked.method });
      workspace.forgetIds();
      report(`Fabric sign-in method set to ${picked.label}.`);
    }
    return;
  }

  if (choice.id === 'clientId') {
    const value = await vscode.window.showInputBox({
      title: 'Fabric: App Registration Client ID',
      prompt: 'Application (client) ID of your Microsoft Entra app registration. Leave empty to clear it.',
      value: current.clientId,
      ignoreFocusOut: true,
      validateInput: (v) => validateClientId(v.trim()),
    });
    if (value !== undefined && value.trim() !== current.clientId) {
      await updateAuthSettings({ clientId: value });
      workspace.forgetIds();
      report(value.trim() ? `Fabric app registration client ID set to ${value.trim()}.` : 'Cleared the Fabric client ID.');
    }
    return;
  }

  await configureTenant(auth, workspace);
}

function report(message: string): void {
  getLogger().info(message);
  void vscode.window.showInformationMessage(message);
}

/**
 * Picks the tenant: one of the user's tenants (listed when the sign-in method can), a
 * tenant ID or domain typed in, or none (clears it, so the default tenant is used).
 * Signs in after a tenant is picked from the list, as the user is already signed in.
 */
async function configureTenant(auth: FabricAuth, workspace: WorkspaceService): Promise<void> {
  const current = getAuthSettings().tenant;
  const provider = auth.provider;

  // Listing needs an ARM token. If that fails (e.g. not signed in yet), the tenant can
  // still be typed in or cleared, which is often how the user gets signed in at all.
  let tenants: Tenant[] = [];
  let listProblem: string | undefined;
  if (provider.canListTenants) {
    try {
      tenants = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fabric: Loading tenants…' },
        () => listTenants(() => auth.getToken('arm', 'Fabric Supersat needs to list your Microsoft Entra tenants.')),
      );
    } catch (err) {
      if (err instanceof AuthCancelledError) {
        return;
      }
      listProblem = err instanceof Error ? err.message : String(err);
      getLogger().warn(`Could not list tenants: ${listProblem}`);
    }
  } else {
    listProblem = `"${provider.label}" can't list tenants`;
  }

  type Item = vscode.QuickPickItem & { action?: 'enter' | 'clear'; tenantId?: string; isCurrent?: boolean };
  const lowered = current.toLowerCase();
  const tenantItems: Item[] = tenants
    .map((t) => {
      const isCurrent =
        !!lowered && (t.tenantId.toLowerCase() === lowered || t.defaultDomain?.toLowerCase() === lowered);
      return {
        label: t.displayName ?? t.defaultDomain ?? t.tenantId,
        description: [t.defaultDomain, isCurrent ? '(current)' : ''].filter(Boolean).join(' '),
        detail: t.tenantId,
        tenantId: t.tenantId,
        isCurrent,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const items: Item[] = [
    ...tenantItems,
    ...(tenantItems.length ? [{ label: '', kind: vscode.QuickPickItemKind.Separator }] : []),
    {
      label: '$(edit) Enter tenant ID or domain…',
      description: current && !tenantItems.some((t) => t.isCurrent) ? `current: ${current}` : undefined,
      action: 'enter',
    },
    ...(current
      ? [{ label: '$(clear-all) Clear tenant', description: 'use your default tenant', action: 'clear' as const }]
      : []),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Fabric: Tenant',
    placeHolder: listProblem
      ? `Tenants couldn't be listed (${listProblem}). Enter one${current ? ' or clear it' : ''}.`
      : `Tenant to use for Fabric (current: ${current || 'default'})`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return;
  }

  if (picked.tenantId) {
    await setTenant(picked.tenantId, workspace, !picked.isCurrent);
    getLogger().info(`Switched Fabric tenant to ${picked.label} (${picked.tenantId})`);
    report(await auth.signIn());
    return;
  }

  if (picked.action === 'clear') {
    await setTenant('', workspace);
    report('Cleared the Fabric tenant. Fabric now uses your default tenant.');
    return;
  }

  const value = await vscode.window.showInputBox({
    title: 'Fabric: Tenant',
    prompt: 'Tenant ID or domain, such as contoso.onmicrosoft.com. Leave empty for your default tenant.',
    value: current,
    ignoreFocusOut: true,
    validateInput: (v) => validateTenant(v.trim()),
  });
  if (value !== undefined && value.trim() !== current) {
    await setTenant(value.trim(), workspace);
    report(value.trim() ? `Fabric tenant set to ${value.trim()}.` : 'Fabric now uses your default tenant.');
  }
}

/**
 * Saves the tenant, and clears the saved workspace if the tenant changed (workspaces
 * belong to a tenant). `changed` overrides the comparison, for when the old value was a
 * domain and the new one is the same tenant's ID.
 */
async function setTenant(
  tenant: string,
  workspace: WorkspaceService,
  changed = tenant.toLowerCase() !== getAuthSettings().tenant.toLowerCase(),
): Promise<void> {
  await updateAuthSettings({ tenant });
  workspace.forgetIds();
  if (changed && workspace.current) {
    await workspace.save(undefined);
    getLogger().info('Cleared the saved Fabric workspace (it belongs to the previous tenant)');
  }
}
