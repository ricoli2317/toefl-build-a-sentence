"use client";

import { createBrowserSupabase } from "@/lib/supabase/client";
import { type WritingRequestSession } from "@/lib/writingRequestSession";

export type WritingClientSession = WritingRequestSession;

/** Writing uses the same page-owned client as login, reading and the shell. */
export function getWritingClient() {
  return createBrowserSupabase();
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
