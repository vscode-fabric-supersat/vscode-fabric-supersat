import * as vscode from 'vscode';
import { Commands } from '../constants';
import { FabricClient, type Notebook, type Workspace } from '../fabric/client';
import { reportError } from '../util/errors';
import { getLogger } from '../util/logger';
import type { Feature } from './feature';

/**
 * "List Notebooks": pick a workspace, then browse its notebooks. Choosing a notebook
 * copies its ID. Pass a workspace ID as the argument to skip the workspace picker.
 */
export const notebooks: Feature = {
  name: 'notebooks',
  activate(context, { auth }) {
    const client = new FabricClient({
      getToken: () => auth.getToken('fabric', 'Fabric Supersat needs to sign in to read your Fabric workspaces.'),
    });

    context.subscriptions.push(
      vscode.commands.registerCommand(Commands.listNotebooks, async (workspaceId?: string) => {
        try {
          const workspace = workspaceId ? { id: workspaceId } : await pickWorkspace(client);
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading notebooks…', () =>
            client.listNotebooks(workspace.id),
          );
          getLogger().info(`Workspace ${workspace.id}: ${items.length} notebook(s)`);
          await showNotebooks(items, 'displayName' in workspace ? workspace.displayName : workspace.id);
          return items;
        } catch (err) {
          await reportError('List notebooks', err);
          return undefined;
        }
      }),
    );
  },
};

async function pickWorkspace(client: FabricClient): Promise<Workspace | undefined> {
  const workspaces = await withProgress('Loading workspaces…', () => client.listWorkspaces());
  const picked = await vscode.window.showQuickPick(
    workspaces
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((ws) => ({ label: ws.displayName, description: ws.type, detail: ws.description, ws })),
    {
      title: 'Fabric: Select a Workspace',
      placeHolder: workspaces.length ? 'Workspace' : 'No workspaces found',
      matchOnDescription: true,
    },
  );
  return picked?.ws;
}

async function showNotebooks(items: Notebook[], workspaceName: string): Promise<void> {
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`No notebooks in "${workspaceName}".`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    items
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((nb) => ({ label: nb.displayName, description: nb.description, detail: nb.id, nb })),
    {
      title: `Fabric: Notebooks in ${workspaceName} (${items.length})`,
      placeHolder: 'Select a notebook to copy its ID',
      matchOnDescription: true,
      matchOnDetail: true,
    },
  );
  if (picked) {
    await vscode.env.clipboard.writeText(picked.nb.id);
    void vscode.window.showInformationMessage(`Copied ID of "${picked.nb.displayName}".`);
  }
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Fabric: ${title}` },
    task,
  );
}
