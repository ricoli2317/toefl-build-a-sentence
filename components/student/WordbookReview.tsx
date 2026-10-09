"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { StudentNavigation } from "./StudentUI";
import { StudentDateSelection } from "./StudentDateSelection";
import { boundedCalendarMonth, boundedDateDraft, browserTimeZone, formatDateInputValue, startOfLocalDay } from "@/lib/studentDates";
import { REVIEW_REASON_LABELS, REVIEW_SOURCES, reviewPercent, reviewRangeLabel,
  type ReviewAvailability, type ReviewErrors, type ReviewHistory, type ReviewItem, type ReviewOption,
  type ReviewSession, type ReviewSettings, type ReviewState } from "@/lib/lexical/wordbookReview";
import type { WordbookDomain } from "@/lib/lexical/wordbookList";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

const ROOT = "/api/student/wordbook/review";
const SETUP = "/student/wordbook/review";
function Navigation({ label }: { label: string }) {
  // Learning breadcrumb deliberately remains purple; domain theme is BELOW it.
  return <StudentNavigation backHref="/student/wordbook" crumbs={[
    { label: "学生首页", href: STUDENT_ROUTES.home }, { label: "生词本", href: STUDENT_ROUTES.wordbook },
    { label: "复习设置", href: SETUP }, { label }
  ]} />;
}
function useReviewRequest() {
  const { getSession, studentId, sessionReady } = useStudentDataCache();
  const owner = useRef(studentId); owner.current = studentId;
  const request = useCallback(async <T,>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const token = getSession()?.accessToken, id = studentId;
    if (!token || !id) throw new Error("请重新登录。");
    const response = await fetch(url, { method: body === undefined ? "GET" : "POST", cache: "no-store", signal,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (owner.current !== id) throw new Error("登录账号已变化，请刷新页面。");
    if (!response.ok) throw new Error(result.error ?? "复习请求失败，请稍后重试。");
    return result as T;
  }, [getSession, studentId]);
  return { request, studentId, sessionReady };
}
function useReviewRead<T>(url: string | null, revision = 0) {
  const { request, studentId, sessionReady } = useReviewRequest();
  const identity = `${studentId}:${url}:${revision}`;
  const [state, setState] = useState<{ identity: string; data?: T; error?: string }>({ identity: "" });
  useEffect(() => {
    if (!url || !studentId || !sessionReady) return;
    const abort = new AbortController(); let active = true;
    setState({ identity });
    void request<T>(url, undefined, abort.signal).then(data => { if (active) setState({ identity, data }); })
      .catch(error => { if (active) setState({ identity, error: error instanceof Error ? error.message : "读取失败。" }); });
    return () => { active = false; abort.abort(); };
  }, [url, identity, studentId, sessionReady, request]);
  return { data: state.identity === identity ? state.data : undefined, error: state.identity === identity ? state.error : undefined,
    loading: Boolean(url) && (!sessionReady || Boolean(studentId) && (state.identity !== identity || !state.data && !state.error)) };
}
function Failure({ error, retry }: { error?: string; retry?: () => void }) {
  return error ? <div role="alert" className="grid gap-2 text-sm text-student-error"><p>{error}</p>
    {retry ? <button type="button" onClick={retry} className="student-button-secondary justify-self-start">重试</button> : null}</div> : null;
}
function Sources({ domain, sources }: { domain: WordbookDomain; sources: string[] }) {
  return <span className="flex flex-wrap gap-1.5">{sources.map(source => <span key={source} className="student-chip text-xs">
    {REVIEW_SOURCES[domain].find(s => s.id === source)?.label ?? source}</span>)}</span>;
}

export function WordbookReviewSetup({ initialDomain }: { initialDomain: WordbookDomain }) {
  const router = useRouter(), { request, studentId } = useReviewRequest();
  const [domain, setDomain] = useState(initialDomain);
  const [selections, setSelections] = useState<Record<WordbookDomain, string[]>>({ reading: REVIEW_SOURCES.reading.map(s => s.id), writing: REVIEW_SOURCES.writing.map(s => s.id) });
  const [mode, setMode] = useState<ReviewSettings["mode"]>("random"), [count, setCount] = useState("10");
  const [custom, setCustom] = useState(false), [today, setToday] = useState(() => startOfLocalDay());
  const [draft, setDraft] = useState({ start: "", end: "" }), [range, setRange] = useState({ start: "", end: "" });
  const [month, setMonth] = useState(() => startOfLocalDay()), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef<{ identity: string; id: string } | null>(null), busyRef = useRef(false);
  const allRef = useRef<HTMLInputElement>(null), sources = selections[domain];
  const timeZone = useMemo(() => browserTimeZone(), []), bounds = { min: "2026-07-01", max: formatDateInputValue(today) };
  useEffect(() => { const update = () => setToday(startOfLocalDay()); const timer = setInterval(update, 60000); window.addEventListener("focus", update);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); }; }, []);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = sources.length > 0 && sources.length < 3; }, [sources]);
  useEffect(() => { setError(""); pending.current = null; }, [studentId]);
  const validCount = /^[1-9]\d{0,5}$/.test(count);
  const settings: ReviewSettings = { domain, sources: [...sources].sort(), mode, timeZone,
    ...(mode === "random" ? { count: validCount ? Number(count) : 1 } : { ...range }) };
  const settingsKey = JSON.stringify(settings);
  const validRange = mode === "random" || Boolean(boundedDateDraft(range, bounds)) && (mode !== "date" || range.start === range.end);
  const available = useReviewRead<ReviewAvailability>(sources.length && validRange ? `${ROOT}?${new URLSearchParams({ action: "availability", settings: settingsKey })}` : null, revision);
  const dates = useReviewRead<{ dates: string[] }>(mode === "random" ? null : `/api/student/wordbook/activity-dates?${new URLSearchParams({ domain, month: formatDateInputValue(month).slice(0, 7), timeZone })}`);
  const canStart = sources.length > 0 && validRange && !available.loading && Boolean(available.data?.total)
    && (mode !== "random" || validCount && Number(count) <= (available.data?.total ?? 0));
  const start = async () => {
    if (busyRef.current || !canStart) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const identity = `${studentId}:${settingsKey}`;
      if (pending.current?.identity !== identity) pending.current = { identity, id: crypto.randomUUID() };
      const result = await request<ReviewState>(ROOT, { settings, requestId: pending.current.id });
      router.push(`${SETUP}/${result.session.session_id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "创建失败。"); setRevision(v => v + 1); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="grid min-w-0 gap-5"><Navigation label="开始复习" />
    <section className={`student-card grid min-w-0 gap-5 p-4 sm:p-6 ${domain === "reading" ? "reading-theme" : ""}`}>
      <fieldset disabled={busy} className="grid min-w-0 gap-5">
        <legend className="sr-only">复习设置</legend>
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-2" aria-label="复习词表">
          {(["reading", "writing"] as const).map(d => <button type="button" aria-pressed={domain === d} key={d}
            className={domain === d ? "student-button-primary" : "student-button-secondary"} onClick={() => { setDomain(d); setError(""); }}>{d === "reading" ? "Reading" : "Writing"}</button>)}</div>
          <Link href={`${SETUP}/history`} className="text-sm font-semibold text-student-primary hover:underline">复习历史</Link></div>
        <fieldset className="grid gap-3"><legend className="mb-2 text-sm font-bold">复习题型</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-3"><label className="flex items-center gap-2 text-sm"><input ref={allRef} type="checkbox" checked={sources.length === 3}
            onChange={() => setSelections(v => ({ ...v, [domain]: sources.length === 3 ? [] : REVIEW_SOURCES[domain].map(s => s.id) }))} />全选</label>
            {REVIEW_SOURCES[domain].map(source => <label key={source.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sources.includes(source.id)}
              onChange={() => setSelections(v => ({ ...v, [domain]: sources.includes(source.id) ? sources.filter(s => s !== source.id) : [...sources, source.id] }))} />{source.label}</label>)}</div>
          {!sources.length ? <p role="status" className="text-sm text-student-error">请至少选择一个题型。</p> : null}
          <p className="text-xs leading-5 text-student-muted">CTW / WE / AD：拼写 + 词性点选。RDL / RAP / BAS：中文词义四选一。多来源词条每轮只出现一次。</p>
        </fieldset>
        <fieldset className="grid min-w-0 gap-3"><legend className="mb-2 text-sm font-bold">复习范围</legend>
          <div className="flex flex-wrap gap-2">{([['date', '指定日期'], ['range', '指定时间段'], ['random', '随机数量']] as const).map(([m, label]) =>
            <button type="button" aria-pressed={mode === m} key={m} className={mode === m ? "student-button-primary" : "student-button-secondary"}
              onClick={() => { setMode(m); setError(""); setDraft({ start: "", end: "" }); setRange({ start: "", end: "" }); }}>{label}</button>)}</div>
          {mode === "random" ? <><div className="flex flex-wrap items-center gap-2">{[10, 20, 50].map(n => <button type="button" key={n} aria-pressed={!custom && count === String(n)}
            className={!custom && count === String(n) ? "student-button-primary" : "student-button-secondary"} onClick={() => { setCustom(false); setCount(String(n)); }}>{n} 个</button>)}
            <button type="button" aria-pressed={custom} className={custom ? "student-button-primary" : "student-button-secondary"} onClick={() => setCustom(true)}>自定义</button></div>
            {custom ? <label className="grid max-w-48 gap-2 text-sm">自定义数量<input className="teacher-input min-w-0 w-full" inputMode="numeric" value={count} onChange={e => setCount(e.target.value)} /></label> : null}
            {!validCount ? <p role="status" className="text-sm text-student-error">数量必须为正整数。</p> : null}
            {available.data && validCount && Number(count) > available.data.total ? <p role="status" className="text-sm text-student-error">实际可复习 {available.data.total} 个，不能开始 {count} 个词条的复习。</p> : null}
          </> : <div className="flex min-w-0 flex-wrap items-center gap-3"><StudentDateSelection singleDay={mode === "date"} draft={draft}
            onDraftChange={v => setDraft(mode === "date" ? { start: v.start, end: v.start } : v)} bounds={bounds} rangeLabel="选择时间段"
            hint="按首次收藏及有效追加活动筛选；不重复同一词条。"
            onApply={close => { const v = boundedDateDraft(draft, bounds); if (v) { setRange(v); close(); } }}
            activity={{ month, onMonthChange: v => setMonth(boundedCalendarMonth(v, bounds)), dates: dates.data?.dates ?? [], error: dates.error, loading: dates.loading, showToday: true, resetMonthOnOpen: true }} />
            <span className="text-sm text-student-muted">{range.start ? range.start === range.end ? range.start : `${range.start} — ${range.end}` : "请选择日期"}</span></div>}
        </fieldset>
      </fieldset>
      <div className="grid gap-2 rounded-lg bg-student-bg p-4 text-sm" aria-live="polite">
        {available.loading ? <p>正在核算可复习词条…</p> : available.data ? <><p className="font-semibold">可复习 {available.data.total} 个词条 · 不可出题 {available.data.unavailable} 个</p>
          <p>候选池：拼写 + 词性 {available.data.spellingPos} 个 · 四选一 {available.data.meaningChoice} 个</p>
          {mode === "random" ? <p className="text-xs text-student-muted">本轮准确题型构成会在抽取后显示；同日优先未抽过的词条，用尽后均衡轮换。</p> : null}
          {Object.entries(available.data.reasons).map(([key, n]) => <p className="text-xs text-student-muted" key={key}>{REVIEW_REASON_LABELS[key] ?? key}：{n}</p>)}
        </> : <p className="text-student-muted">选择题型及有效范围后显示可用数量。</p>}
      </div>
      <Failure error={available.error} retry={() => setRevision(v => v + 1)} /><Failure error={error} />
      <button type="button" className="student-button-primary justify-self-start" disabled={!canStart || busy} onClick={() => void start()}>{busy ? "正在创建…" : "开始复习"}</button>
    </section>
  </div>;
}

function OptionButtons({ label, options, selected, onChange, disabled }: { label: string; options: ReviewOption[]; selected: string;
  onChange: (id: string) => void; disabled: boolean }) {
  return <div role="radiogroup" aria-label={label} className="flex min-w-0 flex-wrap gap-2">
    {options.map((option, index) => <button type="button" role="radio" aria-checked={selected === option.id} disabled={disabled}
      tabIndex={selected ? selected === option.id ? 0 : -1 : index === 0 ? 0 : -1} key={option.id}
      className={`${selected === option.id ? "student-button-primary" : "student-button-secondary"} max-w-full whitespace-normal break-words text-left`}
      onClick={() => onChange(option.id)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : (index + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + options.length) % options.length;
        onChange(options[next].id); (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
      }}>{option.label ?? option.text}</button>)}
  </div>;
}
function Feedback({ item }: { item: ReviewItem }) {
  const a = item.answer;
  if (!a) return null;
  const selectedText = item.options.find(o => o.id === a.student.optionId)?.text;
  const selectedPos = item.options.find(o => o.id === a.student.pos)?.label;
  return <div role="status" className={`grid min-w-0 gap-3 rounded-lg border p-4 ${a.correct ? "border-student-primary-border bg-student-primary-soft" : "border-student-error-border"}`}>
    <p className={`font-semibold ${a.correct ? "text-student-primary" : "text-student-error"}`}>{a.correct ? "回答正确" : "回答错误"}</p>
    {item.kind === "spelling_pos" ? <><p className="text-sm">拼写：{a.assessments.spelling ? "正确" : "错误"} · 你的答案：<span className="break-words">{a.student.spelling}</span></p>
      <p className="text-sm">词性：{a.assessments.pos ? "正确" : "错误"} · 你的选择：{selectedPos ?? a.student.pos}</p></>
      : <p className="text-sm">词义：{a.assessments.meaning_choice ? "正确" : "错误"} · 你的选择：{selectedText}</p>}
    <p className="break-words font-bold">{a.expression} <span className="text-sm font-normal">{a.standardPos}</span></p>
    <p className="break-words text-sm">{a.meaning}</p>{a.definitionEn ? <p className="break-words text-sm text-student-muted">{a.definitionEn}</p> : null}
    {a.examples.map((e, index) => <p key={index} className="break-words text-sm leading-6 text-student-muted">{e.text}</p>)}
  </div>;
}

export function WordbookReviewSession({ sessionId }: { sessionId: string }) {
  const router = useRouter(), { request, studentId } = useReviewRequest();
  const [position, setPosition] = useState<number | null>(null), [revision, setRevision] = useState(0);
  const [submitted, setSubmitted] = useState<{ owner: string | null; state: ReviewState } | null>(null);
  const [spelling, setSpelling] = useState(""), [selected, setSelected] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [showResult, setShowResult] = useState(false), busyRef = useRef(false);
  const retryRequest = useRef<string | null>(null);
  const loaded = useReviewRead<ReviewState>(`${ROOT}/${sessionId}${position ? `?position=${position}` : ""}`, revision);
  const state = submitted?.owner === studentId && submitted.state.session.session_id === sessionId ? submitted.state : loaded.data;
  const item = state?.item, session = state?.session;
  useEffect(() => { setSpelling(""); setSelected(""); setError(""); }, [item?.itemId]);
  useEffect(() => { setSubmitted(null); setPosition(null); setShowResult(false); retryRequest.current = null; }, [studentId, sessionId]);
  const resultVisible = session?.status === "completed" && (showResult || !submitted);
  const answer = async () => {
    if (!item || item.answer || busyRef.current || !selected || item.kind === "spelling_pos" && !spelling.trim()) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const next = await request<ReviewState>(`${ROOT}/${sessionId}`, { action: "answer", itemId: item.itemId,
        answer: item.kind === "spelling_pos" ? { spelling, pos: selected } : { optionId: selected } });
      setSubmitted({ owner: studentId, state: next });
    } catch (e) { setError(e instanceof Error ? e.message : "提交失败。"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const retry = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      retryRequest.current ??= crypto.randomUUID();
      const next = await request<ReviewState>(`${ROOT}/${sessionId}`, { action: "retry", requestId: retryRequest.current });
      router.push(`${SETUP}/${next.session.session_id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "创建失败。"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="grid min-w-0 gap-5"><Navigation label={resultVisible ? "复习结果" : "复习中"} />
    {!state ? <>{loaded.loading ? <p className="text-sm text-student-muted">正在恢复复习…</p> : null}<Failure error={loaded.error} retry={() => setRevision(v => v + 1)} /></> :
    <section className={`student-card grid min-w-0 gap-5 p-4 sm:p-6 ${session?.domain === "reading" ? "reading-theme" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-bold">{session?.domain === "reading" ? "Reading" : "Writing"} · {reviewRangeLabel(state.session)}</h2>
        <Sources domain={state.session.domain} sources={state.session.source_types} /></div>
      <p className="text-xs text-student-muted">本轮：拼写 + 词性 {state.composition.spellingPos} 题 · 四选一 {state.composition.meaningChoice} 题</p>
      {resultVisible ? <ReviewResult state={state} busy={busy} onRetry={() => void retry()} /> : item ? <>
        <div className="grid gap-2"><div className="flex flex-wrap justify-between gap-2 text-sm text-student-muted"><span>第 {item.position} / {state.session.total} 题</span><span>已提交 {state.session.answered} / {state.session.total}</span></div>
          <div role="progressbar" aria-label="复习进度" aria-valuemin={0} aria-valuemax={state.session.total} aria-valuenow={state.session.answered}
            className="h-2 w-full overflow-hidden rounded-full bg-student-primary-soft"><div className="h-full rounded-full bg-student-primary"
              style={{ width: `${state.session.answered / state.session.total * 100}%` }} /></div></div>
        <Sources domain={state.session.domain} sources={item.sourceTypes} />
        <form className="grid min-w-0 gap-4" onSubmit={event => { event.preventDefault(); void answer(); }}>
          <p className="text-sm text-student-muted">{item.kind === "spelling_pos" ? "根据中文语境义填写英文拼写，并点击选择词性。" : "选择该英文词条的中文语境义。"}</p>
          <h3 className="break-words text-xl font-bold">{item.prompt}</h3>
          {item.kind === "spelling_pos" ? <><label className="grid gap-2 text-sm font-semibold">英文拼写
            <input value={spelling} onChange={e => setSpelling(e.target.value)} disabled={busy || Boolean(item.answer)} className="teacher-input w-full min-w-0"
              autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={300} /></label>
            <p className="text-sm font-semibold">选择词性</p></> : null}
          <OptionButtons label={item.kind === "spelling_pos" ? "词性" : "中文语境义"} options={item.options} selected={selected || item.answer?.student.pos || item.answer?.student.optionId || ""}
            onChange={setSelected} disabled={busy || Boolean(item.answer)} />
          {!item.answer ? <button type="submit" className="student-button-primary justify-self-start" disabled={busy || !selected || item.kind === "spelling_pos" && !spelling.trim()}>{busy ? "正在提交…" : "检查答案"}</button> : null}
        </form>
        <Feedback item={item} />
        {item.answer ? <button type="button" className="student-button-primary justify-self-start" disabled={busy}
          onClick={() => { if (state.session.status === "completed") setShowResult(true); else { setPosition(item.position + 1); setSubmitted(null); setRevision(v => v + 1); } }}>
          {state.session.status === "completed" ? "查看结果" : "下一题"}</button> : null}
        <Link href={`${SETUP}/history`} className="justify-self-start text-sm text-student-primary hover:underline">暂停并返回历史（进度已保存）</Link>
      </> : null}
      <Failure error={error} />
    </section>}
  </div>;
}

function ReviewResult({ state, busy, onRetry }: { state: ReviewState; busy: boolean; onRetry: () => void }) {
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const errors = useReviewRead<ReviewErrors>(`${ROOT}/${state.session.session_id}?errors=1&page=${page}`, revision);
  const summary = state.summary;
  return <div className="grid min-w-0 gap-5">
    <h3 className="text-xl font-bold">复习完成</h3>
    <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
      {[['词条总数', state.session.total], ['答对', summary.correct], ['答错', summary.incorrect], ['整体正确率', reviewPercent(summary.correct, state.session.total)],
        ['拼写', `${summary.spellingCorrect}/${summary.spellingTotal} · ${reviewPercent(summary.spellingCorrect, summary.spellingTotal)}`],
        ['词性', `${summary.posCorrect}/${summary.posTotal} · ${reviewPercent(summary.posCorrect, summary.posTotal)}`],
        ['四选一', `${summary.choiceCorrect}/${summary.choiceTotal} · ${reviewPercent(summary.choiceCorrect, summary.choiceTotal)}`]].map(([label, value]) =>
        <div key={label} className="min-w-0 rounded-lg bg-student-bg p-3"><p className="text-student-muted">{label}</p><p className="mt-1 break-words font-bold">{value}</p></div>)}
    </div>
    <div className="flex flex-wrap gap-3"><button type="button" className="student-button-primary" disabled={busy || !summary.incorrect} onClick={onRetry}>{busy ? "正在创建…" : "错词再练"}</button>
      <Link className="student-button-secondary" href={SETUP}>新一轮复习</Link><Link className="student-button-secondary" href={`${SETUP}/history`}>复习历史</Link></div>
    <h4 className="font-semibold">错词清单</h4>
    {errors.loading ? <p className="text-sm text-student-muted">正在加载错词…</p> : null}
    <Failure error={errors.error} retry={() => setRevision(v => v + 1)} />
    {errors.data?.items.map(item => <div className="grid min-w-0 gap-2" key={item.itemId}><p className="text-sm text-student-muted">第 {item.position} 题</p><Feedback item={item} /></div>)}
    {errors.data && !errors.data.total ? <p className="text-sm text-student-muted">本轮全部正确。</p> : null}
    {errors.data && errors.data.total > 10 ? <Pagination page={page} total={errors.data.total} pageSize={10} disabled={errors.loading} onChange={setPage} /> : null}
  </div>;
}
function Pagination({ page, total, pageSize, disabled, onChange }: { page: number; total: number; pageSize: number; disabled: boolean; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted"><span>共 {total} 条 · 第 {page} / {pages} 页</span>
    <div className="flex gap-2"><button type="button" className="student-button-secondary" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
      <button type="button" className="student-button-secondary" disabled={disabled || page >= pages} onClick={() => onChange(page + 1)}>下一页</button></div></div>;
}
export function WordbookReviewHistory() {
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const history = useReviewRead<ReviewHistory>(`${ROOT}?action=history&page=${page}`, revision);
  return <div className="grid min-w-0 gap-5"><Navigation label="复习历史" /><Link href={SETUP} className="student-button-primary justify-self-start">开始新复习</Link>
    {history.loading ? <p className="text-sm text-student-muted">正在加载复习历史…</p> : null}<Failure error={history.error} retry={() => setRevision(v => v + 1)} />
    {history.data?.items.map(session => <section key={session.session_id} className={`student-card grid min-w-0 gap-3 p-4 ${session.domain === "reading" ? "reading-theme" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-bold">{session.domain === "reading" ? "Reading" : "Writing"} · {reviewRangeLabel(session)}</h2><Sources domain={session.domain} sources={session.source_types} /></div>
      <p className="break-words text-xs text-student-muted">{new Date(session.started_at).toLocaleString()} · {session.status === "completed" ? "已完成" : "未完成"}</p>
      <p className="text-sm">进度 {session.answered}/{session.total} · 答对 {session.summary.correct} · {session.status === "completed" ? `正确率 ${reviewPercent(session.summary.correct, session.total)}` : "成绩待完成"}</p>
      <Link href={`${SETUP}/${session.session_id}`} className="student-button-secondary justify-self-start">{session.status === "completed" ? "查看结果" : "恢复复习"}</Link>
    </section>)}
    {history.data && !history.data.total ? <p className="py-6 text-center text-sm text-student-muted">还没有复习记录。</p> : null}
    {history.data ? <Pagination page={page} total={history.data.total} pageSize={10} disabled={history.loading} onChange={setPage} /> : null}
  </div>;
}
