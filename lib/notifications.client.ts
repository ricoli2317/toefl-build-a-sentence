"use client";

import { createBrowserSupabase } from "@/lib/supabase/client";

export class NotificationRequestError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export async function notificationRequest<T>(url: string, userId: string, init?: RequestInit): Promise<T> {
  const response = await notificationAuthorizedFetch(url, userId, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new NotificationRequestError(data.message ?? "通知请求失败，请重试。", response.status);
  return data as T;
}

export async function notificationAuthorizedFetch(url: string, userId: string, init?: RequestInit) {
  const { data: { session } } = await createBrowserSupabase().auth.getSession();
  if (!session || session.user.id !== userId) throw new Error("登录身份已变化，请刷新页面。");
  return fetch(url, {
    ...init, cache: "no-store", headers: {
      ...(!(init?.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${session.access_token}`
    }
  });
}

export async function loadNotificationImage(url: string, userId: string, signal: AbortSignal) {
  const response = await notificationAuthorizedFetch(url, userId, { signal });
  if (!response.ok) throw new NotificationRequestError(response.status === 410 ? "图片已过期" : "图片暂不可用", response.status);
  const expiresAt = response.headers.get("X-Notification-Image-Expires-At");
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.now() >= Date.parse(expiresAt)) throw new NotificationRequestError("图片已过期", 410);
  return { objectUrl: URL.createObjectURL(await response.blob()), expiresAt };
}
