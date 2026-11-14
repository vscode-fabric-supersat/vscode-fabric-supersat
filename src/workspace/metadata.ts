/**
 * "Download Workspace Metadata": everything the extension can read about a Fabric
 * workspace, saved as `metadata.json` (data, for copying and comparing) and `metadata.md`
 * (the same, easy to read) in `.fabric-supersat/workspaces/<Workspace Name>/`.
 *
 * Each section is fetched separately; one Fabric refuses (e.g. member roles without a
 * role that can see them) is listed under "Not available" instead of failing the rest.
 * The files are outputs only: no command acts on an ID read from them.
 *
 * No `vscode` dependency (local files come in through `LocalNotebooks`), so it can be
 * unit-tested offline.
 */
import type { FabricClient, Folder, Item, JsonRecord, Notebook } from '../fabric/client';
import { mapLimit } from '../util/concurrency';
import type { WorkspaceReferenceKind } from '../notebooks/references';
import { toSameWorkspace } from '../notebooks/references';
import { fetchNotebookSources, isOwnWorkspace, type RemoteNotebook, summarizeNotebook } from '../notebooks/remote';

export const METADATA_FORMAT_VERSION = 1;

/** How a notebook in Fabric compares with its local `.py`. */
export type LocalStatus = 'same' | 'different' | 'only in Fabric' | 'not supported' | 'not fetched';

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
    local?: Record<LocalStatus | 'only local', number>;
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
}

export interface CollectOptions {
  /** Fetch each notebook's content: language, references, and comparison with `local`. */
  notebookDetails: boolean;
  memberRoles: boolean;
  concurrency: number;
  account?: string;
  local?: LocalNotebooks;
  /** The `notebooks.sameWorkspace` settings, so the comparison matches what download would write. */
  sameWorkspace?: Record<WorkspaceReferenceKind, boolean>;
  onProgress?: (message: string) => void;
  isCancelled?: () => boolean;
}

export async function collectWorkspaceMetadata(
  client: FabricClient,
  workspace: { id: string; name: string },
  options: CollectOptions,
): Promise<WorkspaceMetadata> {
  const unavailable: WorkspaceMetadata['unavailable'] = [];
  const attempt = async <T>(section: string, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (err) {
      unavailable.push({ section, reason: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  };
  const progress = options.onProgress ?? (() => undefined);

  progress('workspace and items');
  const [details, items = [], folders = []] = await Promise.all([
    attempt('Workspace details', () => client.getWorkspace(workspace.id)),
    attempt('Items', () => client.listItems(workspace.id)),
    attempt('Folders', () => client.listFolders(workspace.id)),
  ]);
  const folderPaths = folderPathsOf(folders);
  const itemsById = new Map(items.map((i) => [i.id.toLowerCase(), i]));
  const folderOf = (item: { folderId?: string }) => (item.folderId ? folderPaths.get(item.folderId) : undefined);

  progress('lakehouses, warehouses and environments');
  const lakehouseItems = items.filter((i) => i.type === 'Lakehouse');
  const lakehouses = (
    await mapLimit(lakehouseItems, options.concurrency, async (item) => {
      const lakehouse = await attempt(`Lakehouse "${item.displayName}"`, () => client.getLakehouse(workspace.id, item.id));
      let tables: JsonRecord[] | undefined;
      let tablesUnavailable: string | undefined;
      try {
        tables = await client.listLakehouseTables(workspace.id, item.id);
      } catch (err) {
        tablesUnavailable = err instanceof Error ? err.message : String(err);
      }
      return {
        id: item.id,
        name: item.displayName,
        ...(lakehouse?.properties && typeof lakehouse.properties === 'object' ? (lakehouse.properties as JsonRecord) : {}),
        ...(tables ? { tables } : { tablesUnavailable }),
      };
    })
  ).filter((l): l is NonNullable<typeof l> => !!l);
  const warehouses = ((await attempt('Warehouses', () => client.listWarehouses(workspace.id))) ?? []).map((w) => ({
    id: String(w.id),
    name: String(w.displayName),
    ...(w.properties && typeof w.properties === 'object' ? (w.properties as JsonRecord) : {}),
  }));
  const environments = (
    await mapLimit(
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
    )
  ).filter((e): e is NonNullable<typeof e> => !!e);

  const [git, spark, roleAssignments] = await Promise.all([
    attempt('Git connection', () => client.getGitConnection(workspace.id)),
    attempt('Spark settings', () => client.getSparkSettings(workspace.id)),
    options.memberRoles ? attempt('Member roles', () => client.listRoleAssignments(workspace.id)) : undefined,
  ]);

  const notebookItems = items.filter((i) => i.type === 'Notebook') as Item[];
  let remote: RemoteNotebook[] = [];
  if (options.notebookDetails && notebookItems.length) {
    remote = await fetchNotebookSources(client, workspace.id, notebookItems as unknown as Notebook[], {
      concurrency: options.concurrency,
      isCancelled: options.isCancelled,
      onProgress: (name, done, total) => progress(`notebook ${done}/${total} (${name})`),
    });
  }
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
      entry.local = await compareWithLocal(source, options.local, workspace.id, options.sameWorkspace);
    }
    notebooks.push(entry);
  }
  notebooks.sort((a, b) => a.name.localeCompare(b.name));

  const fabricNames = new Set(notebookItems.map((n) => n.displayName.toLowerCase()));
  const onlyLocal = options.local?.names.filter((n) => !fabricNames.has(n.toLowerCase())).sort((a, b) => a.localeCompare(b));

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
    unavailable,
  };
  if (options.notebookDetails) {
    metadata.summary.notebookLanguages = countBy(notebooks.map((n) => n.language ?? 'not fetched')).map(([language, count]) => ({
      language,
      count,
    }));
  }
  if (options.notebookDetails && options.local) {
    const local: Record<LocalStatus | 'only local', number> = {
      same: 0,
      different: 0,
      'only in Fabric': 0,
      'not supported': 0,
      'not fetched': 0,
      'only local': onlyLocal?.length ?? 0,
    };
    for (const n of notebooks) {
      local[n.local ?? 'not fetched']++;
    }
    metadata.summary.local = local;
  }
  return metadata;
}

