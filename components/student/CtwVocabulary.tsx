"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { StudentNavigation } from "./StudentUI";
import { useVocabularyRead, useVocabularyRequest } from "./useCtwVocabulary";
import type { AttemptResult, AttemptSummary, ListSource, VocabularyListCard, VocabularyEntry } from "@/lib/ctw-vocabulary/model";
import { AssignmentStatusBadge } from "@/components/assignments/AssignmentPresentation";
import { createVocabularyRound, FORM_LABELS, POS_LABELS, listLabel, roundKey, sourceReturnHref, VOCABULARY_API as API,
  VOCABULARY_ROOT as ROOT, vocabularyResultGroups, writeVocabularyRound } from "@/lib/ctw-vocabulary/round";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";

export function VocabularyFailure({ error, retry }: { error?: string; retry?: () => void }) {
  return error ? <div role="alert" className="grid gap-2 text-sm text-student-error"><p>{error}</p>
    {retry ? <button type="button" className="student-button-secondary justify-self-start" onClick={retry}>重试</button> : null}</div> : null;
}
export function VocabularyNavigation({ label, backHref = ROOT }: { label?: string; backHref?: string }) {
  return <StudentNavigation backHref={backHref} crumbs={[
    { label: "学生首页", href: STUDENT_ROUTES.home },
    { label: "填词题词表", ...(label ? { href: ROOT } : {}) }, ...(label ? [{ label }] : [])
  ]} />;
}
function useStartVocabularyRound() {
  const router = useRouter(), { request, studentId } = useVocabularyRequest();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const start = async (source: ListSource) => {
    if (lock.current || !studentId) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const data = await request<{ items: VocabularyEntry[] }>(`${API}/lists/start`, source);
      const round = createVocabularyRound(studentId, crypto.randomUUID(), source, data.items);
      try { writeVocabularyRound(localStorage, round); } catch { throw new Error("无法保存本机进度，请允许浏览器本地存储后重试。"); }
      router.push(`${ROOT}/session/${round.attemptId}`);
    } catch (e) { setError(e instanceof Error ? e.message : "创建失败，请重试。"); }
    finally { lock.current = false; setBusy(false); }
  };
  return { start, busy, error };
}
export function VocabularyPendingRounds() {
  const { studentId } = useVocabularyRequest();
  const [ids, setIds] = useState<string[]>([]);
  useEffect(() => {
    const update = () => {
      const pending: string[] = [];
      try {
        if (studentId) for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith(roundKey(studentId, ""))) continue;
          const value = JSON.parse(localStorage.getItem(key) ?? "null");
          if (value?.owner === studentId && value.phase !== "saved") pending.push(value.attemptId);
        }
      } catch { /* Workspace reports storage errors without discarding progress. */ }
      setIds(pending);
    };
    update(); window.addEventListener("focus", update); window.addEventListener("storage", update);
    return () => { window.removeEventListener("focus", update); window.removeEventListener("storage", update); };
  }, [studentId]);
  return ids.length ? <div className="grid gap-2 text-sm">{ids.map(id => <Link key={id} className="text-student-primary underline" href={`${ROOT}/session/${id}`}>继续未完成的学习 / 测试</Link>)}</div> : null;
}
export function CtwVocabularyCatalog() {
  const params = useSearchParams(), router = useRouter();
  const edition = params.get("tab") === "cefr" ? "cefr" : "mixed";
  const catalog = useVocabularyRead<{ lists: VocabularyListCard[] }>(`${API}/lists?edition=${edition}`);
  const { start, busy, error } = useStartVocabularyRound();
  const [selected, setSelected] = useState<VocabularyListCard | null>(null);
  const retryCatalog = catalog.retry;
  useEffect(() => { window.addEventListener("focus", retryCatalog); return () => window.removeEventListener("focus", retryCatalog); }, [retryCatalog]);
  return <div className="grid gap-6">
    <VocabularyNavigation backHref={STUDENT_ROUTES.home} />
    <div className="flex flex-wrap items-end justify-between gap-3"><div role="tablist" aria-label="词表版本" className="flex gap-1 border-b border-student-border">
      {([['mixed','乱序版'],['cefr','CEFR']] as const).map(([value,label]) => <button type="button" key={value} role="tab" aria-selected={edition === value}
        className={`border-b-2 px-5 py-3 text-sm font-semibold ${edition === value ? "border-student-primary text-student-primary" : "border-transparent text-student-muted"}`}
        onClick={() => { setSelected(null); router.replace(value === "cefr" ? `${ROOT}?tab=cefr` : ROOT, { scroll: false }); }}>{label}</button>)}
    </div><Link href={`${ROOT}/history`} className="student-button-secondary">测试历史</Link></div>
    <VocabularyPendingRounds />
    {catalog.loading ? <p className="text-sm text-student-muted">正在加载词表…</p> : null}
    <VocabularyFailure error={catalog.error} retry={catalog.retry} />
    <div role="tabpanel" aria-label={edition === "mixed" ? "乱序版词表" : "CEFR 词表"} className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4">{catalog.data?.lists.map(list =>
      <button type="button" key={`${list.group}:${list.listNumber}`} className="student-card student-card-interactive grid min-h-[164px] content-start gap-3 p-4 text-left sm:p-5"
        onClick={() => setSelected(list)}><span className="text-lg font-bold">{listLabel(list.listNumber)}</span>
        <span className="text-sm text-student-muted">{list.count} 词</span>
        <span className="flex flex-wrap items-center gap-2">
          {edition === "cefr" ? <span className="student-chip text-xs">{list.group === "C1-C2" ? "C1–C2" : list.group}</span> : null}
          <AssignmentStatusBadge completedCount={list.status === "completed" ? 2 : list.status === "in_progress" ? 1 : 0}
            totalCount={2} label={list.status === "not_started" ? "未开始" : undefined} />
        </span><span className="text-xs leading-5 text-student-muted">历史最高正确率：{list.bestAccuracy === null ? "—" : `${Number(list.bestAccuracy.toFixed(2))}%`}</span></button>)}</div>
    <ConfirmDialog open={selected !== null} title={`开始学习 ${selected?.group ? `${selected.group === "C1-C2" ? "C1–C2" : selected.group} ` : ""}${listLabel(selected?.listNumber ?? 1)}？`} confirmText="确认" cancelText="取消"
      confirming={busy} error={error} onCancel={() => { if (!busy) setSelected(null); }}
      onConfirm={() => { if (selected) void start(selected.edition === "mixed" ? { kind: "list", listNumber: selected.listNumber }
        : { kind: "cefr_list", group: selected.group as "A1" | "A2" | "B1" | "B2" | "C1-C2", listNumber: selected.listNumber }); }} />
  </div>;
}
export function CtwVocabularyResultView({ result }: { result: AttemptResult }) {
  const groups = vocabularyResultGroups(result), correct = groups.filter(group => group.correct).length;
  const source = result.answers[0]?.source, backHref = sourceReturnHref(source);
  return <div className="grid gap-8">
    <VocabularyNavigation label="测试结果" backHref={backHref} />
    <div className="reading-theme grid gap-8 text-center" data-vocabulary-persistence="saved">
      <div><p className="text-sm text-student-muted">正确率</p><p className="mt-2 text-6xl font-bold text-student-primary">{Math.round(correct / Math.max(1, groups.length) * 100)}%</p></div>
      <dl className="grid grid-cols-3 gap-3">{[["词条总数", groups.length], ["完全正确", correct], ["错误词条", groups.length - correct]].map(([label, value]) =>
        <div key={label}><dt className="text-sm text-student-muted">{label}</dt><dd className="mt-2 text-3xl font-semibold">{value}</dd></div>)}</dl>
      <div className="flex flex-wrap justify-center gap-3"><Link href={backHref} className="student-button-primary">返回填词题词表</Link>
        <Link href={`${ROOT}/history`} className="student-button-secondary">测试历史</Link></div>
    </div>
    <section aria-label="拼写详情" className="grid gap-4"><h2 className="text-lg font-bold">错词详情与拼写结果</h2>
      {[...groups].sort((a, b) => Number(a.correct) - Number(b.correct)).map(group => <article key={group.entryId} className="student-card grid gap-3 p-5 [overflow-wrap:anywhere]">
        <header className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xl font-bold">{group.word}</h3>
          <span className={group.correct ? "text-sm text-student-primary" : "text-sm text-student-error"}>{group.correct ? "完全正确" : "错误词条"}</span></header>
        <div className="grid gap-1 text-sm text-student-muted">{group.senses.map((sense, i) => <p key={i}>{POS_LABELS[sense.pos]} · {sense.meaning_zh}</p>)}</div>
        {group.answers.map((answer, i) => <div key={i} className="grid gap-2 text-sm">
          <SpellingResult label={answer.formType ? FORM_LABELS[answer.formType] : answer.irregularResults?.length ? "原形" : "拼写"} spelling={answer.spelling}
            accepted={answer.acceptedAnswers} correct={answer.baseCorrect ?? answer.correct} />
          {answer.irregularResults?.map(form => <SpellingResult key={form.formType} label={FORM_LABELS[form.formType]} spelling={form.spelling} accepted={form.acceptedAnswers} correct={form.correct} />)}
        </div>)}
      </article>)}
    </section>
  </div>;
}
function SpellingResult({ label, spelling, accepted, correct }: { label: string; spelling: string; accepted: string[]; correct: boolean }) {
  return <div className="grid gap-1 border-t border-student-border pt-2"><p><span className="font-semibold">{label}</span> · <span className={correct ? "text-student-primary" : "text-student-error"}>{correct ? "正确" : "错误"}</span></p>
    <p>你的拼写：{spelling || "未填写"}</p><p>正确拼写：<strong>{accepted.join(" / ")}</strong></p></div>;
}
export function CtwVocabularyResult({ attemptId }: { attemptId: string }) {
  const result = useVocabularyRead<AttemptResult>(`${API}/attempts/${encodeURIComponent(attemptId)}`);
  return <>{result.loading ? <p className="text-sm text-student-muted">正在读取已保存结果…</p> : null}<VocabularyFailure error={result.error} retry={result.retry} />
    {result.data ? <CtwVocabularyResultView result={result.data} /> : null}</>;
}
export function CtwVocabularyHistory() {
  const [page, setPage] = useState(1);
  const history = useVocabularyRead<{ items: AttemptSummary[]; hasMore: boolean }>(`${API}/attempts?page=${page}&pageSize=10`);
  return <div className="grid gap-5"><VocabularyNavigation label="测试历史" /><VocabularyPendingRounds />
    {history.loading ? <p className="text-sm text-student-muted">正在加载测试历史…</p> : null}<VocabularyFailure error={history.error} retry={history.retry} />
    {history.data?.items.map(item => <Link key={item.attempt_id} className="student-card student-card-interactive flex flex-wrap items-center justify-between gap-3 p-5"
      href={`${ROOT}/results/${item.attempt_id}`}><div className="grid gap-2"><strong>{new Date(item.submitted_at).toLocaleString("zh-CN")}</strong>
        <span className="text-sm text-student-muted">{item.list_numbers.map(listLabel).join("、")} · {item.cefr_levels.join(" / ")}</span></div>
      <span className="text-sm text-student-primary">查看结果</span></Link>)}
    {history.data && !history.data.items.length ? <p className="text-sm text-student-muted">暂无已保存的测试记录。</p> : null}
    <div className="flex items-center justify-between gap-3 text-sm"><span>第 {page} 页</span><div className="flex gap-2">
      <button type="button" className="student-button-secondary" disabled={page <= 1 || history.loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" className="student-button-secondary" disabled={!history.data?.hasMore || history.loading} onClick={() => setPage(value => value + 1)}>下一页</button></div></div>
  </div>;
}
