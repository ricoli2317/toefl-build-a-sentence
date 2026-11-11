import { adminNotificationCreate, adminNotificationList } from "@/lib/notifications.server";
export const dynamic = "force-dynamic";
export const GET = adminNotificationList;
export const POST = adminNotificationCreate;
