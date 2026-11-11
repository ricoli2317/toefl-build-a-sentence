import { normalizeNotificationDocument, notificationDocumentText, type NotificationDocument } from "./notificationDocument.ts";

export const NOTIFICATION_TYPES = { announcement: "公告", maintenance: "系统维护", update: "功能更新" } as const;
export const NOTIFICATION_TARGETS = { all: "全部教师和学生", teacher: "仅教师", student: "仅学生" } as const;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;
export type NotificationTarget = keyof typeof NOTIFICATION_TARGETS;
export type NotificationDraft = { title: string; content: string; type: NotificationType; target_role: NotificationTarget; content_document?: NotificationDocument | null };
export type NotificationItem = NotificationDraft & { id: string; published_at: string; read_at: string | null };
export type NotificationListItem = Pick<NotificationItem, "id" | "title" | "type" | "published_at" | "read_at">;
export type AdminNotification = NotificationDraft & {
  id: string; status: "draft" | "published" | "withdrawn";
  created_at: string; updated_at: string; published_at: string | null;
};
export type NotificationCursor = { before: string; beforeId: string };
export type NotificationPage = { notifications: NotificationListItem[]; nextCursor: NotificationCursor | null };

export function validateNotificationDraft(value: unknown): NotificationDraft | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.title !== "string" || typeof body.content !== "string"
    || typeof body.type !== "string" || !Object.hasOwn(NOTIFICATION_TYPES, body.type)
    || typeof body.target_role !== "string" || !Object.hasOwn(NOTIFICATION_TARGETS, body.target_role)) return null;
  const title = body.title.trim();
  const content = body.content.trim();
  if (!title || title.length > 160 || !content || content.length > 20000) return null;
  const document = body.content_document == null ? null : normalizeNotificationDocument(body.content_document);
  if (body.content_document != null && !document) return null;
  const normalizedContent = document ? notificationDocumentText(document) : content;
  if (!normalizedContent || normalizedContent.length > 20000) return null;
  return { title, content: normalizedContent,
    type: body.type as NotificationType, target_role: body.target_role as NotificationTarget,
    ...(body.content_document !== undefined ? { content_document: document } : {}) };
}

export function isNotificationId(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const NOTIFICATION_SAFE_PAGES = new Set([
    "/student", "/student/sets", "/student/practice-sets", "/student/write-email",
    "/student/academic-discussion", "/student/reading/ctw", "/student/reading/rdl",
    "/student/reading/rap", "/student/reading/full-sets", "/student/assignments",
    "/student/practice-history", "/student/wordbook", "/student/ctw-vocabulary",
    "/teacher/dashboard", "/teacher/students", "/teacher/writing/assignments", "/teacher/writing/reviews"
]);

// Fail closed for unknown/new routes. Never interrupt a practice, recovery,
// submission, assignment detail, or immersive workspace (including Teacher's).
export function isNotificationSafePage(path: string) {
  return NOTIFICATION_SAFE_PAGES.has(path);
}

export function notificationTime(value: string) {
  return new Date(value).toLocaleString("zh-CN");
}
