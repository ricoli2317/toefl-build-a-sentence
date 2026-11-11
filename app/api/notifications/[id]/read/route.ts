import { notificationRead } from "@/lib/notifications.server";
export const dynamic = "force-dynamic";
export function POST(request: Request, { params }: { params: { id: string } }) {
  return notificationRead(request, params.id);
}
