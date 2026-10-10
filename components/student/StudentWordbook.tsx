"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { StudentNavigation } from "@/components/student/StudentUI";
import { StudentDateSelection } from "@/components/student/StudentDateSelection";
import { WordbookExample } from "./WordbookExample";
import { wordbookPos } from "@/lib/lexical/wordbookPresentation";
import { ChevronDown } from "lucide-react";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { wordbookSerial, wordbookSelectionIdentity } from "@/lib/lexical/wordbookManagement";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { addDays, boundedCalendarMonth, boundedDateDraft, browserTimeZone, formatDateInputValue, startOfLocalDay } from "@/lib/studentDates";
import { WORDBOOK_HEADERS, wordbookContextRows, type WordbookDomain, type WordbookItem, type WordbookList } from "@/lib/lexical/wordbookList";
import styles from "./StudentWordbook.module.css";

type Filters = { start: string; end: string; sort: "newest" | "oldest"; page: number };
const emptyFilters: Filters = { start: "", end: "", sort: "newest", page: 1 };

export function StudentWordbook() {
  const { getSession, studentId } = useStudentDataCache();
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
  const [managing, setManaging] = useState(false);
  const [selection, setSelection] = useState<{ identity: string; ids: string[] }>({ identity: "", ids: [] });
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [message, setMessage] = useState("");
  const deletingRef = useRef(false);
  const ownerRef = useRef(studentId);
  ownerRef.current = studentId;
  useEffect(() => { setManaging(false);setSelection({ identity: "", ids: [] });setConfirming(false);setDeleteError("");setMessage(""); }, [studentId]);
  const selectionIdentity = wordbookSelectionIdentity(studentId, domain, active);
  const selected = selection.identity === selectionIdentity ? selection.ids : [];
  const clearSelection = () => { setSelection({ identity: "", ids: [] });setConfirming(false);setDeleteError(""); };
  const selectEntries = (ids: string[]) => { setSelection({ identity: selectionIdentity, ids });setDeleteError(""); };
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
  const update = (changes: Partial<Filters>) => { clearSelection();setMessage("");setFilters(previous => ({ ...previous, [domain]: { ...previous[domain], ...changes } })); };
  const switchDomain = (next: WordbookDomain) => {
    if (next === domain) return;
    if (deletingRef.current) return;
    setManaging(false);clearSelection();setMessage("");
    // Dates never survive a tab switch, including when returning to the old tab.
    // Keep each domain's sort; reset both pages along with applied/draft dates.
    setFilters(previous => ({ reading: { ...previous.reading, start: "", end: "", page: 1 }, writing: { ...previous.writing, start: "", end: "", page: 1 } }));
    setDraft({ start: "", end: "" });setMonth(startOfLocalDay());setDomain(next);
  };
  const items = list.data?.items ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.pageSize ?? 20)));
  // A cancellation in another tab may leave an empty last page. Correct once.
  useEffect(() => { if (list.data && active.page > pages) setFilters(previous => ({ ...previous, [domain]: { ...previous[domain], page: pages } })); }, [list.data, active.page, pages, domain]);

  const deleteSelected = async () => {
    if (deletingRef.current || !selected.length || list.loading) return;
    const ids = [...selected], owner = studentId;
    deletingRef.current = true;setDeleting(true);setDeleteError("");setMessage("");
    try {
      const token = getSession()?.accessToken;
      if (!token || !owner) throw new Error("请重新登录。");
      const response = await fetch("/api/student/wordbook/batch-delete", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ domain, entryIds: ids }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "批量删除失败，请稍后重试。");
      if (result.domain !== domain || result.deletedCount !== ids.length || !Array.isArray(result.deletedEntryIds)
        || result.deletedEntryIds.length !== ids.length || new Set(result.deletedEntryIds).size !== ids.length
        || result.deletedEntryIds.some((id: string) => !ids.includes(id))) throw new Error("删除结果未确认，请刷新后重试。");
      if (ownerRef.current !== owner) return;
      clearSelection();setMessage(`已删除 ${result.deletedCount} 个词条。`);
      // Both read identities change immediately; stale responses cannot restore deletions.
      setRevision(value => value + 1);
    } catch (error) { if (ownerRef.current === owner) setDeleteError(error instanceof Error ? error.message : "删除失败。"); }
    finally { deletingRef.current = false;setDeleting(false); }
  };

  return <div className="grid min-w-0 gap-5">
    <StudentNavigation backHref={STUDENT_ROUTES.home} crumbs={[{ label: "学生首页", href: STUDENT_ROUTES.home }, { label: "生词本" }]} />
    <div aria-label="生词本分类" role="tablist" className={`flex gap-1 border-b border-student-border ${domain === "reading" ? "reading-theme" : ""}`}>
      {(["reading", "writing"] as const).map(tab => <button id={`wordbook-tab-${tab}`} aria-controls={`wordbook-panel-${tab}`} aria-selected={domain === tab} role="tab" type="button" key={tab}
        disabled={deleting} tabIndex={domain === tab ? 0 : -1} onClick={() => switchDomain(tab)}
        onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "reading" : event.key === "End" ? "writing" : domain === "reading" ? "writing" : "reading"; switchDomain(next); document.getElementById(`wordbook-tab-${next}`)?.focus(); } }}
        className={`border-b-2 px-5 py-3 text-sm font-semibold transition ${domain === tab ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}>
        {tab === "reading" ? "Reading" : "Writing"}
      </button>)}
    </div>
    <div className={`flex flex-wrap items-center justify-between gap-3 ${domain === "reading" ? "reading-theme" : ""}`}>
      <fieldset disabled={deleting} className={`flex min-w-0 flex-wrap items-center gap-2 ${domain === "reading" ? styles.readingDateControls : ""}`}>
        <StudentDateSelection key={domain} draft={draft} onDraftChange={setDraft} rangeLabel="查看日期范围" bounds={bounds}
          hint="单日或范围内有收藏活动的词汇，展示其当前全部语境。"
          onApply={close => { const range = boundedDateDraft(draft, { ...bounds, max: formatDateInputValue(new Date()) }); if (!range) return; update({ ...range, page: 1 }); close(); }}
          onClear={() => { setDraft({ start: "", end: "" });update({ start: "", end: "", page: 1 }); }}
          activity={{ month, onMonthChange: value => { const next = boundedCalendarMonth(value, bounds); setMonth(previous => formatDateInputValue(previous).slice(0, 7) === formatDateInputValue(next).slice(0, 7) ? previous : next); }, dates: dates.data?.dates ?? [], error: dates.error, loading: dates.loading, showToday: true, resetMonthOnOpen: true }} />
        <span className="text-sm text-student-muted">{active.start ? active.start === active.end ? active.start : `${active.start} — ${active.end}` : "全部日期"}</span>
        {active.start ? <button type="button" className="text-xs text-student-primary hover:underline" onClick={() => { setDraft({ start: "", end: "" });update({ start: "", end: "", page: 1 }); }}>清除</button> : null}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/student/wordbook/review?domain=${domain}`} aria-disabled={deleting}
          onClick={event => { if (deleting) event.preventDefault(); }} className={`student-button-primary ${deleting ? "pointer-events-none opacity-50" : ""}`}>开始复习</Link>
        {managing ? <><button type="button" className="student-button-secondary" disabled={!selected.length || deleting || list.loading}
          onClick={() => { setDeleteError("");setConfirming(true); }}>删除{selected.length ? ` (${selected.length})` : ""}</button>
          <button type="button" className="student-button-secondary" disabled={deleting} onClick={() => { setManaging(false);clearSelection(); }}>取消</button></>
          : <button type="button" className="student-button-secondary" disabled={list.loading} onClick={() => { clearSelection();setMessage("");setManaging(true); }}>管理</button>}
      <label className="flex items-center gap-2 text-sm text-student-muted">排序
        <span className="relative inline-flex items-center"><select disabled={deleting} aria-label="生词本排序" className="teacher-input min-w-0 appearance-none !pr-9" value={active.sort} onChange={event => update({ sort: event.target.value as Filters["sort"], page: 1 })}>
          <option value="newest">最新优先</option><option value="oldest">最早优先</option>
        </select><ChevronDown aria-hidden="true" size={16} className="pointer-events-none absolute right-3 text-student-muted" /></span>
      </label>
      </div>
    </div>
    {message ? <p role="status" className="text-sm text-student-primary">{message}</p> : null}
    {deleteError && !confirming ? <p role="alert" className="text-sm text-student-error">{deleteError}</p> : null}
    <section id={`wordbook-panel-${domain}`} role="tabpanel" aria-labelledby={`wordbook-tab-${domain}`} aria-busy={list.loading || deleting} className={`min-w-0 ${domain === "reading" ? "reading-theme" : ""}`}>
      <WordbookTable domain={domain} items={items} page={active.page} pageSize={list.data?.pageSize ?? 20}
        managing={managing} selected={selected} onSelectionChange={selectEntries} disabled={deleting || list.loading} />
      <div aria-live="polite">
        {list.loading ? <p className="py-8 text-center text-sm text-student-muted">正在加载生词本…</p> : null}
        {list.error ? <div className="py-8 text-center text-sm text-student-muted"><p>{list.error}</p><button type="button" className="student-button-secondary mt-3" onClick={() => setRevision(value => value + 1)}>重试</button></div> : null}
        {!list.loading && !list.error && list.data && !items.length ? <p className="py-12 text-center text-sm text-student-muted">{active.start ? "所选日期没有收藏活动。可清除日期筛选查看全部词汇。" : `还没有 ${domain === "reading" ? "Reading" : "Writing"} 生词。在练习查词卡中点击收藏，即可保留词汇及原题语境。`}</p> : null}
      </div>
      {list.data && list.data.total > 0 ? <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted">
        <span>共 {list.data.total} 个词条 · 第 {active.page} / {pages} 页</span>
         <div className="flex gap-2"><button className="student-button-secondary" type="button" disabled={active.page <= 1 || list.loading || deleting} onClick={() => update({ page: active.page - 1 })}>上一页</button>
           <button className="student-button-secondary" type="button" disabled={active.page >= pages || list.loading || deleting} onClick={() => update({ page: active.page + 1 })}>下一页</button></div>
      </div> : null}
    </section>
    <ConfirmDialog open={confirming} title={`确认删除选中的 ${selected.length} 个词条吗？`}
      message="删除后将移除这些词条的收藏义项、例句及收藏活动记录，不影响题库或另一分类的收藏。"
      confirmText="确认删除" cancelText="取消" confirming={deleting} error={deleteError}
      onConfirm={() => void deleteSelected()} onCancel={() => { if (!deletingRef.current) setConfirming(false); }} />
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

