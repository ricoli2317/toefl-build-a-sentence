import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { prepareNewAccount } from "@/lib/accountIdentifier";
import { accountBaseFromStudentName } from "@/lib/studentAccountSuggestion";
import {
  isStudentAccountAvailable,
  resolveAvailableStudentAccount
} from "@/lib/teacherStudentAccount.server";

export const dynamic = "force-dynamic";

const json = (data: unknown, init?: ResponseInit) => NextResponse.json(data, {
  ...init,
  headers: { ...init?.headers, "Cache-Control": "no-store" }
});

/**
 * Account hints for the 新增学生 form (teacher and admin share the page).
 *
 *   ?name=张三        -> pinyin base + first free account (zhangsan, zhangsan2, ...)
 *   ?account=lisi    -> whether that exact account is free
 *
 * The uniqueness check runs on the server against the real account namespace
 * (public.first_available_student_account covers auth.users + profiles); the
 * browser never queries Supabase Auth. Creation still re-validates on the
 * server, so a stale hint can only cost one extra suffix, never a duplicate.
 */
export async function GET(request: Request) {
  const auth = await requireUserWithRole(bearerToken(request), "teacher");
  if (auth.error || !auth.userId || !auth.role) {
    const forbidden = auth.error === "Forbidden" || auth.error === "Unauthorized";
    return json(
      { message: forbidden ? "仅普通教师可以新增学生。" : "登录状态已失效，请重新登录。" },
      { status: forbidden ? 403 : 401 }
    );
  }

  try {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") ?? "").trim();
    const accountInput = (url.searchParams.get("account") ?? "").trim();
    if (!name && !accountInput) {
      return json({ account: "", available: false, message: "请输入姓名或账号。" }, { status: 400 });
    }

    const supabase = createServiceSupabase();

    if (!name) {
      const prepared = prepareNewAccount(accountInput);
      if (!prepared.ok) {
        return json({ account: "", available: false, message: prepared.error }, { status: 400 });
      }
      const available = await isStudentAccountAvailable(supabase, prepared.account);
      return json({ account: prepared.account, available });
    }

    const base = accountBaseFromStudentName(name);
    if (!base) {
      return json({
        account: "",
        base: "",
        available: false,
        message: "无法根据姓名生成账号，请手动填写账号。"
      });
    }
    const account = await resolveAvailableStudentAccount(supabase, base);
    if (!account) {
      return json({ account: "", base, available: false, message: "该账号已存在。" });
    }
    return json({ account, base, available: true, adjusted: account !== base });
  } catch (error) {
    console.error("[teacher-student-account-suggestion] failed", error);
    return json({ message: "账号检查失败，请稍后重试。" }, { status: 500 });
  }
}
