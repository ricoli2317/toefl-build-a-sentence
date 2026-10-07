"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { CanonicalLexicalSourceType } from "@/lib/lexical/types";
import type { LexicalAccess, LexicalLookupRequest, LexicalLookupResult } from "@/lib/lexical/lookup";
import { parseLookupRequest } from "@/lib/lexical/lookup";
import { domLexicalSelection } from "@/lib/lexical/selection";

type Span = Pick<LexicalLookupRequest, "startOffset" | "endOffset" | "selectedText" | "blockText">;
const Context = createContext<{ lookup: (blockId: string, selection: Span) => void; close: () => void } | null>(null);
export const useLexicalLookup = () => useContext(Context);
export function lexicalBlockAttributes(blockId: string, blockText?: string, baseOffset = 0) {
  return { "data-lexical-block": blockId, "data-lexical-text": blockText, "data-lexical-offset": baseOffset };
}
export function LexicalText({ blockId, text }: { blockId: string; text: string }) {
  return <span {...lexicalBlockAttributes(blockId)}>{text}</span>;
}

export function LexicalLookupProvider({ access, sourceType, sourceItemId, enabled = true, children }: {
  access?: LexicalAccess; sourceType: CanonicalLexicalSourceType; sourceItemId?: string; enabled?: boolean; children: ReactNode;
}) {
  const [state, setState] = useState<{ selected: string; result?: LexicalLookupResult; loading?: boolean; error?: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const region = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => { abort.current?.abort(); setState(null); }, []);
  const lookup = useCallback((contentBlockId: string, span: Span) => {
    if (!enabled || !access) return;
    abort.current?.abort();
    const request = { access, sourceType, sourceItemId, contentBlockId, ...span } satisfies LexicalLookupRequest;
    if (!parseLookupRequest(request)) {
      setState({ selected: span.selectedText, result: { status: "unmatched" } });
      return;
    }
    const controller = new AbortController(); abort.current = controller;
    setState({ selected: span.selectedText, loading: true });
    void (async () => {
      try {
        const { data: { session } } = await createBrowserSupabase().auth.getSession();
        if (!session) throw new Error("请先登录。");
        const response = await fetch("/api/lexical/lookup", { method: "POST", cache: "no-store", signal: controller.signal,
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify(request) });
        const result = await response.json();
        if (!response.ok) throw new Error(response.status === 403 || response.status === 409 ? "当前页面不可查词。" : "查词暂时不可用。");
        if (!controller.signal.aborted) setState({ selected: span.selectedText, result });
      } catch (error) {
        if (!controller.signal.aborted) setState({ selected: span.selectedText, error: error instanceof Error ? error.message : "查词暂时不可用。" });
      }
    })();
  }, [access, enabled, sourceItemId, sourceType]);
  const identity = `${access?.kind}:${access?.attemptId}:${access?.questionId}:${access?.setId}:${sourceType}:${sourceItemId}`;
  useEffect(() => { close(); return () => abort.current?.abort(); }, [close, enabled, identity]);
  useEffect(() => {
    if (!state) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const cleared = () => { if (window.getSelection()?.isCollapsed) close(); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("selectionchange", cleared);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); document.removeEventListener("selectionchange", cleared); };
  }, [close, state]);
  const capture = (target?: EventTarget | null) => {
    if (!enabled || !access) return;
    if (target instanceof Element && !target.closest("[data-lexical-block]")) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const element = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-lexical-block]");
    const start = element(range.startContainer); const end = element(range.endContainer);
    if (!start || !end || !region.current?.contains(start) || !region.current.contains(end)) return;
    if (!start || !end || start.dataset.lexicalBlock !== end.dataset.lexicalBlock) { close(); return; }
    const blockText = start.dataset.lexicalText ?? start.textContent ?? "";
    if (start === end) {
      const span = domLexicalSelection(start, range);
      if (!span) return;
      const base = Number(start.dataset.lexicalOffset ?? 0);
      lookup(start.dataset.lexicalBlock!, { ...span, blockText, startOffset: span.startOffset + base, endOffset: span.endOffset + base });
    } else {
      // RAP spans may be separated by insertion markers, but both endpoints retain canonical offsets.
      if (end.dataset.lexicalText !== blockText) { close(); return; }
      const a = range.cloneRange(); a.setEnd(start, start.childNodes.length);
      const b = range.cloneRange(); b.setStart(end, 0);
      const left = domLexicalSelection(start, a); const right = domLexicalSelection(end, b);
      if (!left || !right) return;
      const startOffset = Number(start.dataset.lexicalOffset ?? 0) + left.startOffset;
      const endOffset = Number(end.dataset.lexicalOffset ?? 0) + right.endOffset;
      lookup(start.dataset.lexicalBlock!, { blockText, startOffset, endOffset, selectedText: blockText.slice(startOffset, endOffset) });
    }
  };
  return (
    <Context.Provider value={enabled && access ? { lookup, close } : null}>
      <div ref={region} className="contents" data-lexical-enabled={enabled && access ? "true" : "false"}
        onPointerUp={(e) => capture(e.target)} onKeyUp={(e) => { if (e.shiftKey) capture(e.target); }}>
        {children}
      </div>
      {state ? <div ref={panel} data-testid="lexical-lookup-card" role="dialog" aria-label="语境查词"
        className="fixed bottom-6 left-1/2 z-[80] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-xl border border-student-primary-border bg-white p-4 text-sm text-student-text shadow-xl">
        <button type="button" className="float-right px-2 text-student-muted" aria-label="关闭查词" onClick={close}>×</button>
        <LexicalLookupCard state={state} />
      </div> : null}
    </Context.Provider>
  );
}
export function LexicalLookupCard({ state }: { state: { selected: string; result?: LexicalLookupResult; loading?: boolean; error?: string } }) {
  const matched = state.result?.status === "matched" ? state.result : null;
  return <div aria-live="polite">
    <p className="pr-6 text-lg font-bold">{matched?.entry.canonical_expression ?? state.selected}</p>
    {matched ? <>
      {matched.entry.canonical_expression !== matched.occurrence.surface_text ? <p className="mt-1 text-xs text-student-muted">{matched.occurrence.surface_text}</p> : null}
      <p className="mt-2 text-xs font-semibold text-student-primary">{matched.occurrence.context_pos}</p>
      <p className="mt-2 leading-6">{matched.occurrence.context_meaning_zh}</p>
      <p className="mt-2 leading-6 text-student-muted">{matched.occurrence.context_definition_en}</p>
    </> : <p className="mt-2 leading-6 text-student-muted" role="status">{state.loading ? "正在查词…" : state.error
      ?? (state.result?.status === "unmatched" ? "未找到对应词条，请重新选择完整单词或短语。" : "此文本暂不可查词。")}</p>}
  </div>;
}
