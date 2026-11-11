"use client";

import { createBrowserSupabase } from "@/lib/supabase/client";

export class NotificationRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function notificationRequest<T>(url: string, userId: string, init?: RequestInit): Promise<T> {
  const { data: { session } } = await createBrowserSupabase().auth.getSession();
  if (!session || session.user.id !== userId) throw new Error("登录身份已变化，请刷新页面。");
  const response = await fetch(url, {
    ...init, cache: "no-store", headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new NotificationRequestError(data.message ?? "通知请求失败，请重试。", response.status);
  return data as T;
}
