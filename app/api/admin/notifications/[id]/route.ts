import { adminNotificationDelete, adminNotificationUpdate } from "@/lib/notifications.server";
export const dynamic = "force-dynamic";
export function PATCH(request: Request, { params }: { params: { id: string } }) {
  return adminNotificationUpdate(request, params.id);
}
export function DELETE(request: Request, { params }: { params: { id: string } }) {
  return adminNotificationDelete(request, params.id);
}