export function WordbookTable({ domain, items, page = 1, pageSize = 20, managing = false, selected = [], onSelectionChange = () => {}, disabled = false }: {
  domain: WordbookDomain; items: WordbookItem[]; page?: number; pageSize?: number;
  managing?: boolean; selected?: string[]; onSelectionChange?: (ids: string[]) => void; disabled?: boolean;
}) {
  const headers = WORDBOOK_HEADERS[domain];
  const allSelected = items.length > 0 && items.every(item => selected.includes(item.wordbookEntryId));
  const partiallySelected = !allSelected && items.some(item => selected.includes(item.wordbookEntryId));
  return <table className={`${styles.table} ${managing ? styles.managing : ""} ${domain === "reading" ? "reading-theme" : ""}`} aria-label={`${domain === "reading" ? "Reading" : "Writing"} 生词表`}>
    <colgroup>{(managing ? [6, 4, 15, 6, 22, 33, 14] : [4, 16, 6, 23, 37, 14]).map((width, i) => <col key={i} style={{ width: `${width}%` }} />)}</colgroup>
    <thead><tr>{managing ? <th scope="col" className={styles.selection}><label className={styles.selectAll}>
      <WordbookCheckbox label="全选当前页" checked={allSelected} mixed={partiallySelected} disabled={disabled || !items.length}
        onChange={() => onSelectionChange(allSelected ? [] : items.map(item => item.wordbookEntryId))} /><span>全选</span></label></th> : null}
      {headers.map(header => <th scope="col" className={header === "序号" ? styles.serial : header === "词性" ? styles.pos : undefined} key={header}>{header}</th>)}</tr></thead>
    {items.map((item, itemIndex) => {
      const rows = wordbookContextRows(item);
      const serial = wordbookSerial(page, pageSize, itemIndex);
      const enrichment = <Enrichment item={item} domain={domain} />;
      return <tbody key={item.wordbookEntryId} data-wordbook-entry={item.wordbookEntryId}>
        {rows.map((row, index) => <tr key={`${row.sense.senseId}:${row.contextId}:${row.example?.exampleId ?? "none"}`}>
          {index === 0 ? <>{managing ? <td rowSpan={rows.length} className={styles.selection}>
            <WordbookCheckbox label={`选择词条 ${item.expression}（${serial}）`} checked={selected.includes(item.wordbookEntryId)} disabled={disabled}
              onChange={() => onSelectionChange(selected.includes(item.wordbookEntryId) ? selected.filter(id => id !== item.wordbookEntryId) : [...selected, item.wordbookEntryId])} />
           </td> : null}<td rowSpan={rows.length} className={styles.serial} data-label="序号">{serial}</td></> : null}
           {row.first ? <td rowSpan={row.span} className={styles.word} data-label="词条"><div className="flex flex-wrap items-start gap-1.5">
             <strong className="text-base font-semibold">{row.expression}</strong><span className="flex flex-wrap gap-1">{row.sources.map(source => {
              const badge = SOURCE_BADGES[source];
              return badge ? <span key={source} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-4 ${badge.className}`}>{badge.label}</span> : null;
             })}</span></div>{row.expression !== item.expression ? <p className="mt-1 text-xs text-student-muted">标准词条：{item.expression}</p> : null}</td> : null}
          {row.first ? <><td rowSpan={row.span} data-label="词性" className={styles.pos}>{wordbookPos(row.sense.contextPos)}</td>
            <td rowSpan={row.span} data-label="语境义" className={styles.meaning}><p>{row.sense.contextMeaningZh}</p>{row.sense.contextDefinitionEn ? <p className="mt-1 text-xs leading-5 text-student-muted">{row.sense.contextDefinitionEn}</p> : null}</td></> : null}
          <td data-label="例句" className={styles.example}>{row.example ? <WordbookExample key={row.example.exampleId} text={row.example.text} /> : "—"}</td>
          {index === 0 ? <td rowSpan={rows.length} data-label={headers[5]} className={styles.desktopEnrichment}>{enrichment}</td> : null}
        </tr>)}
        <tr className={styles.mobileEnrichment}><td colSpan={managing ? 7 : 6} data-label={headers[5]}>{enrichment}</td></tr>
      </tbody>;
    })}
  </table>;
}

function WordbookCheckbox({ label, checked, mixed = false, disabled, onChange }: {
  label: string; checked: boolean; mixed?: boolean; disabled: boolean; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} type="checkbox" aria-label={label} aria-checked={mixed ? "mixed" : checked}
    checked={checked} disabled={disabled} onChange={onChange} className={styles.checkbox} />;
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
