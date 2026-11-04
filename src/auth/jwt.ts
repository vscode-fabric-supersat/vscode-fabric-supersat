/**
 * Reads the claims of a Microsoft Entra access token. This does NOT verify the
 * signature (only the API can do that); it's used to show the account name, check the
 * audience and expiry of pasted tokens, and know when to refresh.
 */

export interface TokenClaims {
  aud?: string;
  /** Expiry, in seconds since the epoch. */
  exp?: number;
  tid?: string;
  upn?: string;
  unique_name?: string;
  preferred_username?: string;
  appid?: string;
  name?: string;
}

/** Audiences the Fabric REST API accepts (Fabric, and the Power BI resource it shares). */
export const FABRIC_AUDIENCES = [
  'https://api.fabric.microsoft.com',
  'https://analysis.windows.net/powerbi/api',
  '00000009-0000-0000-c000-000000000000',
];

/** Strips whitespace and an optional "Bearer " prefix from a pasted token. */
export function normalizeToken(raw: string): string {
  return raw.trim().replace(/^bearer\s+/i, '');
}

/** Decodes the payload of a JWT. Throws if `token` isn't one. */
export function decodeJwt(token: string): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    throw new Error('Not a JWT access token.');
  }
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims !== 'object' || claims === null) {
      throw new Error();
    }
    return claims as TokenClaims;
  } catch {
    throw new Error('Not a JWT access token.');
  }
}

/** The best human-readable account name in the claims. */
export function accountLabel(claims: TokenClaims): string {
  return (
    claims.upn ??
    claims.preferred_username ??
    claims.unique_name ??
    claims.name ??
    (claims.appid ? `app ${claims.appid}` : 'unknown account')
  );
}

/** Whether the token expires within `marginSeconds` from `now` (ms). Tokens without `exp` count as expired. */
export function isExpired(claims: TokenClaims, now = Date.now(), marginSeconds = 60): boolean {
  return claims.exp === undefined || claims.exp * 1000 <= now + marginSeconds * 1000;
}
