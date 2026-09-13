"use client";

import { createClient } from "@supabase/supabase-js";
import { createSupabaseFetch } from "./fetch.ts";

export function createBrowserSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Missing Supabase browser environment variables.");
  }

  return createClient(url, anonKey, {
    global: { fetch: createSupabaseFetch() }
  });
}
