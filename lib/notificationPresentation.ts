import type { NotificationListItem } from "./notifications.ts";

// Query filtering and entry intent are separate. Only an automatic entry may
// choose a default detail; a bell entry never selects an item, even if unread.
export type NotificationEntry = "automatic" | "manual";
export function notificationEntryView(entry: NotificationEntry) {
  return entry === "automatic" ? "detail" : "list";
}
export function firstUnreadNotification(items: NotificationListItem[]) {
  return items.find(item => !item.read_at) ?? null;
}
export function nextUnreadNotification(items: NotificationListItem[], currentId: string | undefined) {
  const index = items.findIndex(item => item.id === currentId);
  const ordered = index < 0 ? items : [...items.slice(index + 1), ...items.slice(0, index)];
  return ordered.find(item => item.id !== currentId && !item.read_at) ?? null;
}
