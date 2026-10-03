import type { SupabaseClient } from "@supabase/supabase-js";
import { INTERNAL_ACCOUNT_DOMAIN, prepareNewAccount } from "./accountIdentifier.ts";
import { validateBindingDomains, type StudentBindingDomain } from "./studentBindings.ts";
import { resolveAvailableStudentAccount } from "./studentAccountAvailability.server.ts";
import { DEFAULT_STUDENT_PASSWORD } from "./teacherClasses.ts";
import {
  buildStudentBindingCandidates,
  createTeacherStudentBindings,
  findActiveStudentsByName,
  rollbackCreatedStudentAccount,
  type StudentBindingCandidate
} from "./teacherStudentBindings.ts";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";

/**
 * Shared Teacher-side student-account creation used by the standalone 新增学生
 * page and by the class creation flow.
 *
 * Every student account is created with the frozen initial password
 * DEFAULT_STUDENT_PASSWORD (123456); callers never supply a password. Behavior
 * is otherwise identical to the original route, plus the auto-suffix rule: when
 * the account is still the auto-generated name slug and it is already taken by
 * a DIFFERENT student, the account receives the next free numeric suffix
 * instead of failing (used by the class flow and by the 新增学生 page).
 * Teacher-edited accounts keep the original conflict behavior.
 */

const AUTH_CREATE_ATTEMPTS = 4;

export type CreateStudentAccountInput = {
  actorId: string;
  actorRole: "teacher" | "admin";
  account: string;
  studentName: string;
  domains?: unknown;
  confirmDuplicateName?: boolean;
  /** Class flow and auto-generated accounts: auto-suffix a taken account. */
  autoSuffix?: boolean;
};

export type CreateStudentAccountResult =
  | {
      ok: true;
      student: {
        id: string;
        account: string;
        displayName: string;
        domains: StudentBindingDomain[];
      };
    }
  | {
      ok: false;
      status: number;
      code?: string;
      error: string;
      candidates?: StudentBindingCandidate[];
    };

