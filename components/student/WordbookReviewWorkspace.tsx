"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { reviewPercent, type ReviewItem, type ReviewOption, type ReviewState } from "@/lib/lexical/wordbookReview";
import styles from "./WordbookReviewWorkspace.module.css";
import { constrainReviewSpelling, insertReviewSpelling } from "@/lib/lexical/wordbookReviewInput";

const SETUP = "/student/wordbook/review";

/** One native input preserves keyboard, deletion, paste, selection and IME.
 * The overlay changes presentation only; the exact input value is submitted. */
export function LetterSpelling({ shape, value, onChange, disabled, onConfirm, feedback }: {
  shape: string; value: string; onChange: (value: string) => void; disabled: boolean; onConfirm: () => void; feedback?: "correct" | "wrong";
}) {
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false), [selection, setSelection] = useState({ start: value.length, end: value.length });
  const composing = useRef(false), compositionBase = useRef(value);
  const [compositionDraft, setCompositionDraft] = useState<string | null>(null);
  const pendingSelection = useRef<{ value: string; caret: number }>();
  const displayValue = compositionDraft ?? value;
  const typed = Array.from(displayValue), chars = Array.from(shape);
  const commit = (edit: { value: string; caret: number }) => {
    const node = input.current;
    if (node) { node.value = edit.value; node.setSelectionRange(edit.caret, edit.caret); }
    pendingSelection.current = edit; onChange(edit.value);
    setSelection({ start: edit.caret, end: edit.caret });
  };
  useLayoutEffect(() => {
    const edit = pendingSelection.current;
    if (edit && value === edit.value) { input.current?.setSelectionRange(edit.caret, edit.caret); pendingSelection.current = undefined; }
  }, [value, compositionDraft]);
  const select = () => { if (input.current) setSelection({ start: input.current.selectionStart ?? value.length, end: input.current.selectionEnd ?? value.length }); };
  const cursor = Array.from(displayValue.slice(0, selection.start)).length, end = Array.from(displayValue.slice(0, selection.end)).length;
  const slots = Array.from({ length: Math.max(chars.length, typed.length, focused ? cursor + 1 : 0) }, (_, key) => {
    const char = chars[key] ?? typed[key] ?? "";
    return <span key={key} data-slot={key} data-typed={Boolean(typed[key])} className={`relative inline-flex h-11 items-center justify-center text-2xl font-medium ${char === "_" ? "w-6 border-b-2 border-student-text/60 pb-1" : /\s/.test(char) ? "w-4" : "w-3"} ${key >= cursor && key < end ? styles.selectedLetter : ""}`}>
      {typed[key] ?? (char === "_" ? "\u00a0" : char)}{focused && !disabled && key === cursor ? <span data-caret className={styles.caret} /> : null}
    </span>;
  });
  return <div className={styles.spelling} data-feedback={feedback} onClick={event => {
    if (disabled) return;
    const node = input.current; if (!node) return; node.focus();
    // Do not collapse the browser's drag/double-click/long-press selection.
    if (event.detail > 1 || node.selectionStart !== node.selectionEnd) { select(); return; }
    const slots = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-slot]"));
    const hit = slots.find(s => { const r = s.getBoundingClientRect(); return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom; });
    if (hit) { const position = typed.slice(0, Number(hit.dataset.slot)).join("").length; node.setSelectionRange(position, position); }
    select();
  }}>
    <div aria-hidden="true" className="pointer-events-none flex min-w-0 flex-wrap justify-center gap-x-1.5 gap-y-2 pb-2">
      {slots}
    </div>
    <input ref={input} aria-label="英文拼写" value={displayValue} onChange={e => {
      if (composing.current || (e.nativeEvent as InputEvent).isComposing) { setCompositionDraft(e.target.value); select(); return; }
      const edit = constrainReviewSpelling(shape, value, e.target.value);
      if (edit.value !== e.target.value) commit(edit); else { onChange(edit.value); select(); }
    }} disabled={disabled}
      onBeforeInput={event => {
        const native = event.nativeEvent as InputEvent;
        if (composing.current || native.isComposing || typeof native.data !== "string" || !event.cancelable) return;
        const node = event.currentTarget;
        const start = node.selectionStart ?? value.length, end = node.selectionEnd ?? start;
        const edit = insertReviewSpelling(shape, value, start, end, native.data);
        if (edit.value !== value.slice(0, start) + native.data + value.slice(end)) { event.preventDefault(); commit(edit); }
      }}
      onPaste={event => {
        if (composing.current) return;
        event.preventDefault(); const node = event.currentTarget;
        const start = node.selectionStart ?? value.length;
        commit(insertReviewSpelling(shape, value, start, node.selectionEnd ?? start, event.clipboardData.getData("text")));
      }}
      onCompositionStart={event => { composing.current = true; compositionBase.current = value; setCompositionDraft(event.currentTarget.value); }}
      onCompositionEnd={event => {
        composing.current = false; const edit = constrainReviewSpelling(shape, compositionBase.current, event.currentTarget.value);
        setCompositionDraft(null); commit(edit);
      }}
      onFocus={() => { setFocused(true); select(); }} onBlur={() => setFocused(false)} onSelect={select} className={styles.nativeInput}
      autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={300}
      onKeyDown={event => { if (event.key === "Enter" && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.blur(); onConfirm(); } }} />
  </div>;
}

