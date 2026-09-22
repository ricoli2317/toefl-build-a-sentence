import type { JWK } from "@supabase/supabase-js";

type JwksDocument = {
  keys: JWK[];
};

const JWKS_TTL_MS = 10 * 60 * 1000;

let cachedJwks: { fetchedAt: number; document: JwksDocument } | null = null;
let inflightJwks: Promise<JwksDocument | null> | null = null;

/**
 * Supabase Auth access tokens are verified locally against the project JWKS.
 * The JWKS itself changes only when signing keys rotate, so one process-level
 * fetch per TTL removes a full Auth round trip from every API request while
 * keeping signature verification local and intact.
 */
export async function getCachedSupabaseJwks(): Promise<JwksDocument | null> {
  const now = Date.now();
  if (cachedJwks && now - cachedJwks.fetchedAt < JWKS_TTL_MS) {
    return cachedJwks.document;
  }
  if (inflightJwks) return inflightJwks;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  inflightJwks = fetch(`${url}/auth/v1/.well-known/jwks.json`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    cache: "no-store"
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const document = (await response.json()) as JwksDocument;
      if (!Array.isArray(document?.keys) || document.keys.length === 0) return null;
      cachedJwks = { fetchedAt: Date.now(), document };
      return document;
    })
    .catch(() => null)
    .finally(() => {
      inflightJwks = null;
    });

  return inflightJwks;
}
