import { createBrowserSupabase } from "@/lib/supabase/client";

export async function teacherApiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const supabase = createBrowserSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("登录已失效，请重新登录。");
  const response = await fetch(input, {
    ...init,
    cache: "no-store",
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {})
    }
  });
  const payload = await response.json().catch(() => ({})) as { message?: string } & T;
  if (!response.ok) throw new Error(payload.message ?? "请求失败，请稍后重试。");
  return payload;
}
