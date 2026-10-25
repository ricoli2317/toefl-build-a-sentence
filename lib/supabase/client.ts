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
    global: { fetch: createSupabaseFetch() }
  });
  browser.__tpsSupabaseClient = client;
  return client;
}
