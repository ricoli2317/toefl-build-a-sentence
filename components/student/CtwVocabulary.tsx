"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BookText } from "lucide-react";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { AssignmentStatusBadge } from "@/components/assignments/AssignmentPresentation";
import { PracticeHistoryBadge } from "@/components/shared/PracticeHistoryRows";
import { StudentNavigation } from "./StudentUI";
import { WordbookReviewHistoryList } from "./WordbookReview";
import { CtwVocabularyReviewResult } from "./CtwVocabularyReviewResult";
import { useVocabularyRead, useVocabularyRequest } from "./useCtwVocabulary";
import { useCtwRetry } from "./useCtwReview";
import { gradeReview, localReview, localReviewKey, reviewLocalState, saveLocalReview, type LocalReview } from "@/lib/lexical/wordbookReviewLocal";
import type { ReviewHistory, ReviewRound } from "@/lib/lexical/wordbookReview";
import { CTW_REVIEW_NAMESPACE, CTW_REVIEW_ROOT, createCtwReviewRound, ctwCacheKey, ctwLegacyRowValues, ctwMetadata } from "@/lib/ctw-vocabulary/review";
import type { ListSource, VocabularyListCard } from "@/lib/ctw-vocabulary/model";
import { listLabel, readVocabularyRound, roundKey, sourceReturnHref, VOCABULARY_API as API, VOCABULARY_ROOT as ROOT } from "@/lib/ctw-vocabulary/round";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import styles from "./CtwVocabulary.module.css";

export function VocabularyFailure({ error, retry }: { error?: string; retry?: () => void }) {
  return error ? <div role="alert" className="grid gap-2 text-sm text-student-error"><p>{error}</p>
    {retry ? <button type="button" className="student-button-secondary justify-self-start" onClick={retry}>重试</button> : null}</div> : null;
}
export function VocabularyNavigation({ label, backHref = ROOT }: { label?: string; backHref?: string }) {
  return <StudentNavigation backHref={backHref} crumbs={[{ label: "学生首页", href: STUDENT_ROUTES.home },
    { label: "填词题词表", ...(label ? { href: ROOT } : {}) }, ...(label ? [{ label }] : [])]} />;
}
function sourceOf(card: VocabularyListCard): ListSource {
  return card.edition === "mixed" ? { kind: "list", listNumber: card.listNumber }
    : { kind: "cefr_list", group: card.group as "A1" | "A2" | "B1" | "B2" | "C1-C2", listNumber: card.listNumber };
}
/** Both editions use exactly this card. Status Badge is the unmodified shared
 * Assignment badge; typography changes apply only to the card's other fields. */
