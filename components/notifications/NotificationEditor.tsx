"use client";

import { useEffect, useRef, useState } from "react";
import { Editor, Extension, Mark, Node, type JSONContent } from "@tiptap/core";
import { baseKeymap } from "@tiptap/pm/commands";
import { keymap } from "@tiptap/pm/keymap";
import { history, undo, redo } from "@tiptap/pm/history";
import { splitListItem, liftListItem, sinkListItem } from "@tiptap/pm/schema-list";
import { useCurrentAccount } from "@/components/RoleGate";
import { loadNotificationImage, notificationRequest, NotificationRequestError } from "@/lib/notifications.client";
import { NOTIFICATION_IMAGE_MAX_BYTES, NOTIFICATION_IMAGE_TYPES, type NotificationImageAsset } from "@/lib/notificationImages";
import { normalizeNotificationDocument, notificationDocumentText, plainNotificationDocument, type NotificationDocument } from "@/lib/notificationDocument";

// Reuses the project's installed Tiptap/ProseMirror core and history (as in the
// revision editor), but deliberately does not reuse its assessment/ledger rules.
export function NotificationEditor({ content, document, disabled, onChange, onBusyChange }: {
  content: string; document?: NotificationDocument | null; disabled: boolean;
  onChange: (content: string, document: NotificationDocument | null) => void; onBusyChange: (busy: boolean) => void;
}) {
  const { userId } = useCurrentAccount();
  const host = useRef<HTMLDivElement>(null), file = useRef<HTMLInputElement>(null), active = useRef<Editor | null>(null);
  const initial = useRef(document ?? plainNotificationDocument(content));
  const callbacks = useRef({ onChange, onBusyChange }); callbacks.current = { onChange, onBusyChange };
  const mounted = useRef(false), upload = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(disabled); lock.current = disabled;

  useEffect(() => {
    mounted.current = true;
    const editor = new Editor({
      element: host.current!, editable: !lock.current, content: initial.current as JSONContent,
      extensions: [
        Node.create({ name: "doc", topNode: true, content: "block+" }),
        Node.create({ name: "text", group: "inline" }),
        Node.create({ name: "paragraph", group: "block", content: "inline*", parseHTML: () => [{ tag: "p" }], renderHTML: () => ["p", 0] }),
        Node.create({ name: "heading", group: "block", content: "inline*", addAttributes: () => ({ level: { default: 2 } }),
          parseHTML: () => [{ tag: "h2", attrs: { level: 2 } }, { tag: "h3", attrs: { level: 3 } }], renderHTML: ({ node }) => [node.attrs.level === 3 ? "h3" : "h2", 0] }),
        Node.create({ name: "hardBreak", inline: true, group: "inline", selectable: false, parseHTML: () => [{ tag: "br" }], renderHTML: () => ["br"],
          addKeyboardShortcuts() { return { "Shift-Enter": () => this.editor.commands.insertContent({ type: "hardBreak" }) }; } }),
        Node.create({ name: "bulletList", group: "block", content: "listItem+", parseHTML: () => [{ tag: "ul" }], renderHTML: () => ["ul", { class: "list-disc pl-6" }, 0] }),
        Node.create({ name: "orderedList", group: "block", content: "listItem+", parseHTML: () => [{ tag: "ol" }], renderHTML: () => ["ol", { class: "list-decimal pl-6" }, 0] }),
        Node.create({ name: "listItem", content: "paragraph block*", defining: true, parseHTML: () => [{ tag: "li" }], renderHTML: () => ["li", 0] }),
        ...([['bold', 'strong'], ['italic', 'em'], ['underline', 'u']] as const).map(([name, tag]) => Mark.create({ name,
          parseHTML: () => [{ tag }], renderHTML: () => [tag, 0] })),
        Node.create({ name: "image", group: "block", atom: true, draggable: true,
          addAttributes: () => ({ imageId: { default: null }, alt: { default: "通知图片" } }),
          // Never import pasted external URLs/base64. Only our own typed image
          // nodes may be inserted via the authenticated upload control.
          parseHTML: () => [], renderHTML: ({ node }) => ["div", { "data-notification-image-id": node.attrs.imageId }, "通知图片"],
          addNodeView: () => ({ node }) => {
            const dom = window.document.createElement("div"), image = window.document.createElement("img"), status = window.document.createElement("span");
            dom.contentEditable = "false"; dom.className = "my-3 rounded-lg border border-student-border p-2";
            image.alt = node.attrs.alt; image.className = "max-h-64 max-w-full object-contain"; image.hidden = true;
            status.textContent = "图片加载中…"; dom.append(image, status);
            const controller = new AbortController();
            let live = true, url: string | undefined, timer: ReturnType<typeof setTimeout>;
            const expire = (expiresAt: string) => {
              const remaining = Date.parse(expiresAt) - Date.now();
              if (remaining <= 0) { image.hidden = true; image.removeAttribute("src"); status.textContent = "图片已过期"; if (url) URL.revokeObjectURL(url); url = undefined; }
              else timer = setTimeout(() => expire(expiresAt), Math.min(remaining, 2147483647));
            };
            void loadNotificationImage(`/api/admin/notifications/images/${node.attrs.imageId}`, userId, controller.signal).then(result => {
              if (!live) { URL.revokeObjectURL(result.objectUrl); return; }
              url = result.objectUrl; image.src = url; image.hidden = false; status.textContent = ""; expire(result.expiresAt);
            }).catch(cause => { if (live) status.textContent = cause instanceof NotificationRequestError && cause.status === 410 ? "图片已过期" : "图片暂不可用"; });
            image.onerror = () => { image.hidden = true; status.textContent = "图片暂不可用"; };
            return { dom, destroy: () => { live = false; controller.abort(); clearTimeout(timer); if (url) URL.revokeObjectURL(url); } };
          }
        }),
        Extension.create({ name: "notificationHistory", addProseMirrorPlugins() { const listItem = this.editor.schema.nodes.listItem;
          return [history(), keymap({ "Mod-z": undo, "Mod-Shift-z": redo, "Mod-y": redo, Enter: splitListItem(listItem), Tab: sinkListItem(listItem), "Shift-Tab": liftListItem(listItem) }), keymap(baseKeymap)]; } })
      ],
      editorProps: { attributes: { role: "textbox", "aria-label": "通知正文", "aria-multiline": "true", class: "min-h-48 p-3 outline-none [&_p]:min-h-6 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:text-lg [&_h3]:font-bold" },
        handleDOMEvents: { paste: (_view, event) => {
          if ((event as ClipboardEvent).clipboardData?.files.length) { event.preventDefault(); setError("请使用“插入图片”上传，不接受粘贴内嵌图片。"); return true; }
          return false;
        }, drop: (_view, event) => { if ((event as DragEvent).dataTransfer?.files.length) { event.preventDefault(); setError("请使用“插入图片”上传。"); return true; } return false; } } },
      onUpdate: ({ editor: current }) => {
        const safe = normalizeNotificationDocument(current.getJSON());
        callbacks.current.onChange(safe ? notificationDocumentText(safe) : "", safe);
      }
    });
    active.current = editor;
    return () => { mounted.current = false; upload.current?.abort(); active.current = null; editor.destroy(); };
  }, [userId]);
  useEffect(() => { active.current?.setEditable(!disabled && !busy); }, [disabled, busy]);

  async function insertImage(selected?: File) {
    if (!selected || busy || lock.current) return;
    if (selected.size > NOTIFICATION_IMAGE_MAX_BYTES || !NOTIFICATION_IMAGE_TYPES.includes(selected.type as typeof NOTIFICATION_IMAGE_TYPES[number])) { setError("仅支持不超过 3 MB 的 PNG、JPEG、WebP 图片。"); return; }
    setBusy(true); callbacks.current.onBusyChange(true); setError("");
    const controller = new AbortController(); upload.current = controller;
    try {
      const form = new FormData(); form.set("image", selected);
      const result = await notificationRequest<{ image: NotificationImageAsset }>("/api/admin/notifications/images", userId, { method: "POST", body: form, signal: controller.signal });
      if (mounted.current) active.current?.chain().focus().insertContent([{ type: "image", attrs: { imageId: result.image.id, alt: "通知图片" } }, { type: "paragraph" }]).run();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "图片上传失败。"); }
    finally { if (mounted.current) { setBusy(false); callbacks.current.onBusyChange(false); } if (file.current) file.current.value = ""; }
  }
  const command = (work: (editor: Editor) => void) => { if (!disabled && !busy && active.current) work(active.current); };
  return <div className="rounded-xl border border-student-border">
    <div className="flex flex-wrap gap-1 border-b border-student-border p-2" role="toolbar" aria-label="正文排版">
      {([['粗体', 'bold'], ['斜体', 'italic'], ['下划线', 'underline']] as const).map(([label, mark]) => <button key={mark} type="button" className="rounded px-2 py-1 hover:bg-student-bg" disabled={disabled || busy} onClick={() => command(editor => { editor.chain().focus().toggleMark(mark).run(); })}>{label}</button>)}
      <button type="button" disabled={disabled || busy} onClick={() => command(editor => { editor.chain().focus().toggleNode("paragraph", "heading", { level: 2 }).run(); })}>标题</button>
      <button type="button" disabled={disabled || busy} onClick={() => command(editor => { editor.chain().focus().toggleList("bulletList", "listItem").run(); })}>无序列表</button>
      <button type="button" disabled={disabled || busy} onClick={() => command(editor => { editor.chain().focus().toggleList("orderedList", "listItem").run(); })}>有序列表</button>
      <button type="button" className="ml-2 text-student-primary" disabled={disabled || busy} onClick={() => file.current?.click()}>{busy ? "上传中…" : "插入图片"}</button>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="上传通知图片" onChange={event => { void insertImage(event.target.files?.[0]); }} />
    </div>
    <div ref={host} className="max-h-96 overflow-y-auto" />
    <p className="px-3 pb-2 text-xs text-student-muted">图片自上传起保留 30 天；每张最多 3 MB。</p>
    {error ? <p role="alert" className="teacher-error p-3">{error}</p> : null}
  </div>;
}
