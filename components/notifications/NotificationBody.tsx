"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useCurrentAccount } from "@/components/RoleGate";
import { loadNotificationImage, NotificationRequestError } from "@/lib/notifications.client";
import { normalizeNotificationDocument, type NotificationNode } from "@/lib/notificationDocument";
import { NotificationModal } from "./NotificationModal";

export function NotificationBody({ content, document, notificationId, admin = false }: {
  content: string; document?: unknown; notificationId?: string; admin?: boolean;
}) {
  const safeDocument = normalizeNotificationDocument(document);
  if (!safeDocument) return <p className="whitespace-pre-wrap break-words text-sm leading-7">{content}</p>;
  function render(node: NotificationNode, key: number): ReactNode {
    const children = node.content?.map(render);
    switch (node.type) {
      case "text": return <span key={key}>{(node.marks ?? []).reduce<ReactNode>((text, mark) => mark.type === "bold" ? <strong>{text}</strong>
        : mark.type === "italic" ? <em>{text}</em> : <u>{text}</u>, node.text)}</span>;
      case "hardBreak": return <br key={key} />;
      case "paragraph": return <p key={key} className="min-h-6 whitespace-pre-wrap break-words">{children}</p>;
      case "heading": return node.attrs?.level === 3 ? <h3 key={key} className="text-lg font-bold">{children}</h3> : <h2 key={key} className="text-xl font-bold">{children}</h2>;
      case "bulletList": return <ul key={key} className="list-disc space-y-1 pl-6">{children}</ul>;
      case "orderedList": return <ol key={key} className="list-decimal space-y-1 pl-6">{children}</ol>;
      case "listItem": return <li key={key}>{children}</li>;
      case "image": return <NotificationImage key={key} imageId={node.attrs!.imageId!} alt={node.attrs?.alt ?? "通知图片"} notificationId={notificationId} admin={admin} />;
    }
  }
  return <div className="grid min-w-0 grid-cols-1 gap-3 text-sm leading-7">{safeDocument.content.map(render)}</div>;
}

function NotificationImage({ imageId, alt, notificationId, admin }: { imageId: string; alt: string; notificationId?: string; admin: boolean }) {
  const { userId } = useCurrentAccount();
  const [state, setState] = useState<{ url?: string; message?: string }>({});
  const [preview, setPreview] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let live = true, objectUrl: string | undefined;
    let timer: ReturnType<typeof setTimeout>;
    setState({});
    setPreview(false);
    const expire = (expiresAt: string) => {
      const remaining = Date.parse(expiresAt) - Date.now();
      if (remaining <= 0) { setPreview(false); if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined; setState({ message: "图片已过期" }); }
      else timer = setTimeout(() => expire(expiresAt), Math.min(remaining, 2147483647));
    };
    void loadNotificationImage(admin ? `/api/admin/notifications/images/${imageId}` : `/api/notifications/${notificationId}/images/${imageId}`, userId, controller.signal)
      .then(result => {
        if (!live) { URL.revokeObjectURL(result.objectUrl); return; }
        objectUrl = result.objectUrl;
        setState({ url: objectUrl });
        expire(result.expiresAt);
      }).catch(error => { if (live) setState({ message: error instanceof NotificationRequestError && error.status === 410 ? "图片已过期" : "图片暂不可用" }); });
    return () => { live = false; controller.abort(); clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [admin, imageId, notificationId, userId, retry]);
  if (!state.url) return <div role="status" className="rounded-xl border border-student-border bg-student-bg p-4 text-student-muted">
    {state.message ?? "图片加载中…"}
    {state.message === "图片暂不可用" ? <button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>重试</button> : null}
  </div>;
  // Blob URLs contain authenticated, bounded image responses only; no public
  // bucket URL, bearer token or expiring external signed URL is persisted.
  const unavailable = () => { setPreview(false); setState({ message: "图片暂不可用" }); };
  return <>
    <button type="button" aria-label="放大通知图片" className="block min-w-0 max-w-full cursor-zoom-in justify-self-start" onClick={() => setPreview(true)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={state.url} alt={alt} className="h-auto max-w-full rounded-lg" onError={unavailable} />
    </button>
    <NotificationModal open={preview} title="图片预览" label="通知图片预览" image onClose={() => setPreview(false)}
      footer={<button type="button" className="student-button-secondary" onClick={() => setPreview(false)}>关闭图片预览</button>}>
      <button type="button" aria-label="点击图片关闭预览" className="grid w-full min-w-0 cursor-zoom-out justify-items-center" onClick={() => setPreview(false)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.url} alt={alt} className="h-auto max-w-full" onError={unavailable} />
      </button>
    </NotificationModal>
  </>;
}
