/**
 * Everything this extension knows about Microsoft's Fabric Data Engineering extension (FDE,
 * `SynapseVSCode.synapse`) and the layout of its local work folder. No `vscode` dependency.
 *
 * FDE has no public API for this. The layout below is the work folder's file structure as
 * the FDE versions in `FDE_CHECKED_VERSIONS` create it, and can change in any FDE release; the layout
 * version in `.work-folder-info` (`FDE_WORK_FOLDER_VERSION`) is expected to change with it.
 * Keep every FDE detail in this file, so a change in FDE means a change here only.
 *
 * Layout of the work folder (`synapse.localWorkFolderPath`):
 *
 * ```
 * <work folder>/
 *   .work-folder-info                         {"version":1}
 *   <workspace ID>/
 *     .workspace-info                         the workspace, as FDE's tree lists it
 *     SynapseNotebook/
 *       <notebook item ID>/
 *         .artifact-info                      the notebook item: IDs, name, type, date, content hash
 *         .resource-info                      the notebook's resource files ([] for none)
 *         conf/lighter-config.json            FDE's own connection settings (not written here)
 *         <display name>/<display name>.ipynb the notebook
 * ```
 *
 * Each notebook's `.artifact-info`, two folders above its `.ipynb`, holds its workspace,
 * capacity and item IDs. IDs are written in lowercase, as FDE writes them.
 */

/** FDE's extension ID. */
export const FDE_EXTENSION_ID = 'SynapseVSCode.synapse';

/** FDE versions whose work folder layout this file follows (the Marketplace release and its pre-release). */
export const FDE_CHECKED_VERSIONS: readonly string[] = ['1.28.0', '1.28.1'];

/** FDE's setting for its work folder. Machine scope: one folder for every project on the machine. */
export const FDE_WORK_FOLDER_SETTING = 'synapse.localWorkFolderPath';

/** The layout version FDE writes in `.work-folder-info`. */
export const FDE_WORK_FOLDER_VERSION = 1;

/** This extension's FDE work folder, inside its local state folder (`.fabric-supersat/`). */
export const FDE_FOLDER_NAME = 'fabric-de';

const WORK_FOLDER_INFO = '.work-folder-info';
const WORKSPACE_INFO = '.workspace-info';
const ARTIFACT_INFO = '.artifact-info';
const RESOURCE_INFO = '.resource-info';
const NOTEBOOK_TYPE = 'SynapseNotebook';

/** A notebook item in Fabric, as the FDE layout needs it. */
export interface FdeNotebook {
  readonly workspaceId: string;
  readonly capacityId: string;
  readonly itemId: string;
  /** Fabric's name for the notebook (FDE names its folder and file after it). */
  readonly displayName: string;
}

/** A Fabric workspace, as the FDE layout needs it. */
export interface FdeWorkspace {
  readonly id: string;
  readonly name: string;
  readonly capacityId: string;
  /** "My workspace" (Fabric type `Personal`). */
  readonly personal: boolean;
}

/** A file to write, by its path segments below the work folder. */
export interface FdeFile {
  readonly path: readonly string[];
  readonly text: string;
  /** Leave the file alone if it exists (e.g. a fuller one FDE wrote itself). */
  readonly keepExisting?: true;
}

/** What `.artifact-info` records about the copy. */
export interface FdeCopyInfo {
  /**
   * When the copy was made, as an ISO 8601 date. FDE's tree compares it with the notebook's
   * last change in Fabric, and shows the notebook as needing an update if Fabric's is later.
   */
  readonly lastUpdatedDate: string;
  /**
   * SHA-256 (hex) of the exact `.ipynb` text written, when the notebook is known to be the
   * same as in Fabric. FDE shows a notebook as modified when its file's hash differs from
   * this, so leave it out for a notebook that differs from Fabric (or isn't known to be the
   * same): FDE then shows it as modified from the start.
   */
  readonly contentHash?: string;
}

/** `_remoteContentHash` for a copy that differs from Fabric: never a SHA-256, so FDE always shows it as modified. */
export const DIFFERS_FROM_FABRIC = 'differs-from-fabric';

/** `.work-folder-info`, which marks a folder as an FDE work folder of the current layout. */
export function workFolderInfoFile(): FdeFile {
  return { path: [WORK_FOLDER_INFO], text: JSON.stringify({ version: FDE_WORK_FOLDER_VERSION }) };
}

/**
 * `<workspace ID>/.workspace-info`, which describes the workspace a folder is for: `type` is
 * `Folder` for a workspace and `User` for "My workspace". Kept if it exists, since FDE writes
 * a fuller one (with the capacity's SKU) when it adds the workspace itself.
 */
export function workspaceInfoFile(workspace: FdeWorkspace): FdeFile {
  const id = workspace.id.toLowerCase();
  return {
    path: [id, WORKSPACE_INFO],
    text: JSON.stringify({
      id,
      name: workspace.name,
      type: workspace.personal ? 'User' : 'Folder',
      capacityObjectId: workspace.capacityId.toLowerCase(),
    }),
    keepExisting: true,
  };
}

/**
 * `.artifact-info` for a notebook: its IDs in Fabric, name and type, when it was copied and
 * its content hash. FDE also keeps an `etag` here, which only its own publish uses; it isn't
 * written, since notebooks are uploaded with Fabric Supersat.
 */
