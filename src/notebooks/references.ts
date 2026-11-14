/**
 * The lakehouses and environment a notebook refers to, and the workspace they are in.
 *
 * A notebook's header names its default lakehouse, other known lakehouses and its
 * environment by ID. The default lakehouse and the environment also name their workspace:
 * by ID, or as `SAME_WORKSPACE_ID` (all zeros), Fabric's way of saying "the notebook's own
 * workspace", which is what Fabric's Git integration writes.
 *
 * - On upload (`ReferenceMapper`), each reference is pointed at the target workspace's item
 *   of the same name (and type), as Microsoft's fabric-cicd does, so the same files deploy
 *   to Dev, Test and Prod. Each kind of reference can be set to keep its IDs instead.
 * - On download (`toSameWorkspace`), workspace IDs that are the notebook's own workspace
 *   can be saved as "same workspace", so the files don't name any one workspace.
 *
 * Only the header metadata changes; code cells are left alone. No `vscode` dependency, so
 * it can be unit-tested offline.
 */
import { formatFabricPy, type JsonObject, parseFabricPy } from './format';

/** Fabric item types a notebook refers to. */
export type ReferencedItemType = 'Lakehouse' | 'Environment';

/** The references a notebook has, each with its own settings. */
export type ReferenceKind = 'defaultLakehouse' | 'otherLakehouses' | 'environment';

/** The references whose workspace the notebook's header names (other lakehouses have no workspace field). */
export type WorkspaceReferenceKind = Exclude<ReferenceKind, 'otherLakehouses'>;

export interface ReferenceSettings {
  /** On upload: `replace` points the reference at the target workspace's item; `keep` leaves it. */
  upload: Record<ReferenceKind, 'replace' | 'keep'>;
  /** Write the workspace as "same workspace" (all zeros) where it is the notebook's own. */
  sameWorkspace: Record<WorkspaceReferenceKind, boolean>;
}

export const DEFAULT_REFERENCE_SETTINGS: ReferenceSettings = {
  upload: { defaultLakehouse: 'replace', otherLakehouses: 'replace', environment: 'replace' },
  sameWorkspace: { defaultLakehouse: false, environment: false },
};

export interface NamedItem {
  id: string;
  displayName: string;
}

/** Lists the items of one type in a workspace. */
export type ListItems = (workspaceId: string, type: ReferencedItemType) => Promise<NamedItem[]>;

/** Fabric's workspace ID for "the notebook's own workspace" (as in Git-committed notebooks). */
export const SAME_WORKSPACE_ID = '00000000-0000-0000-0000-000000000000';

export interface Retargeted {
  /** The `.py` with the references changed: the input itself when nothing changed. */
  py: string;
  /** IDs changed, for the log. */
  replaced: string[];
  /** References kept that may not work in the target workspace: warned about. */
  kept: string[];
  /** "Same workspace" references kept, logged without a warning. */
  notes: string[];
}

interface Progress extends Retargeted {
  changed: boolean;
}

interface Reference {
  type: ReferencedItemType;
  id: string;
  /** The item's workspace: an ID, `SAME_WORKSPACE_ID`, or `undefined` if not given. */
  workspaceId?: string;
  /** The item's name, when the notebook stores it (only the default lakehouse). */
  name?: string;
}

/**
 * Points references at one target workspace's items. Workspace listings are cached, so
 * create one per upload command and use it for every notebook in it.
 */
export class ReferenceMapper {
  private readonly cache = new Map<string, Promise<NamedItem[] | undefined>>();
  /** Every reference warned about by `retarget` so far. */
  readonly kept: string[] = [];

  constructor(
    private readonly list: ListItems,
    readonly targetWorkspaceId: string,
    private readonly settings: ReferenceSettings = DEFAULT_REFERENCE_SETTINGS,
  ) {}

  /** The `.py` with its references pointed at the target workspace, as the settings say. */
  async retarget(py: string): Promise<Retargeted> {
    const notebook = parseFabricPy(py);
    const dependencies = asObject(notebook.meta?.dependencies);
    const result: Progress = { py, replaced: [], kept: [], notes: [], changed: false };
    const lakehouse = asObject(dependencies?.lakehouse);
    if (lakehouse) {
      await this.retargetLakehouses(lakehouse, result);
    }
    const environment = asObject(dependencies?.environment);
    if (environment && this.settings.upload.environment === 'replace') {
      await this.retargetEnvironment(environment, result);
    }
    this.kept.push(...result.kept);
    return {
      py: result.changed ? formatFabricPy(notebook) : py,
      replaced: result.replaced,
      kept: result.kept,
      notes: result.notes,
    };
  }

  private async retargetLakehouses(lakehouse: JsonObject, result: Progress): Promise<void> {
    const { upload } = this.settings;
    // Other lakehouses have no workspace field: they are taken to be in the default lakehouse's.
    const workspaceId = str(lakehouse.default_lakehouse_workspace_id);
    /** Lakehouse IDs already handled: the ID to use instead, or `undefined` to keep it. */
    const handled = new Map<string, string | undefined>();

    const defaultId = str(lakehouse.default_lakehouse);
    if (defaultId && upload.defaultLakehouse === 'replace') {
      const name = str(lakehouse.default_lakehouse_name);
      const found = await this.resolve({ type: 'Lakehouse', id: defaultId, workspaceId, name }, result);
      handled.set(defaultId.toLowerCase(), found && !sameId(found.id, defaultId) ? found.id : undefined);
      if (found) {
        if (!sameId(found.id, defaultId)) {
          lakehouse.default_lakehouse = found.id;
          if (name !== undefined) {
            lakehouse.default_lakehouse_name = found.displayName;
          }
        }
        this.setWorkspaceId(lakehouse, 'default_lakehouse_workspace_id', 'defaultLakehouse', result);
      }
    }

    if (!Array.isArray(lakehouse.known_lakehouses)) {
      return;
    }
    // The default lakehouse's own entry follows it; the others follow their own setting.
    for (const entry of lakehouse.known_lakehouses) {
      const item = asObject(entry);
      const id = str(item?.id);
      if (!item || !id) {
        continue;
      }
      const key = id.toLowerCase();
      if (!handled.has(key)) {
        if (upload.otherLakehouses !== 'replace') {
          continue;
        }
        const found = await this.resolve({ type: 'Lakehouse', id, workspaceId }, result);
        handled.set(key, found && !sameId(found.id, id) ? found.id : undefined);
      }
      const swapped = handled.get(key);
      if (swapped) {
        item.id = swapped;
      }
    }
  }

