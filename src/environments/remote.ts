/**
 * Environments as they are in Fabric, fetched without writing anything, and how each compares
 * with its local copy. Fetched live by the compare commands and "Sync Workspace" (there is no
 * environment cache: workspaces have few environments, and their custom libraries are binaries).
 * No `vscode` dependency.
 */
import type { FabricClient, Item } from '../fabric/client';
import type { FabricProperties } from '../notebooks/remote';
import { mapLimit } from '../util/concurrency';
import { compareContent, type LocalStatus } from '../workspace/metadata';
import { changedFiles, contentFiles, type EnvironmentFile, filesFromDefinition } from './definition';

/** An environment in Fabric, as fetched. */
export interface RemoteEnvironment {
  environment: Pick<Item, 'id' | 'displayName' | 'description' | 'folderId'>;
  /** Its content files (see `contentFiles`), if fetched. */
  files?: EnvironmentFile[];
  /** Why it couldn't be fetched. */
  error?: string;
  /** Not fetched: cancelled before it was reached. */
  cancelled?: true;
  /** Its description and folder path, once known (see `addEnvironmentFolderPaths`). */
  properties?: FabricProperties;
}

export const CANCELLED_ENVIRONMENT = 'Not fetched: cancelled before it was reached.';

/** Fetches environments' definitions, `concurrency` at a time; one failure doesn't stop the rest. */
export async function fetchEnvironmentSources(
  client: FabricClient,
  workspaceId: string,
  environments: readonly RemoteEnvironment['environment'][],
  options: { concurrency?: number; isCancelled?: () => boolean; onProgress?: (name: string, done: number, total: number) => void } = {},
): Promise<RemoteEnvironment[]> {
  let done = 0;
  const results = await mapLimit(
    environments,
    options.concurrency ?? 1,
    async (environment): Promise<RemoteEnvironment> => {
      let result: RemoteEnvironment;
      try {
        const definition = await client.getEnvironmentDefinition(workspaceId, environment.id);
        result = { environment, files: contentFiles(filesFromDefinition(environment.displayName, definition)) };
      } catch (err) {
        result = { environment, error: err instanceof Error ? err.message : String(err) };
      }
      options.onProgress?.(environment.displayName, ++done, environments.length);
      return result;
    },
    () => options.isCancelled?.() ?? false,
  );
  return results.map((r, i) => r ?? { environment: environments[i], error: CANCELLED_ENVIRONMENT, cancelled: true });
}

/** Adds each fetched environment's description and folder path (left out where the folders can't be read). */
export async function addEnvironmentFolderPaths(
  sources: readonly RemoteEnvironment[],
  pathOf: (folderId: string | undefined) => Promise<string>,
): Promise<void> {
  for (const source of sources) {
    let folder: string | undefined;
    try {
      folder = await pathOf(source.environment.folderId);
    } catch {
      folder = undefined;
    }
    source.properties = { description: source.environment.description ?? '', ...(folder !== undefined ? { folder } : {}) };
  }
}

/** How a fetched environment compares with its local content files (`undefined`: not local). Text line endings don't count. */
export function compareEnvironment(source: RemoteEnvironment | undefined, local: EnvironmentFile[] | undefined): LocalStatus {
  return compareContent(source && { error: source.error }, source?.files, local, (a, b) => changedFiles(a, b).length === 0);
}
