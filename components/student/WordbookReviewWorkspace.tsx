"use client";

import Link from "next/link";
import { Check, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { reviewPercent, type ReviewItem, type ReviewOption, type ReviewState } from "@/lib/lexical/wordbookReview";

const SETUP = "/student/wordbook/review";

/** One native input preserves keyboard, deletion, paste, selection and IME.
 * The overlay changes presentation only; the exact input value is submitted. */
export function LetterSpelling({ shape, value, onChange, disabled, onConfirm }: {
  shape: string; value: string; onChange: (value: string) => void; disabled: boolean; onConfirm: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const typed = Array.from(value.trimStart().replace(/\s+/g, " "));
  const slots = Array.from(shape).map((char, key) => char === "_"
    ? <span key={key} className="inline-flex h-11 w-6 items-center justify-center border-b-2 border-student-text/60 pb-1 text-2xl font-medium">{typed[key] ?? "\u00a0"}</span>
    : <span key={key} className={`inline-flex h-11 items-center justify-center text-2xl ${/\s/.test(char) ? "w-4" : "w-3"} ${typed[key] && typed[key] !== char ? "text-student-error" : ""}`}>{typed[key] ?? char}</span>);
  return <div className="relative min-w-0 rounded-sm focus-within:ring-2 focus-within:ring-student-primary/30" onClick={() => input.current?.focus()}>
    <div aria-hidden="true" className="flex min-w-0 flex-wrap justify-center gap-x-1.5 gap-y-2 pb-2">
      {slots}{typed.slice(Array.from(shape).length).map((char, key) => <span key={`extra-${key}`} className="inline-flex h-11 w-6 items-center justify-center border-b-2 border-student-error text-2xl">{char}</span>)}
    </div>
    <input ref={input} aria-label="英文拼写" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}
      className="absolute inset-0 h-full w-full min-w-0 cursor-text opacity-0 text-base"
      autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={300}
      onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.blur(); onConfirm(); } }} />
  </div>;
}

