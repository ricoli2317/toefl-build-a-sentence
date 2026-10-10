"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { StudentNavigation } from "./StudentUI";
import { StudentDateSelection } from "./StudentDateSelection";
import { boundedCalendarMonth, boundedDateDraft, browserTimeZone, formatDateInputValue, startOfLocalDay } from "@/lib/studentDates";
import { REVIEW_SOURCES, reviewPercent, reviewRangeLabel, reviewCoverageMessage,
  type ReviewAvailability, type ReviewHistory, type ReviewSettings, type ReviewRound } from "@/lib/lexical/wordbookReview";
import { WordbookReviewWorkspace } from "./WordbookReviewWorkspace";
import { useWordbookLocalReview } from "./useWordbookLocalReview";
import { fetchReview, ReviewRequestError } from "@/lib/lexical/wordbookReviewRequest";
import { localReview, saveLocalReview } from "@/lib/lexical/wordbookReviewLocal";
import type { WordbookDomain } from "@/lib/lexical/wordbookList";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import setupStyles from "./WordbookReviewSetup.module.css";

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
    if (!token || !id) throw new ReviewRequestError("请重新登录。", 401, "REVIEW_AUTH");
    const result = await fetchReview<T>(url, token, body, signal);
    if (owner.current !== id) throw new Error("登录账号已变化，请刷新页面。");
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

