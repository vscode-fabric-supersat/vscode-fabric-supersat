/**
 * Line endings. Files may use LF (macOS, Linux) or CRLF (Windows, e.g. git with
 * `core.autocrlf`). Text is compared and processed as LF; a file that is rewritten keeps
 * the line endings it had, so editors and git don't see every line as changed. New files,
 * and everything sent to Fabric, use LF, as Fabric does.
 */

export type LineEnding = '\n' | '\r\n';

/** `text` with CRLF (and lone CR) line endings as LF. */
export function toLf(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The line ending `text` uses: CRLF if its first line break is CRLF, otherwise LF (also for text with none). */
export function lineEndingOf(text: string): LineEnding {
  const match = /\r?\n/.exec(text);
  return match?.[0] === '\r\n' ? '\r\n' : '\n';
}

/** `text` with every line ending as `eol`. */
export function withLineEnding(text: string, eol: LineEnding): string {
  const lf = toLf(text);
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}