function Options({ item, selected, onChange, busy }: { item: ReviewItem; selected: string; onChange: (id: string) => void; busy: boolean }) {
  const choice = item.kind === "meaning_choice", answer = item.answer;
  const correctId = answer ? choice ? answer.correctOptionId : answer.pos : null;
  const tone = (option: ReviewOption) => option.id === correctId ? "correct" : answer && option.id === selected ? "wrong" : !answer && option.id === selected ? "correct" : "neutral";
  return <div role="radiogroup" aria-label={choice ? "中文语境义" : "词性"}
    className={choice ? "grid min-w-0 gap-3" : "flex min-w-0 flex-wrap justify-center gap-2"}>
    {item.options.map((option, index) => <button type="button" role="radio" aria-checked={selected === option.id}
      aria-label={`${option.label ?? option.text}${answer && !answer.correct && option.id === correctId ? "，正确答案" : ""}`}
      disabled={busy || Boolean(answer)} tabIndex={selected ? selected === option.id ? 0 : -1 : index === 0 ? 0 : -1} key={option.id}
      className={`flex min-w-0 max-w-full items-center justify-center rounded-lg border px-4 py-3 text-center text-base font-medium leading-relaxed [overflow-wrap:anywhere] ${tone(option) === "correct"
        ? "border-student-primary bg-student-primary-soft text-student-primary" : tone(option) === "wrong" ? styles.wrongOption : "border-student-border bg-white text-student-text"}`}
      onClick={() => onChange(option.id)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? item.options.length - 1
          : (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + item.options.length) % item.options.length;
        onChange(item.options[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }}>{option.label ?? option.text}</button>)}
  </div>;
}

function Example({ item }: { item: ReviewItem }) {
  return <p className="min-w-0 text-left text-base leading-7 [overflow-wrap:anywhere]">
    {item.example?.map((part, index) => part.target ? part.text
      ? <strong key={index} className="font-bold">{part.text}</strong>
      : <span key={index} aria-label="目标词已隐藏" className="mx-1 inline-block w-24 border-b-2 border-current align-baseline" />
      : <span key={index}>{part.text}</span>) ?? <span className="text-student-muted">暂无可用来源例句</span>}
  </p>;
}

/** Fit rather than scroll/truncate. All source text stays in the card, including
 * very long expressions/examples. ResizeObserver also reacts to font loading. */
function FitContent({ children, keyboard = false }: { children: ReactNode; keyboard?: boolean }) {
  const stage = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const outer = stage.current, inner = content.current;
    if (!outer || !inner) return;
    const fit = () => setScale(Math.min(1, outer.clientHeight / Math.max(1, inner.offsetHeight), outer.clientWidth / Math.max(1, inner.scrollWidth)));
    const observer = new ResizeObserver(fit); observer.observe(outer); observer.observe(inner); fit();
    return () => observer.disconnect();
  }, [keyboard]);
  // Keep the exact same input DOM while toggling keyboard layout. Reparenting
  // it here would blur Safari's input and immediately dismiss the keyboard.
  return <div ref={stage} className={keyboard ? "min-w-0 shrink-0 py-8" : "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden"}>
    <div ref={content} className={keyboard ? "w-full" : "absolute w-full"} style={keyboard ? undefined : { transform: `scale(${scale})`, transformOrigin: "center" }}>{children}</div>
  </div>;
}