/**
 * How a notebook in Fabric compares with its local `.py`: the same as what downloading it
 * would write (Fabric's `.py`, with the `sameWorkspace` settings applied), or not.
 */
export async function compareWithLocal(
  source: RemoteNotebook | undefined,
  local: LocalNotebooks,
  workspaceId: string,
  sameWorkspace?: Record<WorkspaceReferenceKind, boolean>,
): Promise<LocalStatus> {
  if (!source || source.error) {
    return 'not fetched';
  }
  if (source.unsupported || (source.gitPath && !source.gitPath.toLowerCase().endsWith('.py'))) {
    return 'not supported';
  }
  if (source.gitText === undefined) {
    return 'not fetched';
  }
  const name = local.names.find((n) => n.toLowerCase() === source.notebook.displayName.toLowerCase());
  const py = name === undefined ? undefined : await local.readPy(name);
  if (py === undefined) {
    return 'only in Fabric';
  }
  return expectedLocalPy(source.gitText, workspaceId, sameWorkspace) === py ? 'same' : 'different';
}

/** The `.py` downloading would write for Fabric's `gitText` (see `toSameWorkspace`). */
export function expectedLocalPy(
  gitText: string,
  workspaceId: string,
  sameWorkspace?: Record<WorkspaceReferenceKind, boolean>,
): string {
  try {
    return sameWorkspace ? toSameWorkspace(gitText, workspaceId, sameWorkspace) : gitText;
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

/** Each folder's path, e.g. "Bronze/Loads", from the folder list's parent links. */
function folderPathsOf(folders: readonly Folder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const pathOf = (folder: Folder, seen = new Set<string>()): string => {
    const known = paths.get(folder.id);
    if (known) {
      return known;
    }
    const parent = folder.parentFolderId ? byId.get(folder.parentFolderId) : undefined;
    const path = parent && !seen.has(parent.id) ? `${pathOf(parent, seen.add(folder.id))}/${folder.displayName}` : folder.displayName;
    paths.set(folder.id, path);
    return path;
  };
  folders.forEach((f) => pathOf(f));
  return paths;
}

function countBy(values: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  values.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------------------
// metadata.md

/** The metadata as an easy-to-read Markdown page: summaries first, then each item type, then copyable lists. */
export function renderMetadataMarkdown(m: WorkspaceMetadata): string {
  const out: string[] = [];
  const line = (text = '') => out.push(text);
  const table = (headers: string[], rows: (string | number | undefined)[][]) => {
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
    line(`\`\`\`${language}`);
    line(text);
    line('```');
    line();
  };

  line(`# ${m.workspace.name}`);
  line();
  line(`Fabric workspace metadata, downloaded ${m.capturedAt}${m.account ? ` as ${m.account}` : ''}.`);
  line('Generated by Fabric Supersat: run "Download Workspace Metadata" again to refresh it. The same data is in metadata.json.');
  line();

  line('## Summary');
  line();
  const total = m.summary.itemTypes.reduce((sum, t) => sum + t.count, 0);
  table(
    ['Item type', 'Count'],
    [...m.summary.itemTypes.map((t) => [t.type, t.count]), ['**Total**', `**${total}**`]],
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
  if (m.notebooks.some((n) => n.language)) {
    table(
      ['Name', 'Folder', 'Language', 'Default lakehouse', 'Environment', 'Local'],
      m.notebooks.map((n) => [
        n.name,
        n.folder,
        n.language ?? (n.error ? `error: ${n.error}` : undefined),
        n.defaultLakehouse && `${n.defaultLakehouse.name ?? n.defaultLakehouse.id}${n.defaultLakehouse.workspace === 'this workspace' ? '' : ` (workspace ${n.defaultLakehouse.workspace})`}`,
        n.environment && `${n.environment.name ?? n.environment.id}${n.environment.workspace === 'this workspace' ? '' : ` (workspace ${n.environment.workspace})`}`,
        n.local,
      ]),
    );
  } else {
    table(['Name', 'Folder', 'Description'], m.notebooks.map((n) => [n.name, n.folder, n.description]));
  }
  if (m.onlyLocal?.length) {
    line(`Only in \`src/Notebooks\`, not in this workspace: ${m.onlyLocal.map((n) => `"${n}"`).join(', ')}.`);
    line();
  }

  line('## Lakehouses');
  line();
  for (const l of m.lakehouses) {
    line(`### ${l.name}`);
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
    line(`${type} names:`);
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

/** A Markdown table cell: one line, with `|` escaped. */
function cell(value: string | number | undefined): string {
  return value === undefined || value === '' ? '' : String(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function csv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
