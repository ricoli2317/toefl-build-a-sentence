"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createBrowserSupabase } from "@/lib/supabase/client";
import type { CanonicalLexicalSourceType } from "@/lib/lexical/types";
import type { LexicalAccess, LexicalLookupRequest, LexicalLookupResult } from "@/lib/lexical/lookup";
import { parseLookupRequest } from "@/lib/lexical/lookup";
import { domCanonicalLexicalSelection } from "@/lib/lexical/selection";
import { lexicalPopupPosition, lexicalRangeRect, type LexicalRect } from "@/lib/lexical/position";
import { Check, Plus, X } from "lucide-react";

type Span = Pick<LexicalLookupRequest, "startOffset" | "endOffset" | "selectedText" | "blockText" | "ctwAnchor">;
type Anchor = { rect: () => LexicalRect | null; range?: Range };
type LookupState = { selected: string; result?: LexicalLookupResult; loading?: boolean; error?: string;
  wordbookBusy?: boolean; wordbookMessage?: string; wordbookError?: string };
const Context = createContext<{ lookup: (blockId: string, selection: Span, rect?: () => LexicalRect | null) => void; close: () => void } | null>(null);
export const useLexicalLookup = () => useContext(Context);
export function lexicalBlockAttributes(blockId: string, blockText?: string, baseOffset = 0, ctwAnchor?: LexicalLookupRequest["ctwAnchor"]) {
  return { "data-lexical-block": blockId, "data-lexical-text": blockText, "data-lexical-offset": baseOffset,
    "data-lexical-ctw-anchor": ctwAnchor ? JSON.stringify(ctwAnchor) : undefined };
}
export function LexicalText({ blockId, text }: { blockId: string; text: string }) {
  return <span {...lexicalBlockAttributes(blockId)}>{text}</span>;
}

