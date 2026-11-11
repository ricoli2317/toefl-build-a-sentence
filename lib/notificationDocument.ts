// Notification bodies are an allowlisted document, NEVER executable HTML.
// Legacy plain text stays plain text, including strings containing HTML tags.
export type NotificationNode = {
  type: "paragraph" | "heading" | "bulletList" | "orderedList" | "listItem" | "text" | "hardBreak" | "image";
  text?: string;
  marks?: Array<{ type: "bold" | "italic" | "underline" }>;
  attrs?: { level?: number; imageId?: string; alt?: string };
  content?: NotificationNode[];
};
export type NotificationDocument = { type: "doc"; content: NotificationNode[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeNotificationDocument(input: unknown): NotificationDocument | null {
  if (!input || typeof input !== "object" || (input as { type?: unknown }).type !== "doc") return null;
  let nodes = 0, textLength = 0, images = 0;
  function read(value: unknown, depth: number, parent: string): NotificationNode {
    if (++nodes > 2000 || depth > 12 || !value || typeof value !== "object") throw Error("Invalid document");
    const row = value as Record<string, unknown>;
    const type = row.type as NotificationNode["type"];
    const allowed = parent === "paragraph" || parent === "heading" ? ["text", "hardBreak"]
      : parent === "bulletList" || parent === "orderedList" ? ["listItem"]
      : ["paragraph", "heading", "bulletList", "orderedList", "image"];
    if (!allowed.includes(type)) throw Error("Unsupported notification node");
    if (type === "text") {
      if (typeof row.text !== "string" || !row.text) throw Error("Invalid text");
      textLength += row.text.length;
      if (textLength > 20000) throw Error("Notification text too long");
      const marks: NonNullable<NotificationNode["marks"]> = [];
      for (const mark of Array.isArray(row.marks) ? row.marks : []) {
        if (mark && typeof mark === "object" && ["bold", "italic", "underline"].includes(mark.type)
          && !marks.some(existing => existing.type === mark.type)) marks.push({ type: mark.type });
      }
      return { type, text: row.text, ...(marks.length ? { marks } : {}) };
    }
    if (type === "hardBreak") return { type };
    if (type === "image") {
      const attrs = row.attrs as Record<string, unknown> | undefined;
      if (++images > 20 || !attrs || typeof attrs.imageId !== "string" || !uuid.test(attrs.imageId)) throw Error("Invalid notification image");
      // No src, data:, base64, URL, inline style, event handler or arbitrary attrs.
      return { type, attrs: { imageId: attrs.imageId.toLowerCase(), alt: typeof attrs.alt === "string" ? attrs.alt.slice(0, 160) : "通知图片" } };
    }
    const content = row.content === undefined ? [] : row.content;
    if (!Array.isArray(content)) throw Error("Invalid document content");
    return { type, ...(type === "heading" ? { attrs: { level: (row.attrs as { level?: number })?.level === 3 ? 3 : 2 } } : {}),
      content: content.map(child => read(child, depth + 1, type)) };
  }
  try {
    const content = (input as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const result: NotificationDocument = { type: "doc", content: content.map(node => read(node, 0, "doc")) };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 150000) return null;
    return notificationDocumentText(result).trim() || images ? result : null;
  } catch { return null; }
}

export function notificationDocumentText(document: NotificationDocument): string {
  const text = (node: NotificationNode): string => node.type === "text" ? node.text ?? ""
    : node.type === "image" ? "[图片]" : node.type === "hardBreak" ? "\n"
    : (node.content ?? []).map(text).join("") + (node.type === "paragraph" || node.type === "heading" || node.type === "listItem" ? "\n" : "");
  return document.content.map(text).join("").trim();
}

export function notificationImageIds(document: NotificationDocument | null | undefined): string[] {
  const ids = new Set<string>();
  const walk = (nodes: NotificationNode[]) => nodes.forEach(node => {
    if (node.type === "image" && node.attrs?.imageId) ids.add(node.attrs.imageId);
    if (node.content) walk(node.content);
  });
  if (document) walk(document.content);
  return Array.from(ids);
}

export function plainNotificationDocument(text: string): NotificationDocument {
  return { type: "doc", content: text.split("\n").map(line => ({ type: "paragraph", ...(line ? { content: [{ type: "text", text: line }] } : {}) })) };
}