export function artifactInfoFile(notebook: FdeNotebook, copy: FdeCopyInfo): FdeFile {
  return {
    path: [...notebookFolder(notebook), ARTIFACT_INFO],
    text: JSON.stringify({
      objectId: notebook.itemId.toLowerCase(),
      artifactType: NOTEBOOK_TYPE,
      displayName: notebook.displayName,
      folderObjectId: notebook.workspaceId.toLowerCase(),
      capacityObjectId: notebook.capacityId.toLowerCase(),
      lastUpdatedDate: copy.lastUpdatedDate,
      _remoteContentHash: copy.contentHash ?? DIFFERS_FROM_FABRIC,
    }),
  };
}

/** `.resource-info`: the notebook's resource files, none (Fabric Supersat doesn't support them). */
export function resourceInfoFile(notebook: FdeNotebook): FdeFile {
  return { path: [...notebookFolder(notebook), RESOURCE_INFO], text: '[]' };
}

/** The notebook's `.ipynb` in the work folder. */
export function notebookFile(notebook: FdeNotebook, ipynbText: string): FdeFile {
  return { path: notebookIpynbPath(notebook), text: ipynbText };
}

/** Path segments, below the work folder, of the notebook's `.ipynb`. */
export function notebookIpynbPath(notebook: FdeNotebook): string[] {
  return [...notebookFolder(notebook), notebook.displayName, `${notebook.displayName}.ipynb`];
}

/** Every file to write so FDE sees the notebook: the workspace's info and the notebook's. */
export function notebookFiles(workspace: FdeWorkspace, notebook: FdeNotebook, ipynbText: string, copy: FdeCopyInfo): FdeFile[] {
  return [
    workspaceInfoFile(workspace),
    artifactInfoFile(notebook, copy),
    resourceInfoFile(notebook),
    notebookFile(notebook, ipynbText),
  ];
}

function notebookFolder(notebook: Pick<FdeNotebook, 'workspaceId' | 'itemId'>): string[] {
  return [notebook.workspaceId.toLowerCase(), NOTEBOOK_TYPE, notebook.itemId.toLowerCase()];
}

/** Whether a work folder path is one this extension set (any project's `.fabric-supersat/fabric-de`). */
export function isOwnWorkFolder(path: string | undefined): boolean {
  return !!path && /[\\/]\.fabric-supersat[\\/]fabric-de[\\/]?$/.test(path);
}

/** The folder, below the work folder, that holds a workspace's notebooks: `<workspace ID>/SynapseNotebook`. */
export function notebooksFolder(workspaceId: string): string[] {
  return [workspaceId.toLowerCase(), NOTEBOOK_TYPE];
}

/** The folder, below the work folder, that holds everything of one notebook copy: `<workspace ID>/SynapseNotebook/<item ID>`. */
export function notebookItemFolder(notebook: Pick<FdeNotebook, 'workspaceId' | 'itemId'>): string[] {
  return notebookFolder(notebook);
}

/** The name of the info file that describes a workspace folder (`.workspace-info`) or a notebook item folder (`.artifact-info`). */
export const INFO_FILES = { workspace: WORKSPACE_INFO, artifact: ARTIFACT_INFO } as const;

/** A notebook's `.ipynb` path below the work folder, read back: `<workspace ID>/SynapseNotebook/<item ID>/<name>/<name>.ipynb`. */
export interface CopyPath {
  readonly workspaceId: string;
  readonly itemId: string;
  /** The notebook's name, as its folder and file are named. */
  readonly displayName: string;
}

/** Reads a notebook's `.ipynb` path (segments below the work folder), or `undefined` if it isn't one. */
export function parseCopyPath(segments: readonly string[]): CopyPath | undefined {
  if (segments.length !== 5) {
    return undefined;
  }
  const [workspaceId, type, itemId, folder, file] = segments;
  if (type !== NOTEBOOK_TYPE || !workspaceId || !itemId || !folder || file !== `${folder}.ipynb`) {
    return undefined;
  }
  return { workspaceId, itemId, displayName: folder };
}

/** What `.workspace-info` says about a workspace folder (FDE's own, fuller file included). */
export interface WorkspaceInfo {
  readonly id?: string;
  readonly name?: string;
  readonly capacityId?: string;
  readonly personal: boolean;
}

/** Reads `.workspace-info`; `undefined` if it isn't JSON. */
export function readWorkspaceInfo(text: string): WorkspaceInfo | undefined {
  const json = parseObject(text);
  return json && {
    id: str(json.id),
    name: str(json.name),
    capacityId: str(json.capacityObjectId),
    personal: json.type === 'User',
  };
}

/** What `.artifact-info` says about a notebook item folder. */
export interface ArtifactInfo {
  readonly itemId?: string;
  readonly displayName?: string;
  readonly capacityId?: string;
}

/** Reads `.artifact-info`; `undefined` if it isn't JSON. */
export function readArtifactInfo(text: string): ArtifactInfo | undefined {
  const json = parseObject(text);
  return json && { itemId: str(json.objectId), displayName: str(json.displayName), capacityId: str(json.capacityObjectId) };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
