/**
 * Writing text that comes from elsewhere (Fabric item names and descriptions, notebook
 * content) into Markdown pages the extension generates and opens in the preview, so it
 * shows exactly as it is and can't become links, images, HTML or math. No `vscode` dependency.
 */

/**
 * `value` as literal Markdown text on one line: every character Markdown or HTML could
 * act on mid-line is backslash-escaped (CommonMark allows that for any ASCII punctuation),
 * and line breaks become spaces. For text in a table cell, after a heading's `#`, or
 * after other text on a line (`-` and `+` only matter at the start of a line, so are left alone).
 */
export function mdText(value: string | number): string {
  return String(value)
    .replace(/\r?\n|\r/g, ' ')
    .replace(/[\\`*_{}[\]()<>#!|~&$]/g, '\\$&');
}

/**
 * `text` as a fenced code block (lines, without a trailing blank line), shown verbatim: the
 * fence is longer than any run of backticks in the text, so the text can't close it.
 */
export function fence(text: string, info = ''): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));
  return [`${marks}${info}`, text, marks];
}
