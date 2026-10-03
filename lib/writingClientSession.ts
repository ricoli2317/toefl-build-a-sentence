"use client";

import { createBrowserSupabase } from "@/lib/supabase/client";
import { type WritingRequestSession } from "@/lib/writingRequestSession";

export type WritingClientSession = WritingRequestSession;

let browserClient: ReturnType<typeof createBrowserSupabase> | null = null;

/**
 * One long-lived browser client per tab. Reusing a single client keeps
 * Supabase's own auto-refresh timer (already enabled by default) working on
 * the same session storage record instead of spawning competing refreshers.
 */
export function getWritingClient() {
  if (!browserClient) browserClient = createBrowserSupabase();
  return browserClient;
}

function toWritingClientSession(
  session: {
    access_token?: string | null;
    user?: { id?: string | null; email?: string | null } | null;
  } | null | undefined
): WritingClientSession | null {
  if (!session?.access_token || !session.user?.id) return null;
  return {
    accessToken: session.access_token,
    email: session.user.email ?? null,
    studentId: session.user.id
  };
}

export async function getWritingClientSession(): Promise<WritingClientSession | null> {
  const { data, error } = await getWritingClient().auth.getSession();
  if (error) return null;
  return toWritingClientSession(data.session);
}

export async function refreshWritingClientSession(): Promise<WritingClientSession | null> {
  const { data, error } = await getWritingClient().auth.refreshSession();
  if (error) return null;
  return toWritingClientSession(data.session);
}

/**
 * Signs out the shared writing client before entering the existing login
 * flow. Failures are ignored on purpose: navigation still proceeds, and the
 * login page re-checks any remaining session before rendering.
 */
export async function signOutWritingClientSession() {
  try {
    await getWritingClient().auth.signOut();
  } catch {
    // The login page remains the single recovery entry point.
  }
}