function Options({ item, selected, onChange, busy }: { item: ReviewItem; selected: string; onChange: (id: string) => void; busy: boolean }) {
  const choice = item.kind === "meaning_choice", answer = item.answer;
  const highlighted = (option: ReviewOption) => answer && !answer.correct && choice ? option.id === answer.correctOptionId : option.id === selected;
  return <div role="radiogroup" aria-label={choice ? "中文语境义" : "词性"}
    className={choice ? "grid min-w-0 gap-3" : "flex min-w-0 flex-wrap justify-center gap-2"}>
    {item.options.map((option, index) => <button type="button" role="radio" aria-checked={selected === option.id}
      aria-label={`${option.label ?? option.text}${answer && !answer.correct && option.id === answer.correctOptionId ? "，正确答案" : ""}`}
      disabled={busy || Boolean(answer)} tabIndex={selected ? selected === option.id ? 0 : -1 : index === 0 ? 0 : -1} key={option.id}
      className={`min-w-0 max-w-full rounded-lg border px-4 py-3 text-base font-medium leading-relaxed [overflow-wrap:anywhere] ${choice ? "text-left" : "text-center"} ${highlighted(option)
        ? "border-student-primary bg-student-primary-soft text-student-primary" : "border-student-border bg-white text-student-text"}`}
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
function FitContent({ children }: { children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const outer = stage.current, inner = content.current;
    if (!outer || !inner) return;
    const fit = () => setScale(Math.min(1, outer.clientHeight / Math.max(1, inner.offsetHeight), outer.clientWidth / Math.max(1, inner.scrollWidth)));
    const observer = new ResizeObserver(fit); observer.observe(outer); observer.observe(inner); fit();
    return () => observer.disconnect();
  }, []);
  return <div ref={stage} className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden">
    <div ref={content} className="absolute w-full" style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>{children}</div>
  </div>;
}

function Result({ state, busy, onRetry }: { state: ReviewState; busy: boolean; onRetry: () => void }) {
  const s = state.summary;
  return <div className="grid gap-8 text-center">
    <div><p className="text-sm text-student-muted">整体正确率</p><p className="mt-2 text-6xl font-bold text-student-primary">{reviewPercent(s.correct, state.session.total)}</p></div>
    <dl className="grid grid-cols-3 gap-3">{[["词条总数", state.session.total], ["答对", s.correct], ["答错", s.incorrect]].map(([label, value]) =>
      <div key={label}><dt className="text-sm text-student-muted">{label}</dt><dd className="mt-2 text-3xl font-semibold">{value}</dd></div>)}</dl>
    <dl className="grid gap-3 border-t border-student-border pt-6 text-sm">{[["拼写", s.spellingCorrect, s.spellingTotal], ["词性", s.posCorrect, s.posTotal], ["选择", s.choiceCorrect, s.choiceTotal]].map(([label, correct, total]) =>
      <div key={label} className="flex justify-between gap-3"><dt>{label}</dt><dd className="font-semibold">{correct}/{total} · {reviewPercent(Number(correct), Number(total))}</dd></div>)}</dl>
    <div className="grid gap-3 sm:grid-cols-3"><button type="button" className="student-button-primary" disabled={busy || !s.incorrect} onClick={onRetry}>错词再练</button>
      <Link className="student-button-secondary" href={SETUP}>新一轮复习</Link><Link className="student-button-secondary" href={`${SETUP}/history`}>复习历史</Link></div>
  </div>;
}

export function WordbookReviewWorkspace({ state, busy, error, onAction, onRetry, onReload }: {
  state?: ReviewState; busy: boolean; error?: string;
  onAction: (action: string, answer?: unknown) => Promise<void>; onRetry: () => void; onReload: () => void;
}) {
  const [spelling, setSpelling] = useState(""), [selected, setSelected] = useState("");
  const [exampleOpen, setExampleOpen] = useState(false), [confirmSkip, setConfirmSkip] = useState(false);
  const [viewport, setViewport] = useState<{ height: number; top: number }>();
  const skipButton = useRef<HTMLButtonElement>(null);
  const item = state?.item, phase = state?.flow?.phase;
  const wasConfirming = useRef(false);
  useEffect(() => { if (wasConfirming.current && !confirmSkip) skipButton.current?.focus(); wasConfirming.current = confirmSkip; }, [confirmSkip]);
  useEffect(() => { setSpelling(""); setSelected(""); setExampleOpen(false); setConfirmSkip(false); }, [item?.itemId, phase]);
  useEffect(() => {
    const bodyOverflow = document.body.style.overflow, htmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden"; document.documentElement.style.overflow = "hidden";
    const update = () => setViewport({ height: window.visualViewport?.height ?? window.innerHeight, top: window.visualViewport?.offsetTop ?? 0 });
    update(); window.visualViewport?.addEventListener("resize", update); window.visualViewport?.addEventListener("scroll", update); window.addEventListener("resize", update);
    return () => { document.body.style.overflow = bodyOverflow; document.documentElement.style.overflow = htmlOverflow;
      window.visualViewport?.removeEventListener("resize", update); window.visualViewport?.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);
  const study = phase === "study", result = phase === "result", last = item?.position === state?.session.total;
  const progress = result ? state?.session.total ?? 0 : study ? item?.position ?? 0 : state?.session.answered ?? 0;
  return <section aria-label="生词本复习" className={`fixed inset-x-0 top-0 flex h-[100dvh] min-w-0 flex-col overflow-hidden bg-white text-student-text ${state?.session.domain === "reading" ? "reading-theme" : ""}`}
    style={viewport ? { height: viewport.height, top: viewport.top } : undefined}>
    <div ref={node => { if (confirmSkip) node?.setAttribute("inert", ""); else node?.removeAttribute("inert"); }} aria-hidden={confirmSkip || undefined}
      className="mx-auto flex h-full w-full max-w-3xl min-w-0 flex-col gap-4 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:gap-6 sm:px-10 sm:pb-8 sm:pt-6">
      <header className="flex shrink-0 items-center gap-4">
        <div role="progressbar" aria-label={study ? "单词复习进度" : "测试进度"} aria-valuemin={0} aria-valuemax={state?.session.total ?? 1} aria-valuenow={progress}
          className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-student-primary-soft">
          <div className="h-full rounded-full bg-student-primary transition-[width]" style={{ width: `${progress / (state?.session.total ?? 1) * 100}%` }} />
        </div>
        {study ? <button ref={skipButton} type="button" disabled={busy} className="shrink-0 text-sm text-student-primary hover:underline" onClick={() => setConfirmSkip(true)}>跳过复习</button> : null}
        {!result ? <Link href={`${SETUP}/history`} className="shrink-0 text-sm text-student-primary hover:underline">暂停</Link> : null}
      </header>
      <FitContent>{!state ? <div className="text-center">{!error ? "正在恢复复习…" : null}</div> : result ? <Result state={state} busy={busy} onRetry={onRetry} /> : item ?
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
                onConfirm={() => void onAction("answer", { spelling, pos: selected })} />
              {item.answer && !item.answer.correct ? <div className="text-center text-lg font-semibold text-student-primary [overflow-wrap:anywhere]">
                <p>{item.answer.expression}</p>{!item.answer.assessments.pos ? <p className="mt-1">{item.options.find(o => o.id === item.answer?.pos)?.label ?? item.answer.standardPos}</p> : null}</div> : null}
            </div> : null}
            <Options item={item} selected={item.answer?.student.pos ?? item.answer?.student.optionId ?? selected} onChange={setSelected} busy={busy} />
          </>}
        </div> : null}</FitContent>
      {error ? <div role="alert" className="shrink-0 text-center text-sm text-student-error [overflow-wrap:anywhere]">{error}
        <button type="button" disabled={busy} className="ml-3 text-student-primary underline" onClick={() => item?.answer?.correct ? void onAction("advance") : onReload()}>重试</button></div> : null}
      {!result && item ? <footer className="grid shrink-0 gap-3">
        <div role="status" className="flex h-8 items-center justify-center">
          {!study && item.answer ? item.answer.correct ? <Check size={30} strokeWidth={3} className="text-green-600" aria-label="正确" /> : <X size={30} strokeWidth={3} className="text-red-600" aria-label="错误" /> : null}
        </div>
        {study ? <div className={`grid gap-3 ${last ? "grid-cols-2" : "grid-cols-1"}`}>
          {last ? <button type="button" disabled={busy} className="student-button-secondary" onClick={() => void onAction("repeat")}>再看一遍</button> : null}
          <button type="button" disabled={busy} className="student-button-primary" onClick={() => void onAction(last ? "start_test" : "study_next")}>{last ? "开始测试" : "下一个"}</button>
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
