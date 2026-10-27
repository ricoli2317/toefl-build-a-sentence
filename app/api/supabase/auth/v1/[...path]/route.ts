import { proxySupabaseAuth } from "@/lib/supabase/authProxy.server";

export const runtime = "nodejs";
export const preferredRegion = "syd1";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The handler validates the complete URL, not interpolated catch-all params.
export const GET = proxySupabaseAuth;
export const POST = proxySupabaseAuth;
export const PUT = proxySupabaseAuth;
export const PATCH = proxySupabaseAuth;
export const DELETE = proxySupabaseAuth;
export const HEAD = proxySupabaseAuth;
export const OPTIONS = proxySupabaseAuth;
