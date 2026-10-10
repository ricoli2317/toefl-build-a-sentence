"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { StudentNavigation } from "./StudentUI";
import { StudentDateSelection } from "./StudentDateSelection";
import { boundedCalendarMonth, boundedDateDraft, browserTimeZone, formatDateInputValue, startOfLocalDay } from "@/lib/studentDates";
import { REVIEW_SOURCES, reviewPercent, reviewRangeLabel,
  type ReviewAvailability, type ReviewHistory, type ReviewSettings, type ReviewState } from "@/lib/lexical/wordbookReview";
import { WordbookReviewWorkspace } from "./WordbookReviewWorkspace";
import { clearReviewSwitch, prepareReviewAdvance, readReviewSwitch, REVIEW_SWITCH_DELAY,
  saveReviewSwitch, waitForReviewSwitch } from "@/lib/lexical/wordbookReviewTiming";
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
            hideHints
            onDraftChange={v => setDraft(mode === "date" ? { start: v.start, end: v.start } : v)} bounds={bounds} rangeLabel="选择时间段"
            onApply={close => { const v = boundedDateDraft(draft, bounds); if (v) { setRange(v); close(); } }}
            activity={{ month, onMonthChange: v => setMonth(boundedCalendarMonth(v, bounds)), dates: dates.data?.dates ?? [], error: dates.error, loading: dates.loading, showToday: true, resetMonthOnOpen: true }} />
            <span className="text-sm text-student-muted">{range.start ? range.start === range.end ? range.start : `${range.start} — ${range.end}` : "请选择日期"}</span></div>}
        </fieldset>
      </fieldset>
      <div className="text-sm font-semibold" aria-live="polite">
        {available.loading ? <p>正在核算可复习词条…</p> : available.data ? <p>可复习 {available.data.total} 个词条</p> : null}
      </div>
      <Failure error={available.error} retry={() => setRevision(v => v + 1)} /><Failure error={error} />
      <button type="button" className="student-button-primary justify-self-start" disabled={!canStart || busy} onClick={() => void start()}>{busy ? "正在创建…" : "开始复习"}</button>
    </section>
  </div>;
}

export function WordbookReviewSession({ sessionId }: { sessionId: string }) {
  const router = useRouter(), { request, studentId } = useReviewRequest();
  const [revision, setRevision] = useState(0);
  const [submitted, setSubmitted] = useState<{ owner: string | null; state: ReviewState } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [restoring, setRestoring] = useState(true);
  const busyRef = useRef(false), identityRef = useRef("");
  const transition = useRef<AbortController | null>(null), restored = useRef<ReviewState | null>(null);
  const identity = `${studentId}:${sessionId}`; identityRef.current = identity;
  const retryRequest = useRef<string | null>(null);
  const loaded = useReviewRead<ReviewState>(`${ROOT}/${sessionId}`, revision);
  const state = submitted?.owner === studentId && submitted.state.session.session_id === sessionId ? submitted.state : restoring ? undefined : loaded.data;
  useEffect(() => { identityRef.current = identity; setSubmitted(null); setError(""); setBusy(false); setRestoring(true);
    busyRef.current = false; restored.current = null; retryRequest.current = null;
    return () => { identityRef.current = ""; transition.current?.abort(); }; }, [identity]);
  const runAction = async (current: ReviewState, name: string, answer?: unknown) => {
    if (!current.item || !studentId || busyRef.current) return;
    transition.current?.abort();
    const abort = new AbortController(); transition.current = abort;
    const active = () => !abort.signal.aborted && identityRef.current === identity;
    const publish = (next: ReviewState) => { if (active()) setSubmitted({ owner: studentId, state: next }); };
    // Called synchronously by the button/Enter handler, BEFORE the answer fetch.
    const deadline = name === "answer" ? Date.now() + REVIEW_SWITCH_DELAY
      : readReviewSwitch(studentId, sessionId)?.deadline ?? Date.now();
    if (name === "answer") saveReviewSwitch(studentId, sessionId, { itemId: current.item.itemId, deadline });
    busyRef.current = true; setBusy(true); setError("");
    try {
      if (name === "advance" && current.item.answer?.correct) {
        await prepareReviewAdvance(() => request<ReviewState>(`${ROOT}/${sessionId}`, { action: "advance", itemId: current.item.itemId }), deadline, abort.signal, publish);
        if (active()) clearReviewSwitch(studentId, sessionId);
      } else {
        const next = await request<ReviewState>(`${ROOT}/${sessionId}`, { action: name, itemId: current.item.itemId, ...(answer === undefined ? {} : { answer }) });
        if (!active()) return;
        publish(next);
        if (name === "answer" && next.flow?.phase === "test" && next.item.answer?.correct) {
          // The server has confirmed and saved this answer. Prepare the exact
          // next cursor/result immediately while keeping the green card visible.
          await prepareReviewAdvance(() => request<ReviewState>(`${ROOT}/${sessionId}`, { action: "advance", itemId: next.item.itemId }), deadline, abort.signal, publish);
        }
        if (active()) clearReviewSwitch(studentId, sessionId);
      }
    } catch (e) { if (active()) setError(e instanceof Error ? e.message : "请求失败。"); }
    finally { if (transition.current === abort && active()) { busyRef.current = false; setBusy(false); } }
  };
  const runActionRef = useRef(runAction); runActionRef.current = runAction;
  useEffect(() => {
    const current = loaded.data;
    if (!current || !studentId || restored.current === current) return;
    restored.current = current;
    if (current.flow?.phase === "test" && current.item.answer?.correct) {
      setRestoring(false);
      // No resubmission or new 1s timer on refresh: use the original deadline,
      // and let the server's itemId guard handle an already-committed advance.
      void runActionRef.current(current, "advance");
      return;
    }
    const pending = readReviewSwitch(studentId, sessionId);
    const abort = new AbortController(); transition.current?.abort(); transition.current = abort;
    const deadline = pending && current.flow?.phase !== "study" && current.item.answer?.correct !== false
      ? pending.deadline : Date.now();
    // If a refresh reads the prepared next cursor/result before the deadline,
    // hold its publication too. Do not restore an old answer from local storage.
    void waitForReviewSwitch(deadline, abort.signal).then(ready => {
      if (!ready || identityRef.current !== identity) return;
      clearReviewSwitch(studentId, sessionId); setRestoring(false);
    });
  }, [loaded.data, studentId, sessionId, identity]);
  const action = async (name: string, answer?: unknown) => { if (state) await runAction(state, name, answer); };
  const retry = async () => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      retryRequest.current ??= crypto.randomUUID();
      const next = await request<ReviewState>(`${ROOT}/${sessionId}`, { action: "retry", requestId: retryRequest.current });
      if (identityRef.current === identity) router.push(`${SETUP}/${next.session.session_id}`);
    } catch (e) { if (identityRef.current === identity) setError(e instanceof Error ? e.message : "创建失败。"); }
    finally { busyRef.current = false; if (identityRef.current === identity) setBusy(false); }
  };
  return <WordbookReviewWorkspace key={identity} state={state} busy={busy} error={error || loaded.error}
    onAction={action} onRetry={() => void retry()} onReload={() => { transition.current?.abort(); busyRef.current = false; setBusy(false);
      setRestoring(true); setSubmitted(null); setRevision(v => v + 1); }} />;
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
