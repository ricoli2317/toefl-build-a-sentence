import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { bearerToken, requireAdmin, requireAuthenticatedAccount } from "@/lib/auth";
import { createAnonSupabase, createServiceSupabase } from "@/lib/supabase/server";
import { normalizeNotificationDocument, notificationImageIds } from "./notificationDocument.ts";
import { isNotificationId } from "./notifications.ts";
import { inspectNotificationImage, isNotificationImageKey, notificationImageExpired, NOTIFICATION_IMAGE_MAX_BYTES,
  type NotificationImageAsset } from "./notificationImages.ts";

const fields = "id,object_key,uploaded_at,expires_at,content_type,size_bytes";
const json = (message: string, status: number) => Response.json({ message }, { status, headers: { "Cache-Control": "private, no-store" } });

class NotificationUploadFailure extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function r2() {
  const required = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"] as const;
  const missing = required.filter(name => !process.env[name]?.trim());
  if (missing.length) throw new NotificationUploadFailure("NOTIFICATION_R2_ENV_MISSING",
    `当前部署缺少 R2 环境变量：${missing.join("、")}。请为该部署环境补齐配置并重新部署；生命周期确认开关不能替代 R2 连接配置。`);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID!.trim();
  const bucket = process.env.R2_BUCKET_NAME!.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID!.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY!.trim();
  const invalid: string[] = [];
  if (!/^[a-f0-9]{32}$/i.test(accountId)) invalid.push("CLOUDFLARE_ACCOUNT_ID");
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) invalid.push("R2_BUCKET_NAME");
  if (/[\s'"]/.test(accessKeyId)) invalid.push("R2_ACCESS_KEY_ID");
  if (/[\s'"]/.test(secretAccessKey)) invalid.push("R2_SECRET_ACCESS_KEY");
  if (invalid.length) throw new NotificationUploadFailure("NOTIFICATION_R2_ENV_INVALID",
    `R2 环境变量格式不正确：${invalid.join("、")}。账号 ID 不应填写完整网址，桶名不应包含路径，密钥值不应包含引号或空格。`);
  return { bucket, client: new S3Client({ region: "auto", endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey } }) };
}

function uploadFailure(error: unknown, stage: string) {
  const candidate = error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: number; requestId?: unknown } } | null;
  const errorName = typeof candidate?.name === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate.name) ? candidate.name : "UnknownError";
  const upstreamStatus = candidate?.$metadata?.httpStatusCode;
  let failure: NotificationUploadFailure;
  if (error instanceof NotificationUploadFailure) failure = error;
  else if (stage === "multipart_parse") failure = new NotificationUploadFailure("NOTIFICATION_UPLOAD_BODY_INVALID", "上传请求格式不正确，请重新选择图片重试。", 400);
  else if (stage === "body_read") failure = new NotificationUploadFailure("NOTIFICATION_UPLOAD_BODY_READ_FAILED", "图片上传请求未完整接收，请检查网络并重试。", 400);
  else if (stage === "r2_put" && ["InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken"].includes(errorName)) {
    failure = new NotificationUploadFailure("NOTIFICATION_R2_AUTH_FAILED", "R2 认证失败，请核对当前部署中的 R2 密钥与 Cloudflare 账号是否匹配，并在更新后重新部署。");
  } else if (stage === "r2_put" && (upstreamStatus === 401 || upstreamStatus === 403)) {
    failure = new NotificationUploadFailure("NOTIFICATION_R2_ACCESS_DENIED", "R2 拒绝写入通知图片。请确认当前 R2 API 密钥拥有目标桶的对象读写权限；无需修改生命周期规则。");
  } else if (stage === "r2_put" && (errorName === "NoSuchBucket" || upstreamStatus === 404)) {
    failure = new NotificationUploadFailure("NOTIFICATION_R2_BUCKET_NOT_FOUND", "R2 目标桶不存在或不可访问，请核对 R2_BUCKET_NAME 与 CLOUDFLARE_ACCOUNT_ID。");
  } else failure = new NotificationUploadFailure("NOTIFICATION_IMAGE_UPLOAD_FAILED", "图片上传暂时失败，请稍后重试或将诊断代码反馈给管理员。");
  const diagnosticId = randomUUID();
  // NEVER log raw errors, stack traces, request headers, credentials, signed
  // URLs or uploaded bytes. AWS error messages can contain signing material.
  console.error("[notification-image-upload]", { diagnosticId, stage, code: failure.code, errorName, upstreamStatus: upstreamStatus ?? null });
  return Response.json({ message: `${failure.message}（诊断代码：${failure.code}）`, code: failure.code, diagnosticId }, {
    status: failure.status, headers: { "Cache-Control": "private, no-store" }
  });
}

