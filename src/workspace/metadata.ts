/**
 * "Refresh Workspace Information": everything the extension can read about a Fabric
 * workspace, saved as `<Workspace Name>.json` (data, for copying and comparing) and
 * `<Workspace Name>.md` (the same, easy to read) in `.fabric-supersat/workspaces/<Workspace Name>/`
 * (a name that can't be a file name is encoded, see `workspaceFolderName`).
 *
 * Each section is fetched separately; one Fabric refuses (e.g. member roles without a
 * role that can see them) is listed under "Not available" instead of failing the rest.
 * The files are outputs only: no command acts on an ID read from them.
 *
 * No `vscode` dependency (local files come in through `LocalNotebooks`), so it can be
 * unit-tested offline.
 */
import type { FabricClient, Item, JsonRecord, Notebook } from '../fabric/client';
import { mapLimit } from '../util/concurrency';
import type { WorkspaceReferenceKind } from '../notebooks/references';
import { toCurrentWorkspace } from '../notebooks/references';
import { addFolderPaths, type FabricProperties, fetchNotebookSources, isOwnWorkspace, type RemoteNotebook, summarizeNotebook } from '../notebooks/remote';
import { fence, mdText } from '../util/markdown';
import { toLf } from '../util/text';
import { folderPathsOf, sameFolderPath } from '../notebooks/folders';

export const METADATA_FORMAT_VERSION = 1;

/** How a notebook in Fabric compares with its local `.py`. */
export type LocalStatus = 'Same' | 'Different' | 'Only in Fabric' | 'Not Supported' | 'Not Fetched';
/** A local notebook with no notebook of the same name in the workspace. */
export const ONLY_LOCAL = 'Only Local';
/** How a notebook compares, local-only notebooks included. */
export type CompareStatus = LocalStatus | typeof ONLY_LOCAL;

export interface NotebookMetadata {
  id: string;
  name: string;
  folder?: string;
  description?: string;
  language?: string;
  kernel?: string;
  cells?: number;
  defaultLakehouse?: { id: string; name?: string; workspace: string };
  otherLakehouses?: { id: string; name?: string }[];
  environment?: { id: string; name?: string; workspace: string };
  warehouses?: { id: string; name?: string; type?: string }[];
  local?: LocalStatus;
  error?: string;
}

export interface WorkspaceMetadata {
  format: number;
  capturedAt: string;
  account?: string;
  workspace: { id: string; name: string } & JsonRecord;
  summary: {
    itemTypes: { type: string; count: number }[];
    notebookLanguages?: { language: string; count: number }[];
    /** Notebooks whose details weren't fetched because the download was cancelled. */
    notebooksCancelled?: number;
    local?: Record<CompareStatus, number>;
  };
  folders: { id: string; name: string; path: string }[];
  items: { id: string; name: string; type: string; description?: string; folder?: string }[];
  lakehouses: ({ id: string; name: string } & JsonRecord)[];
  warehouses: ({ id: string; name: string } & JsonRecord)[];
  environments: ({ id: string; name: string } & JsonRecord)[];
  notebooks: NotebookMetadata[];
  /** Local notebooks with no notebook of the same name in the workspace. */
  onlyLocal?: string[];
  git?: JsonRecord;
  spark?: JsonRecord;
  roles?: { principal: string; type?: string; email?: string; role?: string }[];
  unavailable: { section: string; reason: string }[];
}

/** The project's local notebooks, for comparing with the workspace. */
export interface LocalNotebooks {
  names: readonly string[];
  /** A local notebook's `.py` text, or `undefined` if it has none. */
  readPy(name: string): Promise<string | undefined>;
  /** A local notebook's properties from its `notebook.yaml`; throws if the file is invalid. Without it, properties aren't compared. */
  readProperties?(name: string): Promise<LocalProperties>;
}

/** A notebook's properties as its `notebook.yaml` sets them: `undefined` where it doesn't (upload then leaves Fabric's as it is). */
export interface LocalProperties {
  description?: string;
  folder?: string;
}

