import type * as vscode from 'vscode';
import type { FabricAuth } from '../auth/service';
import type { FabricClient } from '../fabric/client';
import type { WorkspaceService } from '../workspace/service';

/** Shared services created once at activation and handed to every feature. */
export interface Services {
  /** Fabric tokens, using the sign-in method chosen in the `auth.method` setting. */
  readonly auth: FabricAuth;
  /** Fabric REST API client, signed in through `auth`. */
  readonly fabric: FabricClient;
  /**
   * The current Fabric workspace (`workspace.id` setting). Features that work in a
   * workspace call `workspace.resolve()`, which asks the user to pick one only if none is saved.
   */
  readonly workspace: WorkspaceService;
}

/**
 * A self-contained unit of functionality. Add new features by implementing this
 * interface and listing the feature in `features/index.ts`.
 *
 * Code here runs in both the Node.js (desktop) and web-worker (browser) extension
 * hosts, so stick to the `vscode` API and web-compatible code. Use
 * `vscode.workspace.fs` instead of Node's `fs`, and `fetch` instead of `http`.
 * Desktop-only code goes in `src/node/` and is wired in by `src/node/extension.ts`.
 */
export interface Feature {
  readonly name: string;
  activate(context: vscode.ExtensionContext, services: Services): void | Promise<void>;
}
