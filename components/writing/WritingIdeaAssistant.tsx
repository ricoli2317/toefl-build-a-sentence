"use client";

import {
  ChevronDown,
  ChevronUp,
  Lightbulb,
  Loader2,
  RefreshCw,
  Sparkles
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getWritingClientSession,
  refreshWritingClientSession
} from "@/lib/writingClientSession";
import {
  isWritingSessionError,
  sendWritingRequestWithSession
} from "@/lib/writingRequestSession";
import type {
  WritingIdeaSelection
} from "@/lib/writingIdeaAssistantTypes";
import type { WritingTaskType } from "@/lib/writing";

const REQUEST_DEADLINE_MS = 75_000;
const SESSION_DEPENDENCIES = {
  getSession: getWritingClientSession,
  refreshSession: refreshWritingClientSession
};

export function WritingIdeaAssistant({
  attemptId,
  taskType
}: {
  attemptId: string;
  taskType: WritingTaskType;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selection, setSelection] = useState<WritingIdeaSelection | null>(null);
  const [error, setError] = useState("");
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const markerKey = `tps:writing-idea-assistant:${attemptId}`;

  const loadIdeas = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setOpen(true);
    setLoading(true);
    setError("");

    const startedAt = Date.now();
    try {
      while (true) {
        if (Date.now() - startedAt > REQUEST_DEADLINE_MS) {
          throw new Error("思路生成时间较长，请稍后重试。");
        }
        const { response } = await sendWritingRequestWithSession(
          async (accessToken) =>
            fetch("/api/writing/idea-assistant", {
              method: "POST",
              cache: "no-store",
              signal: controller.signal,
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`
              },
              body: JSON.stringify({ attemptId })
            }),
          SESSION_DEPENDENCIES
        );
        const data = await response.json().catch(() => ({})) as {
          error?: unknown;
          retryAfterMs?: unknown;
          selection?: unknown;
          status?: unknown;
        };
        if (requestRef.current !== requestId) return;

        if (response.status === 202 && data.status === "generating") {
          const retryAfter = Number(data.retryAfterMs);
          await wait(
            Number.isFinite(retryAfter)
              ? Math.max(800, Math.min(3000, Math.round(retryAfter)))
              : 1200,
            controller.signal
          );
          continue;
        }

        if (!response.ok) {
          throw new Error(
            typeof data.error === "string" && data.error
              ? data.error
              : "思路生成失败，请重试。"
          );
        }
        if (data.status === "ready" && data.selection) {
          setSelection(data.selection as WritingIdeaSelection);
          try {
            window.sessionStorage.setItem(markerKey, "1");
          } catch {
            // Session storage may be unavailable; the selection still renders.
          }
          return;
        }
        throw new Error("思路生成失败，请重试。");
      }
    } catch (loadError) {
      if (requestRef.current !== requestId) return;
      if (loadError instanceof DOMException && loadError.name === "AbortError") {
        return;
      }
      setError(friendlyIdeaError(loadError));
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [attemptId, markerKey]);

  useEffect(() => {
    setSelection(null);
    setError("");
    setOpen(false);
    setLoading(false);

    let shouldRestore = false;
    try {
      shouldRestore = window.sessionStorage.getItem(markerKey) === "1";
    } catch {
      shouldRestore = false;
    }
    if (shouldRestore) void loadIdeas();

    return () => {
      requestRef.current += 1;
      abortRef.current?.abort();
    };
  }, [loadIdeas, markerKey]);

  function toggle() {
    if (loading) return;
    if (!selection) {
      void loadIdeas();
      return;
    }
    setOpen((current) => !current);
  }

  const expanded = open && (loading || Boolean(error) || Boolean(selection));

  return (
    <section
      className={`shrink-0 overflow-hidden rounded-2xl border border-student-primary-border bg-white text-student-text shadow-[0_1px_2px_rgba(23,32,51,0.025)] ${
        expanded ? "min-h-[52px]" : "h-[52px]"
      }`}
      data-testid="writing-idea-assistant"
    >
      <button
        aria-busy={loading}
        aria-expanded={expanded}
        className={`flex h-[52px] w-full items-center gap-2.5 px-4 text-left transition ${
          expanded ? "bg-student-primary-soft/55" : "bg-white hover:bg-student-primary-soft/40"
        }`}
        onClick={toggle}
        type="button"
      >
        <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[10px] bg-student-primary text-white shadow-[0_3px_10px_rgba(107,92,246,0.22)]">
          <Lightbulb aria-hidden="true" size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-bold leading-4 text-student-primary">
            写作思路助手
          </span>
          <span className="mt-0.5 block text-[11px] leading-[14px] text-student-muted">
            {loading
              ? "正在生成简短思路…"
              : selection
                ? `${taskType === "email" ? "邮件" : "讨论"}要点提示`
                : "需要灵感时再打开"}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-bold leading-4 text-student-primary">
          {loading ? (
            <Loader2 aria-hidden="true" className="animate-spin" size={14} />
          ) : selection ? (
            open ? (
              <ChevronUp aria-hidden="true" size={16} />
            ) : (
              <ChevronDown aria-hidden="true" size={16} />
            )
          ) : (
            <>
              <Sparkles aria-hidden="true" size={13} />
              获取思路
            </>
          )}
        </span>
      </button>

      {expanded ? (
        <div
          aria-live="polite"
          className="border-t border-student-primary-border/60 px-4 py-3"
          style={{ maxHeight: "min(42vh, 420px)", overflowY: "auto" }}
        >
          {loading ? (
            <div className="grid gap-2.5" data-testid="writing-idea-loading">
              <p className="text-[13px] font-semibold text-student-primary">
                正在结合题目生成思路…
              </p>
              {[86, 72, 64].map((width) => (
                <span
                  className="block h-2.5 animate-pulse rounded-full bg-student-primary-soft"
                  key={width}
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          ) : error ? (
            <div className="flex flex-wrap items-center gap-2" data-testid="writing-idea-error">
              <p className="min-w-0 flex-1 text-[13px] leading-5 text-student-error">
                {error}
              </p>
              <button
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-student-primary-border bg-white px-3 text-xs font-bold text-student-primary transition hover:bg-student-primary-soft disabled:opacity-50"
                disabled={loading}
                onClick={() => void loadIdeas()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={13} />
                重试
              </button>
            </div>
          ) : selection ? (
            selection.task_type === "academic_discussion" ? (
              <AcademicIdeaSelectionView selection={selection} />
            ) : (
              <EmailIdeaSelectionView selection={selection} />
            )
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function AcademicIdeaSelectionView({
  selection
}: {
  selection: Extract<WritingIdeaSelection, { task_type: "academic_discussion" }>;
}) {
  return (
    <div className="grid gap-2.5" data-testid="writing-idea-academic">
      {selection.sides.map((side, index) => (
        <div
          className="rounded-xl border border-student-primary-border/70 bg-student-primary-soft/30 px-3 py-2.5"
          key={side.key}
        >
          <p className="text-[12px] font-bold text-student-primary">
            立场{index === 0 ? "一" : "二"}
          </p>
          <IdeaBulletList items={side.reasons} />
        </div>
      ))}
    </div>
  );
}

function EmailIdeaSelectionView({
  selection
}: {
  selection: Extract<WritingIdeaSelection, { task_type: "email" }>;
}) {
  return (
    <div className="grid gap-3" data-testid="writing-idea-email">
      {selection.requirements.map((requirement) => (
        <div key={requirement.index}>
          <p className="text-[12px] leading-4 text-student-muted">
            {requirement.index}. {requirement.requirement}
          </p>
          <IdeaBulletList items={requirement.details} />
        </div>
      ))}
    </div>
  );
}

function IdeaBulletList({ items }: { items: string[] }) {
  return (
    <ul className="mt-1.5 grid gap-1.5">
      {items.map((item) => (
        <li
          className="flex gap-2 text-[13px] leading-5 text-student-text"
          key={item}
        >
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-student-primary" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

function friendlyIdeaError(error: unknown) {
  if (isWritingSessionError(error)) return error.message;
  if (error instanceof Error) {
    if (/[\u3400-\u9fff]/.test(error.message)) return error.message;
    if (error.name === "AbortError") return "";
  }
  return "思路生成失败，请重试。";
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
