/** Builds an unsigned JWT with the given claims, for tests. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b64url = (o: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
