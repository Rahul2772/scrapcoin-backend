import { createRemoteJWKSet, jwtVerify } from "jose";

const SUPABASE_URL = process.env.SUPABASE_URL!;

// Cache the JWKS remotely — jose handles key fetching + caching automatically
const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)
);

export type JWTClaims = {
  sub: string;       // user UUID
  email: string;
  role: string;      // authenticated / anon
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  [key: string]: unknown;
};

/**
 * Verify a Supabase user access token using the project's JWKS endpoint.
 * Supports both the legacy HS256 symmetric tokens AND the new ES256 asymmetric tokens.
 *
 * Returns the decoded claims on success, throws on any failure.
 */
export async function verifySupabaseToken(token: string): Promise<JWTClaims> {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: "authenticated",
    });
    return payload as unknown as JWTClaims;
  } catch (err) {
    throw new Error(`Invalid or expired token: ${(err as Error).message}`);
  }
}