export async function createTeacherStudentAccount(
  supabase: SupabaseClient,
  input: CreateStudentAccountInput
): Promise<CreateStudentAccountResult> {
  const preparedAccount = prepareNewAccount(input.account ?? "");
  // The initial password is fixed by the product and set here on the server;
  // the client never sends a password.
  const password = DEFAULT_STUDENT_PASSWORD;
  const studentName = typeof input.studentName === "string" ? input.studentName.trim() : "";

  if (!preparedAccount.ok) return { ok: false, status: 400, error: preparedAccount.error };
  if (!studentName) {
    return {
      ok: false,
      status: 400,
      error: "Student name is required."
    };
  }

  // Ordinary teachers must pick at least one teaching subject so the new
  // student always gains a real teaching binding. Admin keeps the unchanged
  // account-management flow and never receives a teaching binding.
  const isTeacher = input.actorRole === "teacher";
  let domains: StudentBindingDomain[] = [];
  if (isTeacher) {
    const checkedDomains = validateBindingDomains(input.domains);
    if (!checkedDomains.ok) return { ok: false, status: 400, error: checkedDomains.error };
    domains = checkedDomains.domains;
  }
  const autoSuffix = Boolean(input.autoSuffix) && isTeacher;

  let account = preparedAccount.account;
  let authEmail = preparedAccount.authEmail;
  const baseAccount = preparedAccount.account;
  const { data: existingProfile, error: existingProfileError } = await supabase
    .from("profiles")
    .select("id,full_name")
    .ilike("email", authEmail)
    .maybeSingle();
  if (existingProfileError) throw existingProfileError;
  if (existingProfile) {
    const sameName =
      typeof existingProfile.full_name === "string"
      && existingProfile.full_name.trim() === studentName;
    if (autoSuffix) {
      // The auto-generated account is already taken. The caller already
      // decided this is a new student (continue-new), so resolve the next
      // free suffix from the ORIGINAL base to keep the numeric sequence.
      const available = await resolveAvailableStudentAccount(supabase, baseAccount);
      if (!available) {
        return { ok: false, status: 409, code: "ACCOUNT_EXISTS", error: "该账号已存在。" };
      }
      account = available;
      authEmail = `${available}@${INTERNAL_ACCOUNT_DOMAIN}`;
    } else {
      return {
        ok: false,
        status: 409,
        code: sameName ? "ACCOUNT_EXISTS_SAME_NAME" : "ACCOUNT_EXISTS",
        error: sameName ? "该学生账号已存在，请使用“绑定学生/班级”。" : "该账号已存在。"
      };
    }
  }

  if (isTeacher && !input.confirmDuplicateName) {
    const sameNameStudents = await findActiveStudentsByName(supabase, studentName);
    if (sameNameStudents.length > 0) {
      const candidates = await buildStudentBindingCandidates(supabase, sameNameStudents);
      return {
        ok: false,
        status: 409,
        code: "DUPLICATE_NAME",
        error: "已存在同名学生，请选择绑定已有学生或继续新增。",
        candidates
      };
    }
  }

  if (isTeacher) {
    const [{ data: profile, error: profileError }, { count, error: countError }] =
      await Promise.all([
        supabase.from("profiles").select("student_account_limit").eq("id", input.actorId).single(),
        supabase
          .from("profiles")
          .select("id", { count: "exact", head: true })
          .eq("role", "student")
          .eq("is_active", true)
          .eq("owner_id", input.actorId)
      ]);
    if (profileError || countError) throw profileError ?? countError;
    if ((count ?? 0) >= Number(profile?.student_account_limit ?? 20)) {
      return { ok: false, status: 409, code: "STUDENT_ACCOUNT_LIMIT_REACHED", error: "STUDENT_ACCOUNT_LIMIT_REACHED" };
    }
  }

  let createdUser:
    | { id: string; user_metadata?: Record<string, unknown> }
    | null = null;
  let lastAuthError: string | null = null;
  for (let attempt = 0; attempt < (autoSuffix ? AUTH_CREATE_ATTEMPTS : 1); attempt += 1) {
    const { data, error } = await supabase.auth.admin.createUser({
      email: authEmail,
      password,
      email_confirm: true,
      user_metadata: {
        display_name: studentName,
        full_name: studentName,
        name: studentName,
        role: "student",
        owner_id: input.actorId
      }
    });
    if (!error && data.user) {
      createdUser = { id: data.user.id, user_metadata: data.user.user_metadata };
      break;
    }
    lastAuthError = error?.message ?? "Failed to create student.";
    const alreadyRegistered = /already (been )?registered|already exists/i.test(lastAuthError);
    if (!alreadyRegistered || !autoSuffix) break;
    // A concurrent create took the account between the pre-check and the Auth
    // call: resolve the next free suffix from the original base and retry.
    const available = await resolveAvailableStudentAccount(supabase, baseAccount);
    if (!available || available === account) break;
    account = available;
    authEmail = `${available}@${INTERNAL_ACCOUNT_DOMAIN}`;
  }

  if (!createdUser) {
    const message = lastAuthError ?? "Failed to create student.";
    const alreadyRegistered = /already (been )?registered|already exists/i.test(message);
    return {
      ok: false,
      status: alreadyRegistered ? 409 : 500,
      code: alreadyRegistered ? "ACCOUNT_EXISTS" : undefined,
      error: alreadyRegistered ? "该账号已存在。" : message
    };
  }

  const { error: profileError } = await supabase.from("profiles").upsert(
    {
      id: createdUser.id,
      email: authEmail,
      full_name: studentName,
      role: "student",
      owner_id: input.actorId,
      is_active: true
    },
    { onConflict: "id" }
  );

  if (profileError) {
    await supabase.auth.admin.deleteUser(createdUser.id);
    return {
      ok: false,
      status: 500,
      error: `Student auth user created, but profile save failed: ${profileError.message}`
    };
  }

  if (isTeacher) {
    const bindings = await createTeacherStudentBindings(supabase, {
      teacherId: input.actorId,
      studentId: createdUser.id,
      domains
    });
    if (!bindings.ok) {
      await rollbackCreatedStudentAccount(supabase, {
        userId: createdUser.id,
        deleteAuthUser: (userId) => supabase.auth.admin.deleteUser(userId)
      });
      return { ok: false, status: 500, error: "学生账号创建失败，请稍后重试。" };
    }
  }

  return {
    ok: true,
    student: {
      id: createdUser.id,
      account,
      displayName: getPreferredUserDisplayName({
        email: authEmail,
        metadata: createdUser.user_metadata
      }),
      domains
    }
  };
}

export {
  isStudentAccountAvailable,
  resolveAvailableStudentAccount
} from "./studentAccountAvailability.server.ts";
