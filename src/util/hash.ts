/** SHA-256 hashes, in hex, with Web Crypto (desktop and web). No `vscode` dependency. */

/** SHA-256 of a text's UTF-8 bytes, in hex. */
export function hashText(text: string): Promise<string> {
  return hashBytes(new TextEncoder().encode(text));
}

/** SHA-256 of bytes, in hex. */
export async function hashBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