export function CtwVocabularyListCard({ list, onClick }: { list: VocabularyListCard; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`student-card-interactive ${styles.card}`}>
    <span className={styles.heading}><span className={styles.title}>{listLabel(list.listNumber)}</span>
      <AssignmentStatusBadge className={styles.status} completedCount={list.status === "completed" ? 2 : list.status === "in_progress" ? 1 : 0} totalCount={2}
        label={list.status === "not_started" ? "未开始" : undefined} /></span>
    <span className={styles.metadata}>
      {list.edition === "cefr" ? <span className={styles.level}>{list.group.replace("-", "–")}</span> : null}
      <span className={styles.count}><BookText aria-hidden="true" size={19} className="text-student-muted" /><span><strong>{list.count}</strong> 个词条</span></span>
    </span>
    <span className={styles.best}><span>历史最高正确率</span>
      <strong className={list.bestAccuracy === 100 ? "text-emerald-700" : "text-student-text"}>{list.bestAccuracy === null ? "—" : `${Number(list.bestAccuracy.toFixed(2))}%`}</strong></span>
  </button>;
}
export function CtwVocabularyCatalog() {
  const params = useSearchParams(), router = useRouter(), { request, studentId } = useVocabularyRequest();
  const { updateData, markStale } = useStudentDataCache();
  const edition = params.get("tab") === "cefr" ? "cefr" : "mixed", url = `${API}/lists?edition=${edition}`;
  const catalog = useVocabularyRead<{ lists: VocabularyListCard[] }>(url);
  const [selected, setSelected] = useState<VocabularyListCard | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false), pending = useRef<{ key: string; id: string }>();
  const start = async () => {
    if (!selected || !studentId || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const source = sourceOf(selected), key = JSON.stringify([studentId, source]);
      if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
      const round = await request<ReviewRound>(CTW_REVIEW_ROOT, { source, requestId: pending.current.id });
      saveLocalReview(localStorage, localReview(studentId, round), CTW_REVIEW_NAMESPACE);
      updateData<{ lists: VocabularyListCard[] }>(ctwCacheKey(url), value => ({ lists: value.lists.map(list => list.group === selected.group && list.listNumber === selected.listNumber
        ? { ...list, status: list.status === "not_started" ? "in_progress" : list.status } : list) }));
      markStale(ctwCacheKey(CTW_REVIEW_ROOT)); router.push(`${ROOT}/session/${round.session.session_id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "开始失败，请重试。"); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="grid gap-6"><VocabularyNavigation backHref={STUDENT_ROUTES.home} />
    <div className="flex flex-wrap items-end justify-between gap-3"><div role="tablist" aria-label="词表版本" className="flex gap-1 border-b border-student-border">
      {([['mixed','乱序版'],['cefr','CEFR']] as const).map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={edition === value}
        className={`border-b-2 px-5 py-3 text-sm font-semibold ${edition === value ? "border-student-primary text-student-primary" : "border-transparent text-student-muted"}`}
        onClick={() => { setSelected(null); setError(""); router.replace(value === "cefr" ? `${ROOT}?tab=cefr` : ROOT, { scroll: false }); }}>{label}</button>)}</div>
      <Link href={`${ROOT}/history`} className="student-button-secondary">测试历史</Link></div>
    {catalog.loading ? <p className="text-sm text-student-muted">正在加载词表…</p> : null}<VocabularyFailure error={catalog.error} retry={catalog.retry} />
    <div role="tabpanel" aria-label={edition === "mixed" ? "乱序版词表" : "CEFR 词表"} className={styles.catalog}>
      {catalog.data?.lists.map(list => <CtwVocabularyListCard key={`${list.group}:${list.listNumber}`} list={list} onClick={() => setSelected(list)} />)}</div>
    <ConfirmDialog open={Boolean(selected)} title={`开始学习 ${selected?.group ? `${selected.group.replace("-", "–")} ` : ""}${listLabel(selected?.listNumber ?? 1)}？`}
      confirmText="确认" cancelText="取消" confirming={busy} error={error} onCancel={() => { if (!busy) setSelected(null); }} onConfirm={() => void start()} />
  </div>;
}
export function CtwVocabularyResult({ attemptId }: { attemptId: string }) {
  const result = useVocabularyRead<ReviewRound>(`${CTW_REVIEW_ROOT}/${encodeURIComponent(attemptId)}?round=1`), retry = useCtwRetry();
  return <div className="grid gap-6"><VocabularyNavigation label="测试结果" backHref={result.data ? sourceReturnHref(ctwMetadata(result.data).source) : ROOT} />
    {result.loading ? <p className="text-sm text-student-muted">正在读取已保存结果…</p> : null}
    <VocabularyFailure error={result.error || retry.error} retry={result.retry} />
    {result.data?.session.status === "completed" ? <CtwVocabularyReviewResult round={result.data} state={result.data} busy={retry.busy} onRetry={() => void retry.retry(result.data!)} />
      : result.data ? <div role="status" className="grid justify-items-start gap-3"><p>本轮尚未完成，不能作为已保存的最终成绩。</p><Link className="student-button-secondary" href={`${ROOT}/session/${attemptId}`}>恢复复习</Link></div> : null}
  </div>;
}
function pendingHistory(owner: string): ReviewHistory["items"] {
  const items: ReviewHistory["items"] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i); if (!key) continue;
    if (key.startsWith(roundKey(owner, ""))) {
      const old = readVocabularyRound(localStorage, owner, key.slice(roundKey(owner, "").length));
      if (!old || old.phase === "saved" || old.source.kind === "cefr") continue;
      const round = createCtwReviewRound(old.attemptId, old.source, old.entries), state = localReview(owner, round);
      for (const a of old.answers) {
        const card = round.cards.find(c => c.itemId === a.entryId)!;
        state.answers[a.entryId] = gradeReview(card, { spellings: { base: a.spelling,
          ...ctwLegacyRowValues(card, old.entries.find(entry => entry.entry_id === a.entryId)!, a.irregularSpellings) } });
      }
      const projected = reviewLocalState(state);
      items.push({ ...projected.session, status: "active", started_at: "", summary: projected.summary, ...{ source: old.source } });
      continue;
    }
    if (!key.startsWith(localReviewKey(owner, "", CTW_REVIEW_NAMESPACE))) continue;
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as LocalReview | null;
    if (!saved || saved.owner !== owner || !saved.round || !Array.isArray(saved.queue)) throw new Error("本地待同步记录无法读取，请勿清理浏览器数据。");
    if (saved.phase === "result" && !saved.queue.length) continue;
    const projected = reviewLocalState(saved);
    items.push({ ...projected.session, status: "active", summary: projected.summary,
      ...{ source: ctwMetadata(saved.round).source } });
  }
  return items;
}
export function CtwVocabularyHistory() {
  const [page, setPage] = useState(1), { studentId } = useVocabularyRequest();
  const history = useVocabularyRead<ReviewHistory>(`${CTW_REVIEW_ROOT}?page=${page}`);
  const [local, setLocal] = useState<{ owner: string | null; items: ReviewHistory["items"]; error?: string }>({ owner: null, items: [] });
  useEffect(() => { const read = () => { try { setLocal({ owner: studentId, items: studentId ? pendingHistory(studentId) : [] }); }
    catch (e) { setLocal({ owner: studentId, items: [], error: e instanceof Error ? e.message : "本地进度读取失败。" }); } };
    read(); window.addEventListener("storage", read); return () => window.removeEventListener("storage", read);
  }, [studentId]);
  const pending = local.owner === studentId ? local.items : [];
  const items = history.data?.items.map(item => pending.find(p => p.session_id === item.session_id) ?? item) ?? [];
  const extra = page === 1 ? pending.filter(p => !items.some(item => item.session_id === p.session_id)) : [];
  const shown: ReviewHistory | undefined = history.data ? { ...history.data, items } : undefined;
  const href = (id: string, list: ReviewHistory["items"]) => `${ROOT}/${list.find(s => s.session_id === id)?.status === "completed" ? "results" : "session"}/${id}`;
  return <div className="grid gap-5"><VocabularyNavigation label="测试历史" />
    {history.loading ? <p className="text-sm text-student-muted">正在加载测试历史…</p> : null}
    <VocabularyFailure error={history.error || (local.owner === studentId ? local.error : undefined)} retry={history.retry} />
    {extra.length || shown ? <WordbookReviewHistoryList history={{ ...(shown ?? { total: 0, page, pageSize: 10 }), items: [...extra, ...(shown?.items ?? [])], total: extra.length + (shown?.total ?? 0) }}
      showSources={false} showPartialAccuracy rangeLabel={ctwHistoryTitle} badges={ctwHistoryBadges}
      resultHref={id => href(id, [...extra, ...(shown?.items ?? [])])} /> : null}
    <div className="flex items-center justify-between gap-3 text-sm font-medium"><span>第 {page} 页</span><div className="flex gap-2">
      <button type="button" className="student-button-secondary" disabled={page <= 1 || history.loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" className="student-button-secondary" disabled={!history.data || page * 10 >= history.data.total || history.loading} onClick={() => setPage(value => value + 1)}>下一页</button></div></div>
  </div>;
}

type CtwHistoryItem = ReviewHistory["items"][number] & { source?: ListSource };
function ctwHistoryTitle(session: CtwHistoryItem) {
  return session.source ? listLabel(session.source.listNumber) : "历史词测";
}
function ctwHistoryBadges(session: CtwHistoryItem) {
  return <><PracticeHistoryBadge>{session.source?.kind === "cefr_list" ? session.source.group.replace("-", "–") : "乱序版"}</PracticeHistoryBadge>
    {session.mode === "retry" ? <PracticeHistoryBadge>错词再练</PracticeHistoryBadge> : null}</>;
}