/** A property (description or folder) that differs between Fabric and `notebook.yaml`. */
export interface PropertyDifference {
  property: 'description' | 'folder';
  /** `notebook.yaml`'s value; `undefined` if it doesn't set it. */
  local?: string;
  fabric: string;
  /**
   * `notebook.yaml` doesn't set it, so only downloading changes anything (it writes Fabric's
   * value); uploading leaves Fabric's as it is.
   */
  downloadOnly: boolean;
}

/** How a notebook's properties compare: the differences, or why they couldn't be compared. */
export interface PropertyComparison {
  differences: PropertyDifference[];
  /** `notebook.yaml` couldn't be read (e.g. a YAML error). */
  error?: string;
}

export interface CollectOptions {
  /** Fetch each notebook's content: language, references, and comparison with `local`. */
  notebookDetails: boolean;
  memberRoles: boolean;
  concurrency: number;
  account?: string;
  local?: LocalNotebooks;
  /** The `notebooks.currentWorkspace` settings, so the comparison matches what download would write. */
  currentWorkspace?: Record<WorkspaceReferenceKind, boolean>;
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
}

/** What "Refresh Workspace Information" collected. */
export interface CollectedWorkspace {
  metadata: WorkspaceMetadata;
  /**
   * Every notebook in the workspace as fetched (with `notebookDetails`; cancelled ones
   * marked), or `undefined` if not fetched or the item list wasn't available, so it may
   * not be the whole workspace.
   */
  notebooks?: RemoteNotebook[];
}

