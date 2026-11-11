import { notificationDetail } from "@/lib/notifications.server";
export const dynamic = "force-dynamic";
export function GET(request: Request, { params }: { params: { id: string } }) {
  return notificationDetail(request, params.id);
}
