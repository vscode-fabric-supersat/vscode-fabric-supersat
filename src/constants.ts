/** Marketplace ID (`publisher.name` in package.json). */
export const EXTENSION_FULL_ID = 'vscode-fabric-supersat.vscode-fabric-supersat';

/** Prefix shared by every command and setting contributed in package.json. */
export const ID_PREFIX = 'fabric-supersat';

export const Commands = {
  showLog: `${ID_PREFIX}.showLog`,
  openSettings: `${ID_PREFIX}.openSettings`,
  signIn: `${ID_PREFIX}.signIn`,
  signOut: `${ID_PREFIX}.signOut`,
  configureSignIn: `${ID_PREFIX}.configureSignIn`,
  selectWorkspace: `${ID_PREFIX}.selectWorkspace`,
  downloadNotebook: `${ID_PREFIX}.downloadNotebook`,
  downloadAllNotebooks: `${ID_PREFIX}.downloadAllNotebooks`,
  uploadAllNotebooks: `${ID_PREFIX}.uploadAllNotebooks`,
  deleteAllNotebooks: `${ID_PREFIX}.deleteAllNotebooks`,
  deleteNotebook: `${ID_PREFIX}.deleteNotebook`,
  uploadNotebook: `${ID_PREFIX}.uploadNotebook`,
  switchNotebookFile: `${ID_PREFIX}.switchNotebookFile`,
  newNotebook: `${ID_PREFIX}.newNotebook`,
  refreshWorkspaceInformation: `${ID_PREFIX}.refreshWorkspaceInformation`,
  testNotebookFormats: `${ID_PREFIX}.testNotebookFormats`,
  compareAllNotebooksWithWorkspace: `${ID_PREFIX}.compareAllNotebooksWithWorkspace`,
  compareNotebookWithWorkspace: `${ID_PREFIX}.compareNotebookWithWorkspace`,
  syncWorkspace: `${ID_PREFIX}.syncWorkspace`,
} as const;
