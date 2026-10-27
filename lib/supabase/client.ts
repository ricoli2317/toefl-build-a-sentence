"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseFetch } from "./fetch.ts";

export function createBrowserSupabase() {
  // Never cache an authenticated client in a server process. This factory is
  // called only by browser effects/events; server code uses server.ts instead.
  if (typeof window === "undefined") {
    throw new Error("Browser Supabase client cannot be used on the server.");
  }
  const browser = window as Window & {
    __tpsSupabaseClient?: SupabaseClient;
  };
  // The page owns the client, not an individual component. A window slot also
  // survives module re-evaluation in development without spawning refreshers.
  if (browser.__tpsSupabaseClient) return browser.__tpsSupabaseClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Missing Supabase browser environment variables.");
  }

  const client = createClient(url, anonKey, {
    // Keep the project URL (and therefore the SDK storage/broadcast namespace).
    // Only browser Auth HTTP transport changes; server and data clients do not.
    global: { fetch: createSupabaseFetch({ authProxy: {
      projectUrl: url,
      mode: process.env.NEXT_PUBLIC_SUPABASE_AUTH_TRANSPORT ?? "proxy"
    } }) }
  });
  browser.__tpsSupabaseClient = client;
  return client;
}
