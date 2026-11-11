export const NOTIFICATION_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const NOTIFICATION_IMAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const NOTIFICATION_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type NotificationImageType = typeof NOTIFICATION_IMAGE_TYPES[number];
export type NotificationImageAsset = { id: string; object_key: string; uploaded_at: string; expires_at: string; content_type: NotificationImageType; size_bytes: number };

export function inspectNotificationImage(bytes: Uint8Array, declaredType: string): { type: NotificationImageType; extension: string } | null {
  if (!bytes.length || bytes.length > NOTIFICATION_IMAGE_MAX_BYTES) return null;
  const matches = (signature: number[], at = 0) => signature.every((byte, i) => bytes[at + i] === byte);
  if (declaredType === "image/png" && bytes.length >= 24 && matches([137,80,78,71,13,10,26,10]) && matches([73,72,68,82], 12)) return { type: "image/png", extension: "png" };
  if (declaredType === "image/jpeg" && bytes.length >= 12 && matches([255,216,255]) && matches([255,217], bytes.length - 2)) return { type: "image/jpeg", extension: "jpg" };
  if (declaredType === "image/webp" && bytes.length >= 16 && matches([82,73,70,70]) && matches([87,69,66,80], 8)) return { type: "image/webp", extension: "webp" };
  return null;
}

export function isNotificationImageKey(key: string) {
  return /^notifications\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/.test(key);
}
export function notificationImageExpired(expiresAt: string, now = Date.now()) {
  const time = Date.parse(expiresAt);
  return !Number.isFinite(time) || now >= time;
}
