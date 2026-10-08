"use client";

import { useEffect, useMemo, useState } from "react";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { StudentNavigation } from "@/components/student/StudentUI";
import { StudentDateSelection } from "@/components/student/StudentDateSelection";
import { WordbookExample } from "./WordbookExample";
import { wordbookPos } from "@/lib/lexical/wordbookPresentation";
import { ChevronDown } from "lucide-react";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { addDays, boundedCalendarMonth, boundedDateDraft, browserTimeZone, formatDateInputValue, startOfLocalDay } from "@/lib/studentDates";
import { WORDBOOK_HEADERS, wordbookContextRows, type WordbookDomain, type WordbookItem, type WordbookList } from "@/lib/lexical/wordbookList";
import styles from "./StudentWordbook.module.css";

type Filters = { start: string; end: string; sort: "newest" | "oldest"; page: number };
const emptyFilters: Filters = { start: "", end: "", sort: "newest", page: 1 };

export function StudentWordbook() {
  const [domain, setDomain] = useState<WordbookDomain>("reading");
  const [filters, setFilters] = useState<Record<WordbookDomain, Filters>>({ reading: { ...emptyFilters }, writing: { ...emptyFilters } });
  const active = filters[domain];
  const [draft, setDraft] = useState({ start: "", end: "" });
  const [month, setMonth] = useState(() => startOfLocalDay());
  const [today, setToday] = useState(() => startOfLocalDay());
  const bounds = { min: "2026-07-01", max: formatDateInputValue(today) };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => { const day = startOfLocalDay(); setToday(day); timer = setTimeout(refresh, addDays(day, 1).getTime() - Date.now() + 50); };
    const focus = () => { clearTimeout(timer); refresh(); };
    refresh(); window.addEventListener("focus", focus);
    return () => { clearTimeout(timer); window.removeEventListener("focus", focus); };
  }, []);
  const [revision, setRevision] = useState(0);
  const timeZone = useMemo(() => browserTimeZone(), []);
  const monthKey = formatDateInputValue(month).slice(0, 7);
  const listQuery = new URLSearchParams({ domain, sort: active.sort, page: String(active.page), timeZone });
  if (active.start) { listQuery.set("start", active.start); listQuery.set("end", active.end); }
  const listUrl = `/api/student/wordbook?${listQuery}`;
  const datesUrl = `/api/student/wordbook/activity-dates?${new URLSearchParams({ domain, month: monthKey, timeZone })}`;
  // Only bounded active pages/months. No long-lived enrichment cache, no hidden
  // domain full reload, and AbortController + URL identity prevent stale races.
  const list = useWordbookRead<WordbookList>(listUrl, revision);
  const dates = useWordbookRead<{ dates: string[] }>(datesUrl, revision);
  useEffect(() => { setDraft({ start: active.start, end: active.end }); }, [domain, active.start, active.end]);
  const update = (changes: Partial<Filters>) => setFilters(previous => ({ ...previous, [domain]: { ...previous[domain], ...changes } }));
  const switchDomain = (next: WordbookDomain) => {
    if (next === domain) return;
    // Dates never survive a tab switch, including when returning to the old tab.
    // Keep each domain's sort; reset both pages along with applied/draft dates.
    setFilters(previous => ({ reading: { ...previous.reading, start: "", end: "", page: 1 }, writing: { ...previous.writing, start: "", end: "", page: 1 } }));
    setDraft({ start: "", end: "" });setMonth(startOfLocalDay());setDomain(next);
  };
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 20));
  // A cancellation in another tab may leave an empty last page. Correct once.
  useEffect(() => { if (list.data && active.page > pages) setFilters(previous => ({ ...previous, [domain]: { ...previous[domain], page: pages } })); }, [list.data, active.page, pages, domain]);

  return <div className={`grid min-w-0 gap-5 ${domain === "reading" ? "reading-theme" : ""}`}>
    <StudentNavigation backHref={STUDENT_ROUTES.home} crumbs={[{ label: "学生首页", href: STUDENT_ROUTES.home }, { label: "生词本" }]} />
    <div aria-label="生词本分类" role="tablist" className="flex gap-1 border-b border-student-border">
      {(["reading", "writing"] as const).map(tab => <button id={`wordbook-tab-${tab}`} aria-controls={`wordbook-panel-${tab}`} aria-selected={domain === tab} role="tab" type="button" key={tab}
        tabIndex={domain === tab ? 0 : -1} onClick={() => switchDomain(tab)}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "reading" : event.key === "End" ? "writing" : domain === "reading" ? "writing" : "reading"; switchDomain(next); document.getElementById(`wordbook-tab-${next}`)?.focus(); } }}
        className={`border-b-2 px-5 py-3 text-sm font-semibold transition ${domain === tab ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}>
        {tab === "reading" ? "Reading" : "Writing"}
      </button>)}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className={`flex min-w-0 flex-wrap items-center gap-2 ${domain === "reading" ? styles.readingDateControls : ""}`}>
        <StudentDateSelection key={domain} draft={draft} onDraftChange={setDraft} rangeLabel="查看日期范围" bounds={bounds}
          hint="单日或范围内有收藏活动的词汇，展示其当前全部语境。"
          onApply={close => { const range = boundedDateDraft(draft, { ...bounds, max: formatDateInputValue(new Date()) }); if (!range) return; update({ ...range, page: 1 }); close(); }}
          onClear={() => { setDraft({ start: "", end: "" });update({ start: "", end: "", page: 1 }); }}
          activity={{ month, onMonthChange: value => { const next = boundedCalendarMonth(value, bounds); setMonth(previous => formatDateInputValue(previous).slice(0, 7) === formatDateInputValue(next).slice(0, 7) ? previous : next); }, dates: dates.data?.dates ?? [], error: dates.error, loading: dates.loading, showToday: true, resetMonthOnOpen: true }} />
        <span className="text-sm text-student-muted">{active.start ? active.start === active.end ? active.start : `${active.start} — ${active.end}` : "全部日期"}</span>
        {active.start ? <button type="button" className="text-xs text-student-primary hover:underline" onClick={() => { setDraft({ start: "", end: "" });update({ start: "", end: "", page: 1 }); }}>清除</button> : null}
      </div>
      <label className="flex items-center gap-2 text-sm text-student-muted">排序
        <span className="relative inline-flex items-center"><select aria-label="生词本排序" className="teacher-input min-w-0 appearance-none !pr-9" value={active.sort} onChange={event => update({ sort: event.target.value as Filters["sort"], page: 1 })}>
          <option value="newest">最新优先</option><option value="oldest">最早优先</option>
        </select><ChevronDown aria-hidden="true" size={16} className="pointer-events-none absolute right-3 text-student-muted" /></span>
      </label>
    </div>
    <section id={`wordbook-panel-${domain}`} role="tabpanel" aria-labelledby={`wordbook-tab-${domain}`} aria-busy={list.loading} className="min-w-0">
      <WordbookTable domain={domain} items={items} />
      <div aria-live="polite">
        {list.loading ? <p className="py-8 text-center text-sm text-student-muted">正在加载生词本…</p> : null}
        {list.error ? <div className="py-8 text-center text-sm text-student-muted"><p>{list.error}</p><button type="button" className="student-button-secondary mt-3" onClick={() => setRevision(value => value + 1)}>重试</button></div> : null}
        {!list.loading && !list.error && list.data && !items.length ? <p className="py-12 text-center text-sm text-student-muted">{active.start ? "所选日期没有收藏活动。可清除日期筛选查看全部词汇。" : `还没有 ${domain === "reading" ? "Reading" : "Writing"} 生词。在练习查词卡中点击收藏，即可保留词汇及原题语境。`}</p> : null}
      </div>
      {list.data && list.data.total > 0 ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted">
        <span>共 {list.data.total} 个词汇 · 第 {active.page} / {pages} 页</span>
        <div className="flex gap-2"><button className="student-button-secondary" type="button" disabled={active.page <= 1 || list.loading} onClick={() => update({ page: active.page - 1 })}>上一页</button>
          <button className="student-button-secondary" type="button" disabled={active.page >= pages || list.loading} onClick={() => update({ page: active.page + 1 })}>下一页</button></div>
      </div> : null}
    </section>
  </div>;
}

function useWordbookRead<T>(url: string, revision: number) {
  const { getSession, sessionReady, studentId } = useStudentDataCache();
  const [state, setState] = useState<{ identity: string; data?: T; error?: string }>({ identity: "" });
  const identity = `${studentId}:${url}:${revision}`;
  useEffect(() => {
    if (!sessionReady || !studentId) return;
    const abort = new AbortController();
    let current = true;
    const token = getSession()?.accessToken;
    setState({ identity });
    void (async () => {
      try {
        if (!token) throw new Error("请重新登录。");
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: abort.signal });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? "生词本读取失败，请稍后重试。");
        if (current) setState({ identity, data: payload });
      } catch (error) { if (current) setState({ identity, error: error instanceof Error ? error.message : "读取失败。" }); }
    })();
    return () => { current = false; abort.abort(); };
  }, [url, revision, getSession, sessionReady, studentId, identity]);
  return { data: state.identity === identity ? state.data : undefined, error: state.identity === identity ? state.error : undefined,
    loading: !sessionReady || (Boolean(studentId) && (state.identity !== identity || !state.data && !state.error)) };
}

// Existing TPS theme chips: reading blue from WrongQuestionsHome / history;
// BAS/WE/AD use the existing writing student-primary tokens, not new colours.
const SOURCE_BADGES: Record<string, { label: string; className: string }> = {
  ctw: { label: "CTW", className: "bg-[#eef6ff] text-[#347fdc]" },
  rdl: { label: "RDL", className: "bg-[#eef6ff] text-[#347fdc]" },
  rap: { label: "RAP", className: "bg-[#eef6ff] text-[#347fdc]" },
   bas: { label: "BAS", className: "bg-student-primary-soft text-student-primary" },
   write_email: { label: "WE", className: "bg-student-primary-soft text-student-primary" },
   academic_discussion: { label: "AD", className: "bg-student-primary-soft text-student-primary" }
};

export function WordbookTable({ domain, items }: { domain: WordbookDomain; items: WordbookItem[] }) {
  const headers = WORDBOOK_HEADERS[domain];
  return <table className={`${styles.table} ${domain === "reading" ? "reading-theme" : ""}`} aria-label={`${domain === "reading" ? "Reading" : "Writing"} 生词表`}>
    <colgroup><col style={{ width: "16%" }} /><col style={{ width: "6%" }} /><col style={{ width: "23%" }} /><col style={{ width: "37%" }} /><col style={{ width: "18%" }} /></colgroup>
    <thead><tr>{headers.map(header => <th scope="col" key={header}>{header}</th>)}</tr></thead>
    {items.map(item => {
      const rows = wordbookContextRows(item);
      const enrichment = <Enrichment item={item} domain={domain} />;
      return <tbody key={item.wordbookEntryId} data-wordbook-entry={item.wordbookEntryId}>
        {rows.map((row, index) => <tr key={`${row.sense.senseId}:${row.example?.exampleId ?? "none"}`}>
          {index === 0 ? <td rowSpan={rows.length} className={styles.word} data-label="单词"><div className="flex flex-wrap items-start gap-1.5">
            <strong className="text-base font-semibold">{item.expression}</strong><span className="flex flex-wrap gap-1">{item.sourceTypes.map(source => {
              const badge = SOURCE_BADGES[source];
              return badge ? <span key={source} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${badge.className}`}>{badge.label}</span> : null;
            })}</span></div></td> : null}
          {row.first ? <><td rowSpan={row.span} data-label="词性" className={styles.pos}>{wordbookPos(row.sense.contextPos)}</td>
            <td rowSpan={row.span} data-label="语境义" className={styles.meaning}><p>{row.sense.contextMeaningZh}</p>{row.sense.contextDefinitionEn ? <p className="mt-1 text-xs leading-5 text-student-muted">{row.sense.contextDefinitionEn}</p> : null}</td></> : null}
          <td data-label="例句" className={styles.example}>{row.example ? <WordbookExample key={row.example.exampleId} text={row.example.text} /> : "—"}</td>
          {index === 0 ? <td rowSpan={rows.length} data-label={headers[4]} className={styles.desktopEnrichment}>{enrichment}</td> : null}
        </tr>)}
        <tr className={styles.mobileEnrichment}><td colSpan={5} data-label={headers[4]}>{enrichment}</td></tr>
      </tbody>;
    })}
  </table>;
}

function Enrichment({ item, domain }: { item: WordbookItem; domain: WordbookDomain }) {
  const values = item.enrichmentItems.filter(value => value.field === (domain === "reading" ? "derived_words" : "useful_patterns"));
  if (!values.length) return <>—</>;
  return <ul className="grid gap-2">{values.map((entry, index) => {
    const value = entry.value as Record<string, unknown> | null;
    const title = value && typeof value === "object" ? value.expression ?? value.pattern : entry.value;
    const meaning = value && typeof value === "object" ? value.meaning_zh : null;
    return <li key={index}><span>{typeof title === "string" ? title : JSON.stringify(entry.value)}</span>
      {typeof meaning === "string" ? <span className="mt-0.5 block text-xs text-student-muted">{meaning}</span> : null}
      {entry.hasConflict ? <span className="mt-0.5 block text-xs text-student-muted">不同来源释义均保留</span> : null}</li>;
  })}</ul>;
}
