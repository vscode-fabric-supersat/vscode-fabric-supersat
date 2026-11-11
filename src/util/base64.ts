/** Base64 for raw bytes, using `btoa`/`atob`, which both the Node.js and web-worker hosts have. */

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // In chunks: String.fromCharCode(...bytes) overflows the stack for large files.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
