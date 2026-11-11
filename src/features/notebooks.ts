import * as vscode from 'vscode';
import { Commands } from '../constants';
import type { Notebook } from '../fabric/client';
import { reportError } from '../util/errors';
import { getLogger } from '../util/logger';
import { withProgress } from '../util/progress';
import type { Feature } from './feature';

/**
 * "List Notebooks": browse the notebooks in the current workspace (asking for one if none
 * is saved). Choosing a notebook copies its ID. Pass a workspace ID as the argument to
 * use that workspace instead.
 */
export const notebooks: Feature = {
  name: 'notebooks',
  activate(context, { fabric, workspace: current }) {
    context.subscriptions.push(
      vscode.commands.registerCommand(Commands.listNotebooks, async (workspaceId?: string) => {
        try {
          const workspace = workspaceId ? { id: workspaceId, name: workspaceId } : await current.resolve();
          if (!workspace) {
            return undefined;
          }
          const items = await withProgress('Loading notebooks…', () => fabric.listNotebooks(workspace.id));
          getLogger().info(`Workspace ${workspace.name} (${workspace.id}): ${items.length} notebook(s)`);
          await showNotebooks(items, workspace.name);
          return items;
        } catch (err) {
          await reportError('List notebooks', err);
          return undefined;
        }
      }),
    );
  },
};

async function showNotebooks(items: Notebook[], workspaceName: string): Promise<void> {
  if (items.length === 0) {
    void vscode.window.showInformationMessage(`No notebooks in "${workspaceName}".`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    items
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((nb) => ({ label: nb.displayName, description: nb.description, nb })),
    {
      title: `Fabric: Notebooks in ${workspaceName} (${items.length})`,
      placeHolder: 'Select a notebook to copy its ID',
      matchOnDescription: true,
    },
  );
  if (picked) {
    await vscode.env.clipboard.writeText(picked.nb.id);
    void vscode.window.showInformationMessage(`Copied ID of "${picked.nb.displayName}".`);
  }
}
