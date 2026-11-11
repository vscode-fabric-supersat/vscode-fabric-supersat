/** Deleting items of any kind from a workspace (in Fabric), with their history and sync state. */
import type * as vscode from 'vscode';
import type { FabricClient } from '../fabric/client';
import { recordHistory } from '../util/diagnostics';
import { getLogger } from '../util/logger';
import { forgetItemSync } from '../workspace/state';
import { type BulkOptions, type BulkResult, runBulk } from './bulk';
import { ITEM_KINDS, type ItemKind } from './kinds';

export interface DeleteItemsOptions extends BulkOptions {
  /** The project folder: given with `workspaceName`, each deleted item is forgotten in the sync state. */
  root?: vscode.Uri;
  /** The workspace's name: given, each deletion is recorded in the history. */
  workspaceName?: string;
  /** Runs after each item is deleted (e.g. removing it from the notebook cache); a failure is only logged. */
  afterDelete?: (name: string) => Promise<void>;
}

/**
 * Deletes items of one kind from the workspace, `options.concurrency` at a time; one failure
 * doesn't stop the rest. Local files aren't touched. With `workspaceName`, each deletion is
 * recorded in the history, and (with `root`) the item is forgotten in the workspace's sync
 * state, so "Upload Changed" uploads it again.
 */
export function deleteItems(
  client: FabricClient,
  workspaceId: string,
  kind: ItemKind,
  items: readonly { id: string; displayName: string }[],
  options: DeleteItemsOptions = {},
): Promise<BulkResult> {
  const { root, workspaceName, afterDelete } = options;
  // History lines name the item in `notebook` (the file's format); other kinds add their `kind`.
  const history = kind === 'notebook' ? {} : { kind };
  return runBulk(items, (i) => i.displayName, options, async (item) => {
    try {
      await client.deleteItem(workspaceId, kind, item.id);
    } catch (err) {
      if (workspaceName) {
        recordHistory({ action: 'delete', notebook: item.displayName, ...history, workspace: workspaceName, result: 'failed', error: message(err) });
      }
      throw err;
    }
    if (workspaceName) {
      recordHistory({ action: 'delete', notebook: item.displayName, ...history, workspace: workspaceName, result: 'deleted' });
      if (root) {
        await afterDelete?.(item.displayName).catch((err) =>
          getLogger().warn(`Deleted ${ITEM_KINDS[kind].label} "${item.displayName}", but couldn't finish tidying up after it`, err),
        );
        try {
          await forgetItemSync(root, workspaceName, kind, item.displayName);
        } catch (err) {
          // It is deleted; only "Upload Changed" may skip it as unchanged.
          getLogger().warn(`Deleted ${ITEM_KINDS[kind].label} "${item.displayName}", but couldn't update the sync state`, err);
        }
      }
    }
    return { kind: 'done' };
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
