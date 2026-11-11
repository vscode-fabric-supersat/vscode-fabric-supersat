/**
 * The kinds of Fabric item this extension keeps as files, and what differs between them:
 * Fabric's item type, its REST API path, the folder under `src/`, and its key in each
 * workspace's sync state. No `vscode` dependency.
 *
 * Every kind is identified by name (no Fabric ID is stored), lives in `src/<Folder>/<Name>/`
 * with its properties in `<Name>.yaml`, and shares the sync state, comparison and Sync
 * Workspace planning code; what its content is, and how it's converted, is the kind's own.
 */

export type ItemKind = 'notebook' | 'environment';

export interface ItemKindInfo {
  readonly kind: ItemKind;
  /** Fabric's item type, as item lists report it. */
  readonly fabricType: 'Notebook' | 'Environment';
  /** The kind in a sentence, e.g. "notebook". */
  readonly label: string;
  /** The plural, e.g. "notebooks". */
  readonly plural: string;
  /** The Fabric REST API's path segment for items of this kind, below a workspace. */
  readonly apiPath: 'notebooks' | 'environments';
  /** The folder under `src/` that holds one folder per item. */
  readonly sourceDir: 'Notebooks' | 'Environments';
  /** The item kind's key in `sync-state.json`. */
  readonly stateKey: 'notebooks' | 'environments';
}

export const ITEM_KINDS: Readonly<Record<ItemKind, ItemKindInfo>> = {
  notebook: {
    kind: 'notebook',
    fabricType: 'Notebook',
    label: 'notebook',
    plural: 'notebooks',
    apiPath: 'notebooks',
    sourceDir: 'Notebooks',
    stateKey: 'notebooks',
  },
  environment: {
    kind: 'environment',
    fabricType: 'Environment',
    label: 'environment',
    plural: 'environments',
    apiPath: 'environments',
    sourceDir: 'Environments',
    stateKey: 'environments',
  },
};