export async function assertNotificationImagesPublishable(document: unknown, db: ReturnType<typeof createAnonSupabase>) {
  const ids = notificationImageIds(normalizeNotificationDocument(document));
  if (!ids.length) return;
  const { data, error } = await db.from("notification_image_assets").select(fields).in("id", ids);
  if (error) throw Error("无法核对通知图片，请确认通知增量迁移已安装。");
  if (data?.length !== ids.length) throw Error("草稿包含无效图片，请重新上传后发布。");
  const store = r2();
  for (const asset of data as NotificationImageAsset[]) {
    if (!isNotificationImageKey(asset.object_key) || notificationImageExpired(asset.expires_at)) throw Error("草稿图片已过期，请重新上传后发布。");
    try {
      const object = await store.client.send(new HeadObjectCommand({ Bucket: store.bucket, Key: asset.object_key }));
      if (object.ContentLength !== asset.size_bytes || object.ContentType !== asset.content_type) throw Error("Image metadata mismatch");
    } catch { throw Error("草稿图片已失效或无法读取，请重新上传或重试后发布。"); }
  }
}

export async function uploadNotificationImage(request: Request) {
  const token = bearerToken(request);
  const auth = await requireAdmin(token);
  if (auth.error || !auth.userId) return json("仅管理员可以上传通知图片。", 403);
  const maxBody = NOTIFICATION_IMAGE_MAX_BYTES + 64 * 1024;
  if (Number(request.headers.get("content-length")) > maxBody) return json("图片不得超过 3 MB。", 413);
  let stage = "body_read";
  try {
    // Bound the actual multipart body too; Content-Length is not trusted.
    const reader = request.body?.getReader();
    if (!reader) return json("请选择图片。", 400);
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBody) { await reader.cancel(); return json("图片不得超过 3 MB。", 413); }
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    stage = "multipart_parse";
    const form = await new Response(body, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    const file = form.get("image");
    if (!file || typeof file === "string" || file.size > NOTIFICATION_IMAGE_MAX_BYTES) return json("请选择不超过 3 MB 的 PNG、JPEG 或 WebP 图片。", 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checked = inspectNotificationImage(bytes, file.type);
    if (!checked) return json("图片类型或文件内容无效，仅支持 PNG、JPEG、WebP，不接受 SVG、HTML 或 base64。", 400);
    if (process.env.NOTIFICATION_IMAGES_LIFECYCLE_CONFIRMED !== "true") return json("请先在 Cloudflare 配置仅针对 notifications/ 的 30 天自动删除规则，并确认通知图片生命周期配置。", 503);
    stage = "r2_config";
    const store = r2();
    const id = randomUUID();
    const objectKey = `notifications/${id}.${checked.extension}`;
    stage = "metadata_insert";
    const { data, error } = await createAnonSupabase(token).from("notification_image_assets").insert({
      id, object_key: objectKey, uploaded_by: auth.userId, content_type: checked.type, size_bytes: bytes.byteLength
    }).select(fields).single();
    if (error || !data) throw new NotificationUploadFailure("NOTIFICATION_IMAGE_METADATA_FAILED", "图片元数据保存失败，请检查通知图片表的迁移和访问权限。");
    // Only this new notification key may be written. Never touch RDL keys,
    // bucket CORS, lifecycle rules, or any other existing bucket objects.
    stage = "r2_put";
    await store.client.send(new PutObjectCommand({ Bucket: store.bucket, Key: objectKey, Body: bytes,
      ContentType: checked.type, ContentLength: bytes.byteLength, CacheControl: "private, no-store", IfNoneMatch: "*" }));
    return Response.json({ image: data }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return uploadFailure(error, stage); }
}

export async function serveNotificationImage(request: Request, imageId: string, notificationId?: string) {
  try {
    if (!isNotificationId(imageId) || (notificationId && !isNotificationId(notificationId))) return json("无效的图片。", 400);
    const token = bearerToken(request);
    const auth = notificationId ? await requireAuthenticatedAccount(token) : await requireAdmin(token);
    if (auth.error || !auth.userId || (notificationId && auth.role !== "teacher" && auth.role !== "student")) return json("无权查看图片。", 403);
    if (notificationId) {
      const visible = await createAnonSupabase(token).from("system_notifications").select("content_document").eq("id", notificationId).maybeSingle();
      if (visible.error) return json("通知图片暂不可用。", 503);
      if (!visible.data || !notificationImageIds(normalizeNotificationDocument(visible.data.content_document)).includes(imageId)) return json("通知图片不可访问。", 404);
    }
    // Service access is limited to this single metadata row, AFTER recipient RLS
    // verified the parent notification and the exact image membership.
    const { data, error } = await createServiceSupabase().from("notification_image_assets").select(fields).eq("id", imageId).maybeSingle();
    if (error) return json("图片服务暂不可用。", 503);
    if (!data || !isNotificationImageKey(data.object_key)) return json("图片不存在。", 404);
    if (notificationImageExpired(data.expires_at)) return json("图片已过期", 410);
    const store = r2();
    const object = await store.client.send(new GetObjectCommand({ Bucket: store.bucket, Key: data.object_key }));
    if (!object.Body || object.ContentLength !== data.size_bytes || object.ContentType !== data.content_type) return json("图片暂不可用。", 503);
    const bytes = await object.Body.transformToByteArray();
    if (notificationImageExpired(data.expires_at)) return json("图片已过期", 410);
    return new Response(bytes, { headers: { "Content-Type": data.content_type, "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "X-Notification-Image-Expires-At": data.expires_at } });
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    return json(status === 404 ? "图片已过期" : "图片服务暂不可用。", status === 404 ? 410 : 503);
  }
}