function Result({ state, busy, onRetry, pending }: { state: ReviewState; busy: boolean; onRetry: () => void; pending: boolean }) {
  const s = state.summary;
  return <div data-review-persistence={pending ? "local" : "saved"} aria-label={pending ? "本轮本地结果，尚未全部保存" : "本轮已保存结果"} className="grid gap-8 text-center">
    <div><p className="text-sm text-student-muted">整体正确率</p><p className="mt-2 text-6xl font-bold text-student-primary">{reviewPercent(s.correct, state.session.total)}</p></div>
    <dl className="grid grid-cols-3 gap-3">{[["词条总数", state.session.total], ["答对", s.correct], ["答错", s.incorrect]].map(([label, value]) =>
      <div key={label}><dt className="text-sm text-student-muted">{label}</dt><dd className="mt-2 text-3xl font-semibold">{value}</dd></div>)}</dl>
    <dl className="grid gap-3 border-t border-student-border pt-6 text-sm">{[["拼写", s.spellingCorrect, s.spellingTotal], ["词性", s.posCorrect, s.posTotal], ["选择", s.choiceCorrect, s.choiceTotal]].map(([label, correct, total]) =>
      <div key={label} className="flex justify-between gap-3"><dt>{label}</dt><dd className="font-semibold">{correct}/{total} · {reviewPercent(Number(correct), Number(total))}</dd></div>)}</dl>
    <div className="grid gap-3 sm:grid-cols-3"><button type="button" className="student-button-primary h-11" disabled={busy || !s.incorrect} onClick={onRetry}>错词再练</button>
      <Link className="student-button-secondary h-11" href={SETUP}>新一轮复习</Link><Link className="student-button-secondary h-11" href={`${SETUP}/history`}>复习历史</Link></div>
  </div>;
}

