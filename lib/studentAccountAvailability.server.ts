import type { SupabaseClient } from "@supabase/supabase-js";
import { INTERNAL_ACCOUNT_DOMAIN, prepareNewAccount } from "./accountIdentifier.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { firstAvailableStudentAccount, studentAccountCandidates } from "./studentAccountSuggestion.ts";

/**
 * Authoritative student-account availability checks.
 *
 * The public.first_available_student_account RPC covers BOTH the profiles
 * account column and the real auth.users unique email constraint, so an
 * orphaned Auth user without a profile row can never be reported as free.
 * Until that migration is applied the helpers degrade to the original
 * profiles-only scan; the Auth createUser call remains the final concurrency
 * guard either way. "admin" stays reserved.
 */

export async function resolveAvailableStudentAccount(supabase: SupabaseClient, base: string) {
  const candidates = studentAccountCandidates(base);
  if (candidates.length === 0) return null;

  const resolver = await supabase.rpc("first_available_student_account", {
    p_base: candidates[0]
  });
  if (!resolver.error) {
    return typeof resolver.data === "string" && resolver.data ? resolver.data : null;
  }
  if (!isMissingFunctionError(resolver.error.message, "first_available_student_account")) {
    throw resolver.error;
  }

  const taken = new Set<string>(["admin"]);
  const suffix = `@${INTERNAL_ACCOUNT_DOMAIN}`;
  const result = await readAllSupabaseRows<{ email: string | null }>((from, to) =>
    supabase
      .from("profiles")
      .select("email")
      .ilike("email", `${candidates[0]}%`)
      .order("id", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw result.error;
  for (const row of result.data ?? []) {
    const email = String(row.email ?? "").toLocaleLowerCase();
    if (email.endsWith(suffix)) taken.add(email.slice(0, -suffix.length));
  }

  return firstAvailableStudentAccount(candidates[0], (candidate) => taken.has(candidate));
}

/**
 * True when exactly `account` itself is still free. Used by the 新增学生
 * account hint for manually edited accounts; the resolver returning a
 * different account (a suffix) means the requested one is taken.
 */
export async function isStudentAccountAvailable(supabase: SupabaseClient, account: string) {
  const prepared = prepareNewAccount(account);
  if (!prepared.ok) return false;
  const available = await resolveAvailableStudentAccount(supabase, prepared.account);
  return available === prepared.account;
}

function isMissingFunctionError(message: string | undefined, functionName: string) {
  const text = message ?? "";
  return text.includes(functionName)
    && /(does not exist|schema cache|could not find the function)/i.test(text);
}
