/** Marketplace ID (`publisher.name` in package.json). */
export const EXTENSION_FULL_ID = 'vscode-fabric-supersat.vscode-fabric-supersat';

/** Prefix shared by every command and setting contributed in package.json. */
export const ID_PREFIX = 'fabric-supersat';

export const Commands = {
  showLog: `${ID_PREFIX}.showLog`,
  openSettings: `${ID_PREFIX}.openSettings`,
  signIn: `${ID_PREFIX}.signIn`,
  signOut: `${ID_PREFIX}.signOut`,
  switchTenant: `${ID_PREFIX}.switchTenant`,
  listNotebooks: `${ID_PREFIX}.listNotebooks`,
} as const;