function PendingReviews() {
  const { studentId } = useReviewRequest();
  const [pending, setPending] = useState<{ session: string; count: number }[]>([]);
  useEffect(() => {
    const update = () => {
      if (!studentId) { setPending([]); return; }
      const found: { session: string; count: number }[] = [];
      try {
        for (let n = 0; n < localStorage.length; n++) {
          const key = localStorage.key(n); if (!key?.startsWith(`tps:wordbook-review:pending:${studentId}:`)) continue;
          const value = JSON.parse(localStorage.getItem(key) ?? "null");
          if (value?.owner === studentId && value.queue?.length) found.push({ session: value.round.session.session_id, count: value.queue.length });
        }
      } catch { /* Session workspace surfaces an unreadable pending record. */ }
      setPending(found);
    };
    update(); window.addEventListener("focus", update); window.addEventListener("storage", update);
    return () => { window.removeEventListener("focus", update); window.removeEventListener("storage", update); };
  }, [studentId]);
  return pending.length ? <div role="status" className="grid gap-2 text-sm text-student-muted">
    {pending.map(p => <Link key={p.session} href={`${SETUP}/${p.session}`} className="text-student-primary underline">本机有{p.count}项未同步记录 · 继续复习并同步</Link>)}
  </div> : null;
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
    && !available.data?.coverageError
    && (mode !== "random" || validCount && Number(count) >= sources.length && Number(count) <= (available.data?.total ?? 0));
  const start = async () => {
    if (busyRef.current || !canStart) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const identity = `${studentId}:${settingsKey}`;
      if (pending.current?.identity !== identity) pending.current = { identity, id: crypto.randomUUID() };
      const result = await request<ReviewRound>(ROOT, { settings, requestId: pending.current.id });
      saveLocalReview(localStorage, localReview(studentId!, result));
      router.push(`${SETUP}/${result.session.session_id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "创建失败。"); setRevision(v => v + 1); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className={`${setupStyles.page} ${domain === "reading" ? "reading-theme" : ""}`}>
    <section aria-label="复习设置" className={setupStyles.layout}>
      <nav aria-label="复习导航" className={setupStyles.navigation}><Link href="/student/wordbook">返回生词本</Link>
        <Link href={`${SETUP}/history`}>复习历史</Link></nav>
      <div className={setupStyles.pending}><PendingReviews /></div>
      <div data-review-configuration className={setupStyles.configuration}>
        <fieldset disabled={busy} className={setupStyles.collection}>
        <legend className="sr-only">复习词表与题型</legend>
        <div><p className={setupStyles.label}>复习词表</p><div className={setupStyles.domains} aria-label="复习词表">
          {(["reading", "writing"] as const).map(d => <button type="button" aria-pressed={domain === d} key={d}
            className={setupStyles.domain} onClick={() => { setDomain(d); setError(""); }}>{d === "reading" ? "Reading" : "Writing"}</button>)}</div></div>
        <fieldset className={setupStyles.sources}><legend className="sr-only">复习题型</legend>
          <div className={setupStyles.sourceHeading}><p aria-hidden="true" className={setupStyles.label}>复习题型</p><label className={setupStyles.selectAll}><input ref={allRef} type="checkbox" checked={sources.length === 3}
            onChange={() => setSelections(v => ({ ...v, [domain]: sources.length === 3 ? [] : REVIEW_SOURCES[domain].map(s => s.id) }))} />全选</label></div>
          <div className={setupStyles.sourceOptions}>
            {REVIEW_SOURCES[domain].map(source => <label key={source.id} className={setupStyles.source}><span>{source.label}</span><input type="checkbox" checked={sources.includes(source.id)}
              onChange={() => setSelections(v => ({ ...v, [domain]: sources.includes(source.id) ? sources.filter(s => s !== source.id) : [...sources, source.id] }))} /></label>)}</div>
          {!sources.length ? <p role="status" className={setupStyles.message}>请至少选择一个题型。</p> : null}
        </fieldset>
        </fieldset>
        <fieldset disabled={busy} className={setupStyles.range}><legend className={setupStyles.label}>复习范围</legend>
          <div className={setupStyles.modes}>{([['date', '指定日期'], ['range', '指定时间段'], ['random', '随机数量']] as const).map(([m, label]) =>
            <button type="button" aria-pressed={mode === m} key={m} className={setupStyles.mode}
              onClick={() => { setMode(m); setError(""); setDraft({ start: "", end: "" }); setRange({ start: "", end: "" }); }}>{label}</button>)}</div>
          <div className={setupStyles.rangeBody}>
          {mode === "random" ? <><div className={setupStyles.quantities}>{[10, 20, 50].map(n => <button type="button" key={n} aria-label={`${n} 个`} aria-pressed={!custom && count === String(n)}
            className={setupStyles.quantity} onClick={() => { setCustom(false); setCount(String(n)); }}><span className={setupStyles.quantityValue}>{n}</span><span className={setupStyles.quantityUnit}>个词条</span></button>)}
            <button type="button" aria-pressed={custom} className={setupStyles.quantity} onClick={() => setCustom(true)}><span className={setupStyles.quantityCustom}>自定义</span></button></div>
            {custom ? <label className={setupStyles.customCount}>自定义数量<input inputMode="numeric" value={count} onChange={e => setCount(e.target.value)} /><span aria-hidden="true">个词条</span></label> : null}
            {!validCount ? <p role="status" className={setupStyles.message}>数量必须为正整数。</p> : null}
            {available.data && validCount && Number(count) > available.data.total ? <p role="status" className={setupStyles.message}>实际可复习 {available.data.total} 个，不能开始 {count} 个词条的复习。</p> : null}
          </> : <><StudentDateSelection singleDay={mode === "date"} draft={draft}
            hideHints inline
            onDraftChange={v => setDraft(mode === "date" ? { start: v.start, end: v.start } : v)} bounds={bounds} rangeLabel="选择时间段"
            onApply={close => { const v = boundedDateDraft(draft, bounds); if (v) { setRange(v); close(); } }}
            activity={{ month, onMonthChange: v => setMonth(boundedCalendarMonth(v, bounds)), dates: dates.data?.dates ?? [], error: dates.error, loading: dates.loading, showToday: true, resetMonthOnOpen: true }} />
            <p className="text-sm text-student-muted" role="status">{range.start ? range.start === range.end ? `已选择 ${range.start}` : `已选择 ${range.start} — ${range.end}` : "请选择日期并应用"}</p></>}
          </div>
        </fieldset>
      </div>
      <footer className={setupStyles.action}>
        {available.error || error || available.data?.coverageError ? <div className={setupStyles.actionErrors}><Failure error={available.error} retry={() => setRevision(v => v + 1)} /><Failure error={error || reviewCoverageMessage(available.data?.coverageError)} /></div> : null}
        <div className={setupStyles.availability} aria-live="polite">
          {available.loading ? <span>正在核算可复习词条…</span> : available.data ? <><span>可复习</span><strong>{available.data.total}</strong><span>个词条</span></> : <span>{sources.length ? "选择范围后查看可复习数量" : "请选择复习题型"}</span>}
        </div>
        <button type="button" className={setupStyles.start} disabled={!canStart || busy} onClick={() => void start()}>{busy ? "正在创建…" : "开始复习"}</button>
      </footer>
    </section>
  </div>;
}

export function WordbookReviewSession({ sessionId }: { sessionId: string }) {
  const router = useRouter(), { request, studentId } = useReviewRequest();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const busyRef = useRef(false), identityRef = useRef("");
  const identity = `${studentId}:${sessionId}`; identityRef.current = identity;
  const retryRequest = useRef<string | null>(null);
  const review = useWordbookLocalReview(studentId, sessionId, request);
  useEffect(() => { setError(""); retryRequest.current = null; busyRef.current = false; setBusy(false);
    return () => { identityRef.current = ""; }; }, [identity]);
  const retry = async () => {
    if (busyRef.current || review.pending) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      retryRequest.current ??= crypto.randomUUID();
      const next = await request<ReviewRound>(`${ROOT}/${sessionId}`, { action: "retry", requestId: retryRequest.current });
      saveLocalReview(localStorage, localReview(studentId!, next));
      if (identityRef.current === identity) router.push(`${SETUP}/${next.session.session_id}`);
    } catch (e) { if (identityRef.current === identity) setError(e instanceof Error ? e.message : "创建失败。"); }
    finally { busyRef.current = false; if (identityRef.current === identity) setBusy(false); }
  };
  return <WordbookReviewWorkspace key={identity} state={review.state} busy={busy} error={error || review.error}
    onAction={review.action} onRetry={() => void retry()} onReload={() => void review.reload()}
    pending={review.pending} syncError={review.syncError} onSyncRetry={review.retrySync} />;
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
    <PendingReviews />{history.loading ? <p className="text-sm text-student-muted">正在加载复习历史…</p> : null}<Failure error={history.error} retry={() => setRevision(v => v + 1)} />
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