export async function collectWorkspaceMetadata(
  client: FabricClient,
  workspace: { id: string; name: string },
  options: CollectOptions,
): Promise<CollectedWorkspace> {
  // Listed in the order sections are asked for, not the order they fail in (requests run at once).
  const failed: { order: number; section: string; reason: string }[] = [];
  let asked = 0;
  const attempt = async <T>(section: string, run: () => Promise<T>): Promise<T | undefined> => {
    const order = asked++;
    try {
      return await run();
    } catch (err) {
      failed.push({ order, section, reason: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  };
  const progress = options.onProgress ?? (() => undefined);

  progress('workspace and items');
  const [details, listedItems, folders = []] = await Promise.all([
    attempt('Workspace details', () => client.getWorkspace(workspace.id)),
    attempt('Items', () => client.listItems(workspace.id)),
    attempt('Folders', () => client.listFolders(workspace.id)),
  ]);
  const itemsListed = listedItems !== undefined;
  const items = listedItems ?? [];
  const folderPaths = folderPathsOf(folders);
  const itemsById = new Map(items.map((i) => [i.id.toLowerCase(), i]));
  const folderOf = (item: { folderId?: string }) => (item.folderId ? folderPaths.get(item.folderId) : undefined);

  // Everything else depends only on the items, so it is fetched at once; the client's limiter
  // decides how many requests actually run together.
  progress('lakehouses, warehouses, environments, settings and notebooks');
  const lakehouseItems = items.filter((i) => i.type === 'Lakehouse');
  const notebookItems = items.filter((i) => i.type === 'Notebook') as Item[];
  const [lakehouseResults, warehouseList, environmentResults, git, spark, roleAssignments, remote = []] = await Promise.all([
    mapLimit(lakehouseItems, options.concurrency, async (item) => {
      const [lakehouse, tables] = await Promise.all([
        attempt(`Lakehouse "${item.displayName}"`, () => client.getLakehouse(workspace.id, item.id)),
        client.listLakehouseTables(workspace.id, item.id).then(
          (value) => ({ value }),
          (err: unknown) => ({ unavailable: err instanceof Error ? err.message : String(err) }),
        ),
      ]);
      return {
        id: item.id,
        name: item.displayName,
        ...(lakehouse?.properties && typeof lakehouse.properties === 'object' ? (lakehouse.properties as JsonRecord) : {}),
        ...('value' in tables ? { tables: tables.value } : { tablesUnavailable: tables.unavailable }),
      };
    }),
    attempt('Warehouses', () => client.listWarehouses(workspace.id)),
    mapLimit(
      items.filter((i) => i.type === 'Environment'),
      options.concurrency,
      async (item) => {
        const environment = await attempt(`Environment "${item.displayName}"`, () => client.getEnvironment(workspace.id, item.id));
        return {
          id: item.id,
          name: item.displayName,
          ...(environment?.properties && typeof environment.properties === 'object' ? (environment.properties as JsonRecord) : {}),
        };
      },
    ),
    attempt('Git connection', () => client.getGitConnection(workspace.id)),
    attempt('Spark settings', () => client.getSparkSettings(workspace.id)),
    options.memberRoles ? attempt('Member roles', () => client.listRoleAssignments(workspace.id)) : undefined,
    options.notebookDetails && notebookItems.length
      ? fetchNotebookSources(client, workspace.id, notebookItems as unknown as Notebook[], {
          concurrency: options.concurrency,
          isCancelled: options.isCancelled,
          onProgress: (name, done, total) => progress(`notebook ${done}/${total} (${name})`),
        })
      : undefined,
  ]);
  const lakehouses = lakehouseResults.filter((l): l is NonNullable<typeof l> => !!l);
  const warehouses = (warehouseList ?? []).map((w) => ({
    id: String(w.id),
    name: String(w.displayName),
    ...(w.properties && typeof w.properties === 'object' ? (w.properties as JsonRecord) : {}),
  }));
  const environments = environmentResults.filter((e): e is NonNullable<typeof e> => !!e);
  // Folder paths for comparing properties: a notebook in a folder that wasn't listed has no known folder.
  await addFolderPaths(remote, async (folderId) => {
    const path = folderId ? folderPaths.get(folderId) : '';
    if (path === undefined) {
      throw new Error(`Folder ${folderId} not listed.`);
    }
    return path;
  });
  const remoteById = new Map(remote.map((r) => [r.notebook.id, r]));
  const nameOf = (id: string) => itemsById.get(id.toLowerCase())?.displayName;
  const workspaceLabel = (id?: string) => (isOwnWorkspace(id, workspace.id) ? 'this workspace' : id!);

  const notebooks: NotebookMetadata[] = [];
  for (const item of notebookItems) {
    const entry: NotebookMetadata = {
      id: item.id,
      name: item.displayName,
      folder: folderOf(item),
      description: item.description || undefined,
    };
    const source = remoteById.get(item.id);
    if (source?.error) {
      entry.error = source.error;
    }
    if (source?.language) {
      entry.language = source.language;
    }
    if (source?.gitPath && source.gitText !== undefined) {
      const summary = summarizeNotebook(source.gitPath, source.gitText);
      const own = (id?: string) => isOwnWorkspace(id, workspace.id);
      Object.assign(entry, {
        language: source.language ?? summary.language,
        kernel: summary.kernel,
        cells: summary.cells,
        defaultLakehouse: summary.defaultLakehouse && {
          id: summary.defaultLakehouse.id,
          name: summary.defaultLakehouse.name ?? (own(summary.defaultLakehouse.workspaceId) ? nameOf(summary.defaultLakehouse.id) : undefined),
          workspace: workspaceLabel(summary.defaultLakehouse.workspaceId),
        },
        otherLakehouses: summary.otherLakehouses.length ? summary.otherLakehouses.map((id) => ({ id, name: nameOf(id) })) : undefined,
        environment: summary.environment && {
          id: summary.environment.id,
          name: own(summary.environment.workspaceId) ? nameOf(summary.environment.id) : undefined,
          workspace: workspaceLabel(summary.environment.workspaceId),
        },
        warehouses: summary.warehouses.length ? summary.warehouses.map((w) => ({ ...w, name: nameOf(w.id) })) : undefined,
      });
    }
    if (options.notebookDetails && options.local) {
      entry.local = await compareWithLocal(source, options.local, workspace.id, options.currentWorkspace);
    }
    notebooks.push(entry);
  }
  notebooks.sort((a, b) => a.name.localeCompare(b.name));

  const fabricNames = new Set(notebookItems.map((n) => n.displayName.toLowerCase()));
  // Without the item list, every local notebook would look local-only.
  const onlyLocal = itemsListed
    ? options.local?.names.filter((n) => !fabricNames.has(n.toLowerCase())).sort((a, b) => a.localeCompare(b))
    : undefined;

  const metadata: WorkspaceMetadata = {
    format: METADATA_FORMAT_VERSION,
    capturedAt: new Date().toISOString(),
    ...(options.account ? { account: options.account } : {}),
    workspace: { ...(details ?? {}), id: workspace.id, name: workspace.name },
    summary: { itemTypes: countBy(items.map((i) => i.type)).map(([type, count]) => ({ type, count })) },
    folders: [...folders]
      .map((f) => ({ id: f.id, name: f.displayName, path: folderPaths.get(f.id) ?? f.displayName }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    items: items
      .map((i) => ({ id: i.id, name: i.displayName, type: i.type, description: i.description || undefined, folder: folderOf(i) }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
    lakehouses: lakehouses.sort((a, b) => a.name.localeCompare(b.name)),
    warehouses: warehouses.sort((a, b) => a.name.localeCompare(b.name)),
    environments: environments.sort((a, b) => a.name.localeCompare(b.name)),
    notebooks,
    ...(onlyLocal ? { onlyLocal } : {}),
    ...(git ? { git } : {}),
    ...(spark ? { spark } : {}),
    ...(roleAssignments ? { roles: roleAssignments.map(describeRole) } : {}),
    unavailable: failed.sort((a, b) => a.order - b.order).map(({ section, reason }) => ({ section, reason })),
  };
  const cancelled = remote.filter((r) => r.cancelled).length;
  if (cancelled) {
    metadata.summary.notebooksCancelled = cancelled;
  }
  if (options.notebookDetails) {
    metadata.summary.notebookLanguages = countBy(notebooks.map((n) => n.language ?? 'not fetched')).map(([language, count]) => ({
      language,
      count,
    }));
  }
  if (options.notebookDetails && options.local) {
    const local: Record<CompareStatus, number> = {
      Same: 0,
      Different: 0,
      'Only in Fabric': 0,
      'Not Supported': 0,
      'Not Fetched': 0,
      [ONLY_LOCAL]: onlyLocal?.length ?? 0,
    };
    for (const n of notebooks) {
      local[n.local ?? 'Not Fetched']++;
    }
    metadata.summary.local = local;
  }
  return { metadata, notebooks: options.notebookDetails && itemsListed ? remote : undefined };
}

/**
 * How a notebook in Fabric compares with its local `.py`: the same as what downloading it
 * would write (Fabric's `.py`, with the `currentWorkspace` settings applied), or not.
 */
export async function compareWithLocal(
  source: RemoteNotebook | undefined,
  local: LocalNotebooks,
  workspaceId: string,
  currentWorkspace?: Record<WorkspaceReferenceKind, boolean>,
): Promise<LocalStatus> {
  if (!source || source.error) {
    return 'Not Fetched';
  }
  if (source.unsupported || (source.gitPath && !source.gitPath.toLowerCase().endsWith('.py'))) {
    return 'Not Supported';
  }
  if (source.gitText === undefined) {
    return 'Not Fetched';
  }
  const name = local.names.find((n) => n.toLowerCase() === source.notebook.displayName.toLowerCase());
  const py = name === undefined ? undefined : await local.readPy(name);
  if (py === undefined) {
    return 'Only in Fabric';
  }
  // Line endings don't count: a local file may have CRLF (e.g. git on Windows).
  return toLf(expectedLocalPy(source.gitText, workspaceId, currentWorkspace)) === toLf(py) ? 'Same' : 'Different';
}

/**
 * How a notebook's description and folder in Fabric compare with its `notebook.yaml`, by the
 * rules upload and download follow: a value `notebook.yaml` sets differs if Fabric's isn't the
 * same (folders as paths, ignoring case); one it doesn't set differs only if downloading would
 * write it (a description, or a folder other than the workspace root), marked `downloadOnly`.
 * Properties not known (`fabric` undefined, or its folder undefined) aren't compared.
 */
export function compareProperties(fabric: FabricProperties | undefined, local: LocalProperties): PropertyDifference[] {
  if (!fabric) {
    return [];
  }
  const differences: PropertyDifference[] = [];
  if (local.description !== undefined ? local.description !== fabric.description : fabric.description !== '') {
    differences.push({ property: 'description', local: local.description, fabric: fabric.description, downloadOnly: local.description === undefined });
  }
  if (fabric.folder !== undefined && (local.folder !== undefined ? !sameFolderPath(local.folder, fabric.folder) : fabric.folder !== '')) {
    differences.push({ property: 'folder', local: local.folder, fabric: fabric.folder, downloadOnly: local.folder === undefined });
  }
  return differences;
}

/**
 * Compares the properties of a notebook that is in both places (see `compareProperties`).
 * Nothing to compare if it isn't local, wasn't fetched, or `local` can't read properties.
 */
export async function comparePropertiesWithLocal(source: RemoteNotebook | undefined, local: LocalNotebooks): Promise<PropertyComparison> {
  const name = source && local.names.find((n) => n.toLowerCase() === source.notebook.displayName.toLowerCase());
  if (!source?.properties || name === undefined || !local.readProperties) {
    return { differences: [] };
  }
  try {
    return { differences: compareProperties(source.properties, await local.readProperties(name)) };
  } catch (err) {
    return { differences: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Property differences for a message or list: e.g. `description and folder differ`. */
export function describePropertyDifferences({ differences, error }: PropertyComparison): string {
  if (error) {
    return 'notebook.yaml can\'t be read';
  }
  const names = differences.map((d) => d.property);
  return names.length ? `${names.join(' and ')} differ${names.length === 1 ? 's' : ''}` : '';
}

/** The `.py` downloading would write for Fabric's `gitText` (see `toCurrentWorkspace`). */
export function expectedLocalPy(
  gitText: string,
  workspaceId: string,
  currentWorkspace?: Record<WorkspaceReferenceKind, boolean>,
): string {
  try {
    return currentWorkspace ? toCurrentWorkspace(gitText, workspaceId, currentWorkspace) : gitText;
  } catch {
    return gitText;
  }
}

function describeRole(r: JsonRecord): NonNullable<WorkspaceMetadata['roles']>[number] {
  const principal = (r.principal && typeof r.principal === 'object' ? r.principal : {}) as JsonRecord;
  const user = (principal.userDetails && typeof principal.userDetails === 'object' ? principal.userDetails : {}) as JsonRecord;
  return {
    principal: String(principal.displayName ?? principal.id ?? r.id ?? 'unknown'),
    type: typeof principal.type === 'string' ? principal.type : undefined,
    email: typeof user.userPrincipalName === 'string' ? user.userPrincipalName : undefined,
    role: typeof r.role === 'string' ? r.role : undefined,
  };
}

function countBy(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  values.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------------------
// metadata.md

/** The metadata as an easy-to-read Markdown page: summaries first, then each item type, then copyable lists. */
export function renderMetadataMarkdown(m: WorkspaceMetadata, jsonFile = 'the .json file next to it'): string {
  const out: string[] = [];
  const line = (text = '') => out.push(text);
  const table = (headers: string[], rows: Cell[][]) => {
    if (!rows.length) {
      line('None.');
      line();
      return;
    }
    line(`| ${headers.join(' | ')} |`);
    line(`| ${headers.map(() => '---').join(' | ')} |`);
    rows.forEach((r) => line(`| ${r.map(cell).join(' | ')} |`));
    line();
  };
  const code = (text: string, language = '') => {
    fence(text, language).forEach((l) => line(l));
    line();
  };

  line(`# ${mdText(m.workspace.name)}`);
  line();
  line(`Fabric workspace information, refreshed ${mdText(m.capturedAt)}${m.account ? ` as ${mdText(m.account)}` : ''}.`);
  line(`Generated by Fabric Supersat: run "Refresh Workspace Information" again to refresh it. The same data is in ${mdText(jsonFile)}.`);
  line();

  line('## Summary');
  line();
  if (m.summary.notebooksCancelled) {
    line(
      `**Cancelled**: details of ${m.summary.notebooksCancelled} notebook${m.summary.notebooksCancelled === 1 ? '' : 's'} weren't fetched. ` +
        'Run "Refresh Workspace Information" again for a complete page.',
    );
    line();
  }
  const total = m.summary.itemTypes.reduce((sum, t) => sum + t.count, 0);
  table(
    ['Item type', 'Count'],
    [...m.summary.itemTypes.map((t) => [t.type, t.count]), [{ md: '**Total**' }, { md: `**${total}**` }]],
  );
  if (m.summary.notebookLanguages) {
    line('Notebooks by language:');
    line();
    table(['Language', 'Count'], m.summary.notebookLanguages.map((l) => [l.language, l.count]));
  }
  if (m.summary.local) {
    line('Notebooks compared with `src/Notebooks` (as downloading would write them):');
    line();
    table(
      ['Status', 'Count'],
      Object.entries(m.summary.local)
        .filter(([, count]) => count)
        .map(([status, count]) => [status, count]),
    );
  }
  const workspaceRows: [string, unknown][] = [
    ['Name', m.workspace.name],
    ['ID', m.workspace.id],
    ['Type', m.workspace.type],
    ['Description', m.workspace.description],
    ['Capacity ID', m.workspace.capacityId],
    ['Capacity region', m.workspace.capacityRegion],
    ['Domain ID', m.workspace.domainId],
  ];
  if (m.git) {
    const details = (m.git.gitProviderDetails ?? {}) as JsonRecord;
    workspaceRows.push(
      ['Git connection', m.git.gitConnectionState],
      ['Git provider', details.gitProviderType],
      ['Git repository', [details.ownerName ?? details.organizationName, details.projectName, details.repositoryName].filter(Boolean).join('/')],
      ['Git branch', details.branchName],
      ['Git folder', details.directoryName],
    );
  }
  table(
    ['Workspace', ''],
    workspaceRows.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]),
  );
  if (m.unavailable.length) {
    line(`**${m.unavailable.length} section${m.unavailable.length === 1 ? '' : 's'} not available** (see the end of this page).`);
    line();
  }

  if (m.folders.length) {
    line('## Folders');
    line();
    code(m.folders.map((f) => f.path).join('\n'));
  }

  line('## Notebooks');
  line();
  const onlyLocal = m.onlyLocal ?? [];
  if (m.notebooks.some((n) => n.language)) {
    table(
      ['Name', 'Folder', 'Language', 'Default lakehouse', 'Environment', 'Local'],
      [
        ...m.notebooks.map((n): Cell[] => [
          n.name,
          n.folder,
          n.language ?? (n.error ? `error: ${n.error}` : undefined),
          n.defaultLakehouse && `${n.defaultLakehouse.name ?? n.defaultLakehouse.id}${n.defaultLakehouse.workspace === 'this workspace' ? '' : ` (workspace ${n.defaultLakehouse.workspace})`}`,
          n.environment && `${n.environment.name ?? n.environment.id}${n.environment.workspace === 'this workspace' ? '' : ` (workspace ${n.environment.workspace})`}`,
          n.local,
        ]),
        ...onlyLocal.map((name): Cell[] => [name, undefined, undefined, undefined, undefined, ONLY_LOCAL]),
      ],
    );
  } else if (onlyLocal.length) {
    // Not compared without notebook details, but local-only notebooks are still listed.
    table(
      ['Name', 'Folder', 'Description', 'Local'],
      [
        ...m.notebooks.map((n): Cell[] => [n.name, n.folder, n.description, undefined]),
        ...onlyLocal.map((name): Cell[] => [name, undefined, undefined, ONLY_LOCAL]),
      ],
    );
  } else {
    table(['Name', 'Folder', 'Description'], m.notebooks.map((n) => [n.name, n.folder, n.description]));
  }

  line('## Lakehouses');
  line();
  for (const l of m.lakehouses) {
    line(`### ${mdText(l.name)}`);
    line();
    const sql = (l.sqlEndpointProperties ?? {}) as JsonRecord;
    table(
      ['', ''],
      [
        ['ID', l.id],
        ['SQL analytics endpoint ID', sql.id as string],
        ['SQL endpoint status', sql.provisioningStatus as string],
        ['Default schema', l.defaultSchema as string],
      ].filter(([, v]) => v),
    );
    for (const [label, value] of [
      ['SQL connection string', sql.connectionString],
      ['OneLake tables path', l.oneLakeTablesPath],
      ['OneLake files path', l.oneLakeFilesPath],
    ] as const) {
      if (typeof value === 'string' && value) {
        line(`${label}:`);
        line();
        code(value);
      }
    }
    if (Array.isArray(l.tables)) {
      table(
        ['Table', 'Type', 'Format', 'Location'],
        (l.tables as JsonRecord[]).map((t) => [t.name as string, t.type as string, t.format as string, t.location as string]),
      );
    } else if (l.tablesUnavailable) {
      line(`Tables not available: ${cell(l.tablesUnavailable as string)}`);
      line();
    }
  }
  if (!m.lakehouses.length) {
    line('None.');
    line();
  }

  line('## Warehouses');
  line();
  table(
    ['Name', 'ID', 'Connection string'],
    m.warehouses.map((w) => [w.name, w.id, w.connectionString as string]),
  );

  line('## Environments');
  line();
  table(
    ['Name', 'ID', 'Publish state'],
    m.environments.map((e) => {
      const publish = (e.publishDetails ?? {}) as JsonRecord;
      return [e.name, e.id, publish.state as string];
    }),
  );

  line('## All items');
  line();
  table(['Type', 'Name', 'Folder', 'Description', 'ID'], m.items.map((i) => [i.type, i.name, i.folder, i.description, i.id]));

  if (m.roles) {
    line('## Member roles');
    line();
    table(['Principal', 'Type', 'Email', 'Role'], m.roles.map((r) => [r.principal, r.type, r.email, r.role]));
  }

  if (m.spark) {
    line('## Spark settings');
    line();
    code(JSON.stringify(m.spark, undefined, 2), 'json');
  }

  line('## Copyable lists');
  line();
  for (const { type } of m.summary.itemTypes) {
    const names = m.items.filter((i) => i.type === type);
    line(`${mdText(type)} names:`);
    line();
    code(names.map((i) => i.name).join('\n'));
  }
  line('All items as CSV (type, name, ID):');
  line();
  code(['type,name,id', ...m.items.map((i) => [i.type, i.name, i.id].map(csv).join(','))].join('\n'), 'csv');

  if (m.unavailable.length) {
    line('## Not available');
    line();
    table(['Section', 'Reason'], m.unavailable.map((u) => [u.section, u.reason]));
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** A table cell's value: text (shown as it is), a number, nothing, or Markdown written by this file (`md`). */
type Cell = string | number | undefined | { md: string };

/** A Markdown table cell: one line, shown exactly as it is (see `mdText`), unless it is the extension's own Markdown. */
function cell(value: Cell): string {
  if (value === undefined || value === '') {
    return '';
  }
  return typeof value === 'object' ? value.md : mdText(value);
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
