"use client";

import {
  AlertCircle,
  Camera,
  Check,
  Copy,
  Download,
  Loader2,
  X
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  captureNotificationScreenshot,
  notificationScreenshotFilename
} from "@/lib/notificationScreenshot.client";

type ScreenshotStatus = "idle" | "capturing" | "ready";
type BusyAction = "copy" | "save" | null;

type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: Array<{ description?: string; accept: Record<string, string[]> }>;
}) => Promise<{
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}>;

const actionClass =
  "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-student-primary-border bg-white px-3 text-xs font-bold text-student-primary transition hover:bg-student-primary-soft disabled:pointer-events-none disabled:opacity-50";

export function NotificationScreenshotActions({
  targetRef,
  title
}: {
  targetRef: RefObject<HTMLElement>;
  title: string;
}) {
  const [status, setStatus] = useState<ScreenshotStatus>("idle");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setStatus("idle");
    setBlob(null);
    setMessage("");
    setBusy(null);
    setOpen(false);
  }, [title]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  async function capture() {
    const target = targetRef.current;
    if (!target) {
      setMessage("通知正文尚未加载。");
      return;
    }
    setStatus("capturing");
    setMessage("");
    try {
      const next = await captureNotificationScreenshot(target);
      if (!mountedRef.current) return;
      setBlob(next);
      setStatus("ready");
    } catch (error) {
      if (!mountedRef.current) return;
      console.error(
        "[notification-screenshot]",
        error instanceof DOMException
          ? `${error.name}: ${error.message}`
          : error
      );
      setStatus("idle");
      setMessage("截图失败，请重试。");
    }
  }

  function toggle() {
    if (status === "capturing") return;
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (status === "idle") void capture();
  }

  async function copyImage() {
    if (!blob) return;
    setBusy("copy");
    setMessage("");
    try {
      if (
        typeof ClipboardItem === "undefined" ||
        !navigator.clipboard?.write
      ) {
        throw new Error("Clipboard image is unavailable.");
      }
      // Keep the gesture on the current document; clipboard.write requires the
      // page to remain the focused document in some Chromium builds.
      window.focus();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ]);
      setMessage("已复制到剪贴板");
    } catch (error) {
      console.error(
        "[notification-screenshot-copy]",
        error instanceof DOMException
          ? `${error.name}: ${error.message}`
          : error
      );
      setMessage("复制失败，请使用“保存到桌面”。");
    } finally {
      setBusy(null);
    }
  }

  async function saveImage() {
    if (!blob) return;
    setBusy("save");
    setMessage("");
    const fileName = notificationScreenshotFilename(title);
    try {
      const picker = (window as unknown as {
        showSaveFilePicker?: SaveFilePicker;
      }).showSaveFilePicker;
      if (picker) {
        const handle = await picker({
          suggestedName: fileName,
          types: [{ description: "PNG 图片", accept: { "image/png": [".png"] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        setMessage("已保存");
        return;
      }

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage("已开始下载图片");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setMessage("已取消保存");
      } else {
        setMessage("保存失败，请重试。");
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label="截图通知"
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-student-primary-border bg-white px-2.5 text-xs font-bold text-student-primary transition hover:bg-student-primary-soft disabled:pointer-events-none disabled:opacity-50"
        disabled={status === "capturing"}
        onClick={toggle}
        type="button"
      >
        {status === "capturing" ? (
          <Loader2 aria-hidden="true" className="animate-spin" size={14} />
        ) : (
          <Camera aria-hidden="true" size={14} />
        )}
        <span className="hidden sm:inline">截图通知</span>
        <span className="sm:hidden">截图</span>
      </button>

      {open ? (
        <div
          aria-label="通知截图"
          className="absolute right-0 top-full z-50 mt-2 rounded-xl border border-student-border bg-white p-3 text-left shadow-[0_10px_30px_rgba(23,32,51,0.14)]"
          role="dialog"
          style={{ width: "min(20rem, calc(80vw - 2rem))" }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-student-text">截图通知</p>
              <p className="mt-1 text-xs leading-5 text-student-muted">
                {status === "capturing"
                  ? "正在生成完整通知截图…"
                  : status === "ready"
                    ? "已生成完整通知截图"
                    : message || "生成完整通知截图"}
              </p>
            </div>
            <button
              aria-label="关闭截图面板"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-student-muted hover:bg-student-bg"
              onClick={() => setOpen(false)}
              type="button"
            >
              <X aria-hidden="true" size={15} />
            </button>
          </div>

          {status === "capturing" ? (
            <span className="mt-3 block h-2.5 w-2/3 animate-pulse rounded-full bg-student-primary-soft" />
          ) : status === "ready" ? (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className={actionClass}
                  disabled={busy !== null}
                  onClick={() => void copyImage()}
                  type="button"
                >
                  {busy === "copy" ? (
                    <Loader2 aria-hidden="true" className="animate-spin" size={14} />
                  ) : (
                    <Copy aria-hidden="true" size={14} />
                  )}
                  复制图片
                </button>
                <button
                  className={actionClass}
                  disabled={busy !== null}
                  onClick={() => void saveImage()}
                  type="button"
                >
                  {busy === "save" ? (
                    <Loader2 aria-hidden="true" className="animate-spin" size={14} />
                  ) : (
                    <Download aria-hidden="true" size={14} />
                  )}
                  保存到桌面
                </button>
              </div>
              {message ? (
                <span
                  aria-live="polite"
                  className={`mt-2 flex items-center gap-1 text-xs ${
                    message.includes("失败") ? "text-student-error" : "text-student-muted"
                  }`}
                  role="status"
                >
                  {message.includes("失败") ? (
                    <AlertCircle aria-hidden="true" size={13} />
                  ) : message === "已复制到剪贴板" || message === "已保存" ? (
                    <Check aria-hidden="true" size={13} />
                  ) : null}
                  {message}
                </span>
              ) : null}
            </>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <p className="min-w-0 flex-1 text-xs text-student-error">
                {message || "截图失败，请重试。"}
              </p>
              <button
                className={actionClass}
                onClick={() => void capture()}
                type="button"
              >
                <Camera aria-hidden="true" size={14} />
                重试
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
