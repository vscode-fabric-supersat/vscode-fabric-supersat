/**
 * "Sync Workspace": what bringing the selected workspace and `src/Notebooks` into line takes,
 * in either direction, from how each notebook compares (see `compareWithLocal` in `metadata.ts`).
 *
 * No `vscode` dependency, so it can be unit-tested offline.
 */
import { type CompareStatus, ONLY_LOCAL, type PropertyDifference } from './metadata';

/** Which side is made to match the other. */
export type SyncDirection = 'toWorkspace' | 'toLocal';

/**
 * What syncing does to one notebook, on the side being changed:
 * - `overwrite`: replace it with the other side's version (upload, or download).
 * - `create`: it's only on the other side, so create it here.
 * - `properties`: its content is the same, but its description or folder differs (see `compareProperties`):
 *   upload sets Fabric's to `notebook.yaml`'s, download writes Fabric's into `notebook.yaml`.
 * - `delete`: it's only on the side being changed, so delete it there.
 */
export type SyncAction = 'overwrite' | 'create' | 'properties' | 'delete';

/** How one notebook compares, for planning a sync. */
export interface NotebookComparison {
  name: string;
  status: CompareStatus;
  /** How its description and folder differ from `notebook.yaml`'s (see `compareProperties`). */
  properties?: readonly PropertyDifference[];
  /** Why it couldn't be fetched, or isn't supported (for `Not Fetched` and `Not Supported`). */
  reason?: string;
}

export interface PlannedSyncChange {
  name: string;
  status: CompareStatus;
  action: SyncAction;
  /** The property differences this change brings into line (those that apply in its direction). */
  properties?: PropertyDifference[];
}

export interface SyncPlan {
  direction: SyncDirection;
  /** What would change, in the order of `SYNC_ACTION_ORDER`, then by name. */
  changes: PlannedSyncChange[];
  /** The same on both sides (description and folder included, as far as the direction can change them): nothing to do. */
  same: string[];
  /** Left alone: not supported, or not fetched. */
  skipped: { name: string; reason: string }[];
  /** Notebooks whose description and folder couldn't be compared (e.g. a `notebook.yaml` with a YAML error). */
  propertyErrors?: { name: string; reason: string }[];
}

/** The order changes are listed in. */
export const SYNC_ACTION_ORDER: readonly SyncAction[] = ['overwrite', 'create', 'properties', 'delete'];

/** Each action as the user sees it, by direction. */
export const SYNC_ACTION_LABELS: Readonly<Record<SyncDirection, Readonly<Record<SyncAction, string>>>> = {
  toWorkspace: {
    overwrite: 'Overwrite in Fabric',
    create: 'Create in Fabric',
    properties: 'Update description/folder in Fabric',
    delete: 'Delete in Fabric',
  },
  toLocal: {
    overwrite: 'Replace local files',
    create: 'Download',
    properties: 'Update notebook.yaml',
    delete: 'Delete local files',
  },
};

/**
 * Plans a sync: which notebooks change, and how, so that the side `direction` points at ends
 * up matching the other. A notebook whose content is the same changes only for property
 * differences the direction can bring into line: uploading can't change a property
 * `notebook.yaml` doesn't set (`downloadOnly`). Notebooks that aren't supported or couldn't
 * be fetched are left alone on both sides (a local notebook whose Fabric version wasn't
 * fetched is never treated as local-only).
 */
export function planSync(direction: SyncDirection, comparisons: readonly NotebookComparison[]): SyncPlan {
  const plan: SyncPlan = { direction, changes: [], same: [], skipped: [] };
  for (const c of comparisons) {
    const properties = (c.properties ?? []).filter((p) => direction === 'toLocal' || !p.downloadOnly);
    const action = syncAction(direction, c.status, properties.length > 0);
    if (action) {
      plan.changes.push({ name: c.name, status: c.status, action, ...(properties.length ? { properties } : {}) });
    } else if (c.status === 'Same') {
      plan.same.push(c.name);
    } else {
      plan.skipped.push({ name: c.name, reason: skipReason(c) });
    }
  }
  plan.changes.sort((a, b) => SYNC_ACTION_ORDER.indexOf(a.action) - SYNC_ACTION_ORDER.indexOf(b.action) || a.name.localeCompare(b.name));
  plan.same.sort((a, b) => a.localeCompare(b));
  plan.skipped.sort((a, b) => a.name.localeCompare(b.name));
  return plan;
}

function syncAction(direction: SyncDirection, status: CompareStatus, propertiesDiffer: boolean): SyncAction | undefined {
  switch (status) {
    case 'Different':
      return 'overwrite';
    case 'Same':
      return propertiesDiffer ? 'properties' : undefined;
    case 'Only in Fabric':
      return direction === 'toLocal' ? 'create' : 'delete';
    case ONLY_LOCAL:
      return direction === 'toWorkspace' ? 'create' : 'delete';
    default:
      return undefined;
  }
}

function skipReason({ status, reason }: NotebookComparison): string {
  if (status === 'Not Supported') {
    return `not supported${reason ? `: ${reason}` : ''}`;
  }
  return `couldn't be fetched from Fabric${reason ? `: ${reason}` : ''}`;
}