export function LexicalLookupProvider({ access, sourceType, sourceItemId, enabled = true, children }: {
  access?: LexicalAccess; sourceType: CanonicalLexicalSourceType; sourceItemId?: string; enabled?: boolean; children: ReactNode;
}) {
  const [state, setState] = useState<LookupState | null>(null);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<ReturnType<typeof lexicalPopupPosition> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const region = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<Anchor | null>(null);
  const currentRequest = useRef<LexicalLookupRequest | null>(null);
  const mutationBusy = useRef(false);
  const revision = useRef(0);
  const close = useCallback(() => { revision.current++; abort.current?.abort(); anchor.current = null; currentRequest.current = null; setState(null); setPosition(null); }, []);
  const runLookup = useCallback((request: LexicalLookupRequest) => {
    if (!enabled || !access) return;
    revision.current++;
    currentRequest.current = request;
    abort.current?.abort();
    if (!parseLookupRequest(request)) {
      setState({ selected: request.selectedText, result: { status: "unmatched" } });
      return;
    }
    const controller = new AbortController(); abort.current = controller;
    setState({ selected: request.selectedText, loading: true });
    void (async () => {
      try {
        const { data: { session } } = await createBrowserSupabase().auth.getSession();
        if (controller.signal.aborted) return;
        if (!session) throw new Error("请先登录。");
        const response = await fetch("/api/lexical/lookup", { method: "POST", cache: "no-store", signal: controller.signal,
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify(request) });
        const result = await response.json();
        if (!response.ok) throw new Error(response.status === 403 || response.status === 409 ? "当前页面不可查词。" : "查词暂时不可用。");
        if (!controller.signal.aborted) setState({ selected: request.selectedText, result });
      } catch (error) {
        if (!controller.signal.aborted) setState({ selected: request.selectedText, error: error instanceof Error ? error.message : "查词暂时不可用。" });
      }
    })();
  }, [access, enabled]);
  const lookup = useCallback((contentBlockId: string, span: Span, rect?: () => LexicalRect | null) => {
    if (!enabled || !access) return;
    const selection = window.getSelection();
    const range = !rect && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
    if (!rect && !range) { close(); return; }
    anchor.current = { rect: rect ?? (() => range ? lexicalRangeRect(range) : null), range };
    setPosition(null);
    setQuery(span.selectedText);
    const request = { access, sourceType, sourceItemId, contentBlockId, ...span } satisfies LexicalLookupRequest;
    currentRequest.current = request;
    runLookup(request);
  }, [access, enabled, sourceItemId, sourceType, runLookup, close]);
  const reposition = useCallback(() => {
    const saved = anchor.current; const card = panel.current;
    if (!saved || !card) return;
    if (saved.range && (!region.current?.contains(saved.range.startContainer) || !region.current.contains(saved.range.endContainer))) { close(); return; }
    const rect = saved.rect(); const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth; const height = viewport?.height ?? window.innerHeight;
    const left = viewport?.offsetLeft ?? 0; const top = viewport?.offsetTop ?? 0;
    if (!rect || rect.right <= left || rect.left >= left + width || rect.bottom <= top || rect.top >= top + height) { close(); return; }
    const next = lexicalPopupPosition(rect, { width: Math.min(448, width - 16), height: card.scrollHeight + card.offsetHeight - card.clientHeight },
      { width, height: Math.max(0, height - 12), left, top: top + 12 }); // Reserve space above the overlapping close button.
    setPosition(next);
  }, [close]);
  useLayoutEffect(() => { if (state) reposition(); }, [state, query, reposition]);
  const open = state !== null;
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      window.removeEventListener("scroll", reposition, true); window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition); window.visualViewport?.removeEventListener("scroll", reposition);
      observer?.disconnect();
    };
  }, [open, reposition]);
  const identity = `${access?.kind}:${access?.attemptId}:${access?.questionId}:${access?.setId}:${sourceType}:${sourceItemId}`;
  useEffect(() => { close(); return () => abort.current?.abort(); }, [close, enabled, identity]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !panel.current?.contains(event.target)) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    const cleared = () => {
      if (panel.current?.contains(document.activeElement)) return;
      // RDL selections use the verified image hitboxes, not a DOM Range.
      if (anchor.current?.range && window.getSelection()?.isCollapsed) close();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("selectionchange", cleared);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); document.removeEventListener("selectionchange", cleared); };
  }, [close, open]);
  const capture = (target?: EventTarget | null) => {
    if (!enabled || !access) return;
    if (target instanceof Node && panel.current?.contains(target)) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const span = region.current ? domCanonicalLexicalSelection(region.current, range) : null;
    if (!span) { close(); return; }
    const { contentBlockId, ...selectionSpan } = span;
    lookup(contentBlockId, selectionSpan);
  };
  const toggleWordbook = async () => {
    const result = state?.result;
    const selection = currentRequest.current;
    if (!enabled || !selection || result?.status !== "matched" || mutationBusy.current) return;
    mutationBusy.current = true;
    const version = revision.current;
    const update = (patch: Partial<LookupState>) => {
      if (revision.current === version) setState(previous => previous ? { ...previous, ...patch } : previous);
    };
    update({ wordbookBusy: true, wordbookMessage: undefined, wordbookError: undefined });
    try {
      const { data: { session } } = await createBrowserSupabase().auth.getSession();
      if (!session) throw new Error("请先登录。");
      const send = async (action: "status" | "save" | "remove") => {
        const response = await fetch("/api/lexical/wordbook", { method: "POST", cache: "no-store",
          headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ action, selection, entryId: result.entry.entry_id, occurrenceId: result.occurrence.occurrence_id }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "生词本暂时不可用，请稍后重试。");
        return data;
      };
      // If the optional lookup status failed, refresh before choosing the action.
      const status = result.wordbook?.available ? result.wordbook : await send("status");
      try {
        const wordbook = await send(status.saved ? "remove" : "save");
        update({ result: { ...result, wordbook }, wordbookMessage: wordbook.saved ? "已加入生词本。" : "已取消收藏。" });
      } catch (error) {
        // A dropped response might have committed. Reconcile, never blindly toggle again.
        try { update({ result: { ...result, wordbook: await send("status") } }); }
        catch { update({ result: { ...result, wordbook: { available: false } } }); }
        throw error;
      }
    } catch (error) { update({ wordbookError: error instanceof Error ? error.message : "操作未确认，请稍后重试。" }); }
    finally { mutationBusy.current = false; update({ wordbookBusy: false }); }
  };
  return (
    <Context.Provider value={enabled && access ? { lookup, close } : null}>
      <div ref={region} className="contents" data-lexical-enabled={enabled && access ? "true" : "false"}
        onPointerUp={(e) => capture(e.target)} onKeyUp={(e) => { if (e.shiftKey) capture(e.target); }}>
        {children}
      </div>
      {state ? <div ref={panel} data-testid="lexical-lookup-card" role="dialog" aria-label="语境查词"
        className="fixed z-[80] w-[min(28rem,calc(100vw-2rem))] overflow-visible rounded-xl border border-student-primary-border bg-white text-sm text-student-text shadow-xl"
        style={{ left: position?.left ?? 0, top: position?.top ?? 0, width: position?.width, maxHeight: position?.maxHeight ?? "calc(100dvh - 16px)", visibility: position ? "visible" : "hidden" }}
        data-placement={position?.placement}>
        <button type="button" className="absolute -right-2 -top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-student-border bg-white text-student-muted shadow-sm transition hover:border-student-primary hover:text-student-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-student-primary active:bg-student-primary-soft"
          aria-label="关闭查词" onClick={close}><X aria-hidden="true" size={15} strokeWidth={2.5} /></button>
        <div className="overflow-y-auto rounded-xl p-4" style={{ maxHeight: position?.maxHeight ?? "calc(100dvh - 16px)" }}>
          <LexicalLookupCard state={state} query={query} onQueryChange={(value) => {
            revision.current++; abort.current?.abort(); setQuery(value); setState({ selected: state.selected });
          }} onSearch={() => { if (currentRequest.current) runLookup({ ...currentRequest.current, query }); }} onWordbookToggle={toggleWordbook} />
        </div>
      </div> : null}
    </Context.Provider>
  );
}
export function LexicalLookupCard({ state, query = state.selected, onQueryChange, onSearch, onWordbookToggle }: {
  state: LookupState; query?: string; onQueryChange?: (query: string) => void; onSearch?: () => void; onWordbookToggle?: () => void;
}) {
  const matched = state.result?.status === "matched" ? state.result : null;
  return <div aria-live="polite">
    <form className="mb-3 flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); onSearch?.(); }}>
      <input aria-label="Lookup query" className="min-w-0 flex-1 rounded-lg border border-student-border bg-white px-3 py-2 text-sm text-student-text outline-none focus:border-student-primary focus:ring-2 focus:ring-student-primary-soft"
        value={query} onChange={(event) => onQueryChange?.(event.target.value)} maxLength={240} />
      <button className="student-button-primary shrink-0" disabled={!query.trim()} type="submit">Look Up</button>
    </form>
    {matched ? <div className="flex items-center gap-2">
      <p className="min-w-0 break-words text-lg font-bold">{matched.entry.canonical_expression}</p>
      {onWordbookToggle ? <button type="button" onClick={onWordbookToggle} disabled={state.wordbookBusy}
        aria-pressed={Boolean(matched.wordbook?.saved)} title={matched.wordbook?.saved ? "点击取消当前科目的收藏" : "加入当前科目的生词本"}
        className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg border border-student-primary-border bg-student-primary-soft px-2.5 py-1 text-xs font-semibold text-student-primary transition hover:border-student-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-student-primary active:bg-white disabled:cursor-wait disabled:opacity-60">
        {state.wordbookBusy ? <span aria-hidden="true">…</span> : matched.wordbook?.saved
          ? <Check aria-hidden="true" className="shrink-0 text-student-primary" size={14} strokeWidth={2.2} />
          : <Plus aria-hidden="true" className="shrink-0 text-student-primary" size={14} strokeWidth={2.2} />}
        {state.wordbookBusy ? "处理中…" : matched.wordbook?.saved ? "已加入 · 取消收藏" : "加入生词本"}
      </button> : null}
    </div> : null}
    {state.wordbookError || state.wordbookMessage ? <p className={`mt-2 text-xs ${state.wordbookError ? "text-student-error" : "text-student-primary"}`} role="status">{state.wordbookError ?? state.wordbookMessage}</p> : null}
    {matched ? <>
      {matched.entry.canonical_expression !== matched.occurrence.surface_text ? <p className="mt-1 text-xs text-student-muted">{matched.occurrence.surface_text}</p> : null}
      <p className="mt-2 text-xs font-semibold text-student-primary">{matched.occurrence.context_pos}</p>
      <p className="mt-2 leading-6">{matched.occurrence.context_meaning_zh}</p>
      <p className="mt-2 leading-6 text-student-muted">{matched.occurrence.context_definition_en}</p>
      {matched.containingPhrases?.length ? <section className="mt-3 border-t border-student-primary-border pt-3" aria-label="所在短语">
        <p className="text-xs font-semibold text-student-primary">所在短语</p>
        {matched.containingPhrases.map(phrase => <div className="mt-2" key={phrase.occurrence.occurrence_id}>
          <p className="font-bold">{phrase.entry.canonical_expression}</p>
          <p className="mt-1 leading-6">{phrase.occurrence.context_meaning_zh}</p>
          {phrase.occurrence.context_definition_en ? <p className="mt-1 leading-6 text-student-muted">{phrase.occurrence.context_definition_en}</p> : null}
        </div>)}
      </section> : null}
    </> : <p className="mt-2 leading-6 text-student-muted" role="status">{state.loading ? "正在查词…" : state.error
      ?? (state.result?.status === "unmatched" ? "未找到对应词条，请重新选择完整单词或短语。" : state.result?.status === "unavailable"
        ? "此文本暂不可查词。" : "按 Enter 或 Look Up 重新查词。")}</p>}
  </div>;
}