  private async retargetEnvironment(environment: JsonObject, result: Progress): Promise<void> {
    const id = str(environment.environmentId);
    if (!id) {
      return;
    }
    const found = await this.resolve({ type: 'Environment', id, workspaceId: str(environment.workspaceId) }, result);
    if (found) {
      if (!sameId(found.id, id)) {
        environment.environmentId = found.id;
      }
      this.setWorkspaceId(environment, 'workspaceId', 'environment', result);
    }
  }

  /**
   * The target workspace's item for `ref` (`ref`'s own item, if it is already there), or
   * `undefined` if there is none, recorded in `result.kept`, or in `result.notes` for a
   * "same workspace" reference, which isn't warned about.
   */
  private async resolve(ref: Reference, result: Progress): Promise<NamedItem | undefined> {
    const label = ref.type.toLowerCase();
    const sameWorkspace = !!ref.workspaceId && sameId(ref.workspaceId, SAME_WORKSPACE_ID);
    const keep = (message: string) => {
      (sameWorkspace ? result.notes : result.kept).push(message);
      return undefined;
    };

    const target = await this.items(this.targetWorkspaceId, ref.type);
    if (!target) {
      return keep(`Kept ${label} ${ref.id}: couldn't list the target workspace's ${label}s.`);
    }
    const own = target.find((i) => sameId(i.id, ref.id));
    if (own) {
      return own;
    }
    const source = ref.workspaceId && !sameWorkspace ? ref.workspaceId : undefined;
    let name = ref.name;
    if (!name && source && !sameId(source, this.targetWorkspaceId)) {
      name = (await this.items(source, ref.type))?.find((i) => sameId(i.id, ref.id))?.displayName;
    }
    const where = source ? `workspace ${source}` : "the notebook's own workspace";
    if (!name) {
      return keep(`Kept ${label} ${ref.id} (in ${where}): it isn't in the target workspace, and its name is unknown.`);
    }
    const match = findNamed(target, name);
    if (!match) {
      return keep(`Kept ${label} "${name}" (in ${where}): the target workspace has no ${label} with that name.`);
    }
    result.replaced.push(`${ref.type} "${match.displayName}": ${ref.id} → ${match.id}`);
    result.changed = true;
    return match;
  }

  /**
   * Points a reference's workspace at the target: "same workspace" when it already says so
   * (which always wins) or the setting asks for it, otherwise the target's ID.
   */
  private setWorkspaceId(owner: JsonObject, key: string, kind: WorkspaceReferenceKind, result: Progress): void {
    const value = str(owner[key]);
    if (!value) {
      return;
    }
    const next =
      sameId(value, SAME_WORKSPACE_ID) || this.settings.sameWorkspace[kind] ? SAME_WORKSPACE_ID : this.targetWorkspaceId;
    if (!sameId(value, next)) {
      owner[key] = next;
      result.changed = true;
    }
  }

  /** A workspace's items of one type, or `undefined` if they can't be listed (e.g. no access). */
  private items(workspaceId: string, type: ReferencedItemType): Promise<NamedItem[] | undefined> {
    const key = `${workspaceId.toLowerCase()}/${type}`;
    let items = this.cache.get(key);
    if (!items) {
      items = this.list(workspaceId, type).catch(() => undefined);
      this.cache.set(key, items);
    }
    return items;
  }
}

/**
 * The `.py` with each reference whose workspace is `workspaceId` (the notebook's own, e.g.
 * the one it was downloaded from) written as "same workspace", for the kinds `which` turns
 * on. Returns the input itself when nothing changes.
 */
export function toSameWorkspace(
  py: string,
  workspaceId: string,
  which: Record<WorkspaceReferenceKind, boolean>,
): string {
  if (!which.defaultLakehouse && !which.environment) {
    return py;
  }
  const notebook = parseFabricPy(py);
  const dependencies = asObject(notebook.meta?.dependencies);
  let changed = false;
  const convert = (owner: JsonObject | undefined, key: string) => {
    const value = str(owner?.[key]);
    if (owner && value && sameId(value, workspaceId)) {
      owner[key] = SAME_WORKSPACE_ID;
      changed = true;
    }
  };
  if (which.defaultLakehouse) {
    convert(asObject(dependencies?.lakehouse), 'default_lakehouse_workspace_id');
  }
  if (which.environment) {
    convert(asObject(dependencies?.environment), 'workspaceId');
  }
  return changed ? formatFabricPy(notebook) : py;
}

/** Fabric names are unique per workspace and type ignoring case; prefer an exact match anyway. */
function findNamed(items: readonly NamedItem[], name: string): NamedItem | undefined {
  return items.find((i) => i.displayName === name) ?? items.find((i) => i.displayName.toLowerCase() === name.toLowerCase());
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