export function WordbookReviewWorkspace({ state, busy, error, onAction, onRetry, onReload, pending = 0, syncError, onSyncRetry }: {
  state?: ReviewState; busy: boolean; error?: string;
  onAction: (action: string, answer?: unknown) => Promise<void>; onRetry: () => void; onReload: () => void;
  pending?: number; syncError?: string; onSyncRetry?: () => void;
}) {
  const [spelling, setSpelling] = useState(""), [selected, setSelected] = useState("");
  const [exampleOpen, setExampleOpen] = useState(false), [confirmSkip, setConfirmSkip] = useState(false);
  const [viewport, setViewport] = useState<{ height: number; top: number }>();
  const [keyboard, setKeyboard] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const skipButton = useRef<HTMLButtonElement>(null);
  const item = state?.item, phase = state?.flow?.phase;
  const wasConfirming = useRef(false);
  useEffect(() => { if (wasConfirming.current && !confirmSkip) skipButton.current?.focus(); wasConfirming.current = confirmSkip; }, [confirmSkip]);
  useLayoutEffect(() => { setSpelling(""); setSelected(""); setExampleOpen(false); setConfirmSkip(false); }, [item?.itemId, phase]);
  useEffect(() => {
    const bodyOverflow = document.body.style.overflow, htmlOverflow = document.documentElement.style.overflow;
    let baseline = window.innerHeight;
    const update = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      const focused = document.activeElement instanceof HTMLInputElement && workspace.current?.contains(document.activeElement);
      if (!focused) baseline = window.innerHeight;
      const open = Boolean(focused && Math.max(baseline, window.innerHeight, document.documentElement.clientHeight) - height > 120);
      setKeyboard(open); setViewport({ height, top: window.visualViewport?.offsetTop ?? 0 });
      document.body.style.overflow = open ? "hidden auto" : "hidden";
      document.documentElement.style.overflow = open ? "hidden auto" : "hidden";
    };
    update(); window.visualViewport?.addEventListener("resize", update); window.visualViewport?.addEventListener("scroll", update); window.addEventListener("resize", update);
    document.addEventListener("focusin", update); document.addEventListener("focusout", update);
    return () => { document.body.style.overflow = bodyOverflow; document.documentElement.style.overflow = htmlOverflow;
      window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update); window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update); document.removeEventListener("focusout", update); };
  }, []);
  const study = phase === "study", result = phase === "result", last = item?.position === state?.session.total;
  const progress = result ? state?.session.total ?? 0 : study ? item?.position ?? 0 : state?.session.answered ?? 0;
  return <section ref={workspace} aria-label="生词本复习" data-keyboard={keyboard} className={`${keyboard ? "relative min-h-screen overflow-x-hidden" : "fixed inset-x-0 top-0 h-[100dvh] overflow-hidden"} flex min-w-0 flex-col bg-white text-student-text ${state?.session.domain === "reading" ? "reading-theme" : ""}`}
    style={!keyboard && viewport ? { height: viewport.height, top: viewport.top } : undefined}>
    <div ref={node => { if (confirmSkip) node?.setAttribute("inert", ""); else node?.removeAttribute("inert"); }} aria-hidden={confirmSkip || undefined}
      className={`mx-auto flex ${keyboard ? "min-h-screen" : "h-full"} w-full max-w-3xl min-w-0 flex-col gap-4 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:gap-6 sm:px-10 sm:pb-8 sm:pt-6`}>
      <header className="flex shrink-0 items-center gap-4">
        <div role="progressbar" aria-label={study ? "单词复习进度" : "测试进度"} aria-valuemin={0} aria-valuemax={state?.session.total ?? 1} aria-valuenow={progress}
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-student-primary-soft">
          <div className="h-full rounded-full bg-student-primary transition-[width]" style={{ width: `${progress / (state?.session.total ?? 1) * 100}%` }} />
        </div>
        {study ? <button ref={skipButton} type="button" disabled={busy} className="shrink-0 text-sm text-student-primary hover:underline" onClick={() => setConfirmSkip(true)}>跳过复习</button> : null}
        {!result ? <Link href={`${SETUP}/history`} className="shrink-0 text-sm text-student-primary hover:underline">暂停</Link> : null}
      </header>
      <FitContent keyboard={keyboard}>{!state ? <div className="text-center">{!error ? "正在恢复复习…" : null}</div> : result ? <Result state={state} busy={busy || pending > 0} pending={pending > 0} onRetry={onRetry} /> : item ?
        <div className="grid min-w-0 gap-6 sm:gap-8">
          {study && item.study ? <>
            <div className="grid gap-3 text-center"><h1 className="text-4xl font-bold leading-tight [overflow-wrap:anywhere] sm:text-5xl">{item.study.expression}</h1>
              <p className="text-lg">{item.study.pos}</p><p className="text-2xl font-semibold leading-relaxed [overflow-wrap:anywhere] sm:text-3xl">{item.study.meaning}</p></div>
            <Example item={item} />
          </> : <>
            <div className="grid min-w-0 gap-3 text-center"><h1 className="text-3xl font-bold leading-relaxed [overflow-wrap:anywhere] sm:text-4xl">{item.prompt}</h1>
              <button type="button" aria-expanded={exampleOpen} className="justify-self-center text-sm text-student-primary hover:underline" onClick={() => setExampleOpen(v => !v)}>例句</button>
              {exampleOpen ? <Example item={item} /> : null}</div>
            {item.kind === "spelling_pos" ? <div className="grid gap-3">
              <LetterSpelling shape={item.spellingShape ?? ""} value={item.answer?.student.spelling ?? spelling} onChange={setSpelling} disabled={busy || Boolean(item.answer)}
                feedback={item.answer && item.answer.student.spelling ? item.answer.assessments.spelling ? "correct" : "wrong" : undefined}
                onConfirm={() => void onAction("answer", { spelling, pos: selected })} />
              {item.answer && !item.answer.assessments.spelling ? <p className="text-center text-lg font-semibold text-student-primary [overflow-wrap:anywhere]">{item.answer.expression}</p> : null}
            </div> : null}
            <Options item={item} selected={item.answer?.student.pos ?? item.answer?.student.optionId ?? selected} onChange={setSelected} busy={busy} />
          </>}
        </div> : null}</FitContent>
      {error ? <div role="alert" className="shrink-0 text-center text-sm text-student-error [overflow-wrap:anywhere]">{error}
         <button type="button" disabled={busy} className="ml-3 text-student-primary underline" onClick={onReload}>重试</button></div> : null}
       <div data-sync-slot className={styles.syncSlot}>
         {pending > 0 && syncError ? <div role="status" className={styles.syncNotice}>
           <span>{syncError}</span>{onSyncRetry ? <button type="button" onClick={onSyncRetry}>重试同步</button> : null}
         </div> : null}
       </div>
      {!result && item ? <footer className="grid shrink-0 gap-3">
        {study ? <div className={`grid gap-3 ${last ? "grid-cols-2" : "grid-cols-1"}`}>
          {last ? <button type="button" disabled={busy} className="student-button-secondary h-11" onClick={() => void onAction("repeat")}>再看一遍</button> : null}
          <button type="button" disabled={busy} className="student-button-primary h-11" onClick={() => void onAction(last ? "start_test" : "study_next")}>{last ? "开始测试" : "下一个"}</button>
        </div> : <button type="button" disabled={busy || Boolean(item.answer?.correct)} className="student-button-primary h-11 w-full" onClick={() => {
          (document.activeElement as HTMLElement)?.blur();
          void onAction(item.answer ? "advance" : "answer", item.answer ? undefined : item.kind === "spelling_pos" ? { spelling, pos: selected } : { optionId: selected });
        }}>{item.answer?.correct ? last ? "即将查看结果" : "即将进入下一题" : item.answer ? "下一个" : "确定"}</button>}
      </footer> : null}
    </div>
    {confirmSkip ? <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/95 px-6" onKeyDown={e => {
      if (e.key === "Escape") { setConfirmSkip(false); skipButton.current?.focus(); }
      if (e.key === "Tab") {
        const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const next = (buttons.indexOf(document.activeElement as HTMLButtonElement) + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        e.preventDefault(); buttons[next]?.focus();
      }
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="skip-title" className="grid w-full max-w-sm gap-6">
        <h2 id="skip-title" className="text-center text-xl font-semibold">确定直接开始测试吗？</h2>
        <div className="grid grid-cols-2 gap-3"><button type="button" autoFocus className="student-button-secondary" onClick={() => { setConfirmSkip(false); skipButton.current?.focus(); }}>取消</button>
          <button type="button" disabled={busy} className="student-button-primary" onClick={() => { setConfirmSkip(false); void onAction("start_test"); }}>确定</button></div>
      </div>
    </div> : null}
  </section>;
}
