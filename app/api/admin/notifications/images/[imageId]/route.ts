import { serveNotificationImage } from "@/lib/notificationImages.server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export function GET(request: Request, { params }: { params: { imageId: string } }) {
  return serveNotificationImage(request, params.imageId);
}
