import { NextResponse } from "next/server";
import { bearerToken, requireAdmin, requireAuthenticatedAccount } from "@/lib/auth";
import { createAnonSupabase } from "@/lib/supabase/server";
import { isNotificationId, validateNotificationDraft } from "./notifications.ts";

export const notificationJson = (body: unknown, status = 200) => NextResponse.json(body, {
  status, headers: { "Cache-Control": "private, no-store" }
});
const fail = () => notificationJson({ message: "通知服务暂不可用；若尚未安装，请先由管理员执行通知迁移 SQL。" }, 503);

async function authorize(request: Request, admin: boolean) {
  const token = bearerToken(request);
  const account = admin ? await requireAdmin(token) : await requireAuthenticatedAccount(token);
  if (account.error || !account.userId || (!admin && account.role !== "teacher" && account.role !== "student")) return null;
  return { db: createAnonSupabase(token), userId: account.userId };
}

export async function notificationInbox(request: Request) {
  try {
    const auth = await authorize(request, false);
    if (!auth) return notificationJson({ message: "无权访问通知。" }, 403);
    const params = new URL(request.url).searchParams;
    if (params.get("view") === "summary") {
      const { data, error } = await auth.db.rpc("notification_unread_count");
      if (error) return fail();
      return notificationJson({ unreadCount: Number(data) });
    }
    const before = params.get("before");
    const beforeId = params.get("beforeId");
    if ((before || beforeId) && (!before || !beforeId || !Number.isFinite(Date.parse(before)) || !isNotificationId(beforeId))) {
      return notificationJson({ message: "无效的分页参数。" }, 400);
    }
    const { data, error } = await auth.db.rpc("notification_inbox", {
      p_before: before, p_before_id: beforeId, p_unread_only: params.get("unread") === "true", p_limit: 21
    });
    if (error) return fail();
    const notifications = (data ?? []).slice(0, 20);
    const last = notifications[notifications.length - 1];
    return notificationJson({ notifications, nextCursor: data?.length > 20 && last
      ? { before: last.published_at, beforeId: last.id } : null });
  } catch { return fail(); }
}

export async function notificationRead(request: Request, id: string) {
  try {
    const auth = await authorize(request, false);
    if (!auth) return notificationJson({ message: "无权确认通知。" }, 403);
    if (!isNotificationId(id)) return notificationJson({ message: "无效的通知 ID。" }, 400);
    // RLS supplies actual-role filtering, regardless of which interface is open.
    const visible = await auth.db.from("system_notifications").select("id").eq("id", id).maybeSingle();
    if (visible.error) return fail();
    if (!visible.data) return notificationJson({ message: "通知已撤回或不可访问。" }, 404);
    const { error } = await auth.db.from("user_notification_reads").upsert({ notification_id: id, user_id: auth.userId }, {
      onConflict: "notification_id,user_id", ignoreDuplicates: true
    });
    if (error) return fail();
    // Idempotent across tabs/devices; never overwrite the first confirmation.
    const read = await auth.db.from("user_notification_reads").select("read_at")
      .eq("notification_id", id).eq("user_id", auth.userId).single();
    if (read.error) return fail();
    return notificationJson({ id, read_at: read.data.read_at });
  } catch { return fail(); }
}

export async function adminNotificationList(request: Request) {
  try {
    const auth = await authorize(request, true);
    if (!auth) return notificationJson({ message: "仅管理员可以管理通知。" }, 403);
    const page = Number(new URL(request.url).searchParams.get("page") ?? 0);
    if (!Number.isInteger(page) || page < 0 || page > 100000) return notificationJson({ message: "无效页码。" }, 400);
    const { data, error } = await auth.db.from("system_notifications")
      .select("id,title,content,type,target_role,status,created_at,updated_at,published_at")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(page * 20, page * 20 + 20);
    if (error) return fail();
    return notificationJson({ notifications: (data ?? []).slice(0, 20), hasMore: (data?.length ?? 0) > 20 });
  } catch { return fail(); }
}

export async function adminNotificationCreate(request: Request) {
  try {
    const auth = await authorize(request, true);
    if (!auth) return notificationJson({ message: "仅管理员可以创建通知。" }, 403);
    const draft = validateNotificationDraft(await request.json().catch(() => null));
    if (!draft) return notificationJson({ message: "请填写有效的标题、正文、通知类型和接收对象。" }, 400);
    const { data, error } = await auth.db.from("system_notifications").insert({ ...draft, created_by: auth.userId })
      .select("id").single();
    if (error) return fail();
    return notificationJson({ id: data.id }, 201);
  } catch { return fail(); }
}

export async function adminNotificationUpdate(request: Request, id: string) {
  try {
    const auth = await authorize(request, true);
    if (!auth) return notificationJson({ message: "仅管理员可以修改通知。" }, 403);
    if (!isNotificationId(id)) return notificationJson({ message: "无效的通知 ID。" }, 400);
    const body = await request.json().catch(() => null);
    if (!body || typeof body.updated_at !== "string" || !Number.isFinite(Date.parse(body.updated_at))) {
      return notificationJson({ message: "缺少草稿版本，请刷新后重试。" }, 400);
    }
    let patch: Record<string, unknown>;
    let expectedStatus: string;
    if (body.action === "edit") {
      const draft = validateNotificationDraft(body);
      if (!draft) return notificationJson({ message: "通知内容无效。" }, 400);
      patch = draft;
      expectedStatus = "draft";
    } else if (body.action === "publish") {
      patch = { status: "published" };
      expectedStatus = "draft";
    } else if (body.action === "withdraw") {
      patch = { status: "withdrawn" };
      expectedStatus = "published";
    } else return notificationJson({ message: "不支持的通知操作。" }, 400);
    const { data, error } = await auth.db.from("system_notifications").update(patch).eq("id", id)
      .eq("status", expectedStatus).eq("updated_at", body.updated_at).select("id").maybeSingle();
    if (error) return fail();
    if (!data) return notificationJson({ message: "通知已被其他操作更新，请刷新；仅草稿可编辑和发布，撤回后不可重新发布。" }, 409);
    return notificationJson({ id: data.id });
  } catch { return fail(); }
}
