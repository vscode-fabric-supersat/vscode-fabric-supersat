/**
 * How errors tell `reportError` (util/errors.ts) what the user can do about them, without
 * util depending on the modules that throw them. No `vscode` dependency.
 */

/** Buttons and a hint offered with an error. */
export interface ErrorFix {
  hint?: string;
  /** A VS Code setting to open. Never a sign-in setting: those use `configureSignIn`. */
  setting?: string;
  /** Offer the "Configure Sign-In" command. */
  configureSignIn?: boolean;
  /** Offer the "Select Workspace" command. */
  selectWorkspace?: boolean;
  /** A command to run in a terminal. */
  terminalCommand?: string;
  link?: { label: string; url: string };
}

/** An error that knows its fix (e.g. `AuthError`, `WorkspaceNameError`, `FabricApiError`). */
export interface FixableError {
  readonly fix: ErrorFix | undefined;
}

/** An error that isn't a failure (e.g. the user cancelled): logged, not shown. */
export interface QuietError {
  readonly quiet: true;
}

/**
 * Not a failure of the extension or of Fabric, but something about the user's account,
 * settings, files or choices that stops the command (sign-in declined, no workspace with the
 * saved name, a notebook type that isn't supported, a file with unsaved changes...). Logged
 * and shown as a warning ("<command> could not proceed: …"), without a stack trace, with any
 * fix it carries. Anything else that reaches `reportError` is unexpected, and an error.
 */
export interface WarningError {
  readonly warning: boolean;
}

/** A command can't go on because of something the message tells the user about. Not a failure (see `WarningError`). */
export class ActionNeededError extends Error implements WarningError {
  readonly warning = true;

  constructor(message: string) {
    super(message);
    this.name = 'ActionNeededError';
  }
}

/** The fix an error carries, if any. */
export function fixOf(err: unknown): ErrorFix | undefined {
  return err instanceof Error && 'fix' in err ? (err as Error & FixableError).fix : undefined;
}

/** Whether an error is a `WarningError`. */
export function isWarning(err: unknown): boolean {
  return err instanceof Error && (err as Error & Partial<WarningError>).warning === true;
}

/** Whether an error is a `QuietError`. */
export function isQuiet(err: unknown): boolean {
  return err instanceof Error && (err as Error & Partial<QuietError>).quiet === true;
}
