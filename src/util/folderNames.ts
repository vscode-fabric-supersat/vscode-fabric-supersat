/**
 * Which names can be folder (and file) names on every OS, Windows included. One set of
 * rules for every folder the extension names after something in Fabric: a notebook's
 * folders (`src/Notebooks/<Name>/`, `.fabric-supersat/Notebooks/<Name>/`, its format-test
 * samples) and a workspace's folder (`.fabric-supersat/workspaces/<Name>/`). No `vscode`
 * dependency.
 */

/** Characters that can't be in a file name on some OS. */
const UNSAFE_CHARACTER = /[\\/:*?"<>|\u0000-\u001f]/;

/**
 * Names Windows reserves for devices, which can't be folder or file names there, ignoring
 * case and whatever follows a dot (`nul.txt` is reserved too). Includes COM and LPT with
 * superscript digits, which Windows also reserves.
 */
const WINDOWS_RESERVED_NAME = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(\.|$)/i;

/** Why `name` can't be a folder name on every OS (to finish "The name … "), or `undefined` if it can. */
export function folderNameProblem(name: string): string | undefined {
  if (UNSAFE_CHARACTER.test(name)) {
    return 'contains a character that isn\'t allowed in folder names (\\ / : * ? " < > |)';
  }
  if (name !== name.trim() || name.endsWith('.')) {
    return 'starts or ends with a space, or ends with a dot';
  }
  if (name === '' || name === '.' || name === '..') {
    return 'is empty';
  }
  if (WINDOWS_RESERVED_NAME.test(name)) {
    return 'is a name Windows reserves for devices (CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9)';
  }
  return undefined;
}

/**
 * `name` itself if it can be a folder name (see `folderNameProblem`); otherwise a safe
 * name made from it: unsafe characters (and `%`, so encoded names can be told apart)
 * become `%XX`, as do leading and trailing spaces, a trailing dot and the first letter of
 * a reserved name. For folders that may be named differently from what they're for (a
 * notebook's own folders never are: such a notebook is refused instead).
 */
export function safeFolderName(name: string): string {
  if (!folderNameProblem(name)) {
    return name;
  }
  const hex = (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  let encoded = name.replace(/[\\/:*?"<>|%\u0000-\u001f]/g, hex);
  encoded = encoded.replace(/^ +| +$/g, (spaces) => '%20'.repeat(spaces.length));
  encoded = encoded.replace(/\.$/, '%2E');
  if (WINDOWS_RESERVED_NAME.test(encoded)) {
    encoded = hex(encoded[0]) + encoded.slice(1);
  }
  return encoded === '' ? '%' : encoded;
}
