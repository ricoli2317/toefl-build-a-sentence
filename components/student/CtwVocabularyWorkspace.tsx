"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog";
import { LetterSpelling, ReviewProgress, useReviewViewport } from "./WordbookReviewWorkspace";
import { useVocabularyRequest } from "./useCtwVocabulary";
import { VocabularyFailure } from "./CtwVocabulary";
import type { AttemptResult, IrregularFormType } from "@/lib/ctw-vocabulary/model";
import { assessVocabularyEntry, emptyVocabularyAnswer, FORM_LABELS, POS_LABELS, readVocabularyRound, sourceReturnHref,
  VOCABULARY_API as API, VOCABULARY_ROOT as ROOT, vocabularySpellingShape, vocabularySubmission,
  writeVocabularyRound, roundKey, type LocalVocabularyRound } from "@/lib/ctw-vocabulary/round";

export function CtwVocabularySession({ attemptId }: { attemptId: string }) {
  const { studentId } = useVocabularyRequest();
  return studentId ? <VocabularyWorkspace key={`${studentId}:${attemptId}`} owner={studentId} attemptId={attemptId} /> : <p>正在恢复登录状态…</p>;
}
function VocabularyWorkspace({ owner, attemptId }: { owner: string; attemptId: string }) {
  const router = useRouter(), { request } = useVocabularyRequest();
  const { workspace, viewport, keyboard } = useReviewViewport();
  const [round, setRound] = useState<LocalVocabularyRound | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [skip, setSkip] = useState(false), [revision, setRevision] = useState(0);
  const current = useRef<LocalVocabularyRound | null>(null), lock = useRef(false), abort = useRef<AbortController>();
  useEffect(() => {
    const controller = new AbortController(); abort.current = controller;
    setError("");
    const load = async () => {
      try {
        const local = readVocabularyRound(localStorage, owner, attemptId);
        if (local?.phase === "saved") { router.replace(`${ROOT}/results/${attemptId}`); return; }
        if (local) { current.current = local; setRound(local); return; }
        await request<AttemptResult>(`${API}/attempts/${encodeURIComponent(attemptId)}`, undefined, controller.signal);
        if (!controller.signal.aborted) router.replace(`${ROOT}/results/${attemptId}`);
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "无法恢复进度，请重试。"); }
    };
    void load();
    return () => controller.abort();
  }, [owner, attemptId, request, router, revision]);
  const update = (next: LocalVocabularyRound) => {
    try { writeVocabularyRound(localStorage, next); current.current = next; setRound(next); setError(""); return true; }
    catch { setError("无法保存本机进度；当前答案未丢弃。请释放浏览器存储空间后重试。"); return false; }
  };
  const save = useCallback(async () => {
    const latest = current.current, signal = abort.current?.signal;
    if (!latest || latest.phase !== "saving" || lock.current || signal?.aborted) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const result = await request<AttemptResult>(`${API}/attempts`, vocabularySubmission(latest), signal);
      if (signal?.aborted) return;
      if (result.attempt_id !== attemptId || result.answer_count !== latest.entries.length) throw new Error("保存响应不完整，请重试。");
      const saved = { ...latest, phase: "saved" as const, result };
      // The server has acknowledged persistence; storage failure cannot undo it.
      try { localStorage.removeItem(roundKey(owner, attemptId)); }
      catch { try { writeVocabularyRound(localStorage, saved); } catch { /* Read-only result is available on the server. */ } }
      current.current = saved; setRound(saved); router.replace(`${ROOT}/results/${attemptId}`);
    } catch (e) { if (!signal?.aborted) setError(`${e instanceof Error ? e.message : "提交失败。"} 本轮尚未确认保存；答案已保留，可重试。`); }
    finally { lock.current = false; if (!signal?.aborted) setBusy(false); }
  }, [owner, attemptId, request, router]);
  useEffect(() => { if (round?.phase === "saving") void save(); }, [round?.phase, save]);
  useEffect(() => { const retry = () => { if (current.current?.phase === "saving") void save(); };
    window.addEventListener("online", retry); return () => window.removeEventListener("online", retry); }, [save]);
  const entry = round?.entries[round.index], study = round?.phase === "study", saving = round?.phase === "saving" || round?.phase === "saved";
  const answer = round?.answers[round.index], feedback = entry && answer ? assessVocabularyEntry(entry, answer) : undefined;
  const confirm = () => {
    const latest = current.current;
    if (!latest || busy || latest.phase !== "test" || latest.answers[latest.index]) return;
    update({ ...latest, answers: [...latest.answers, latest.draft] });
  };
  const advance = () => {
    const latest = current.current; if (!latest || busy) return;
    if (latest.phase === "study") {
      if (latest.index + 1 === latest.entries.length) update({ ...latest, phase: "test", index: 0, draft: emptyVocabularyAnswer(latest.entries[0]) });
      else update({ ...latest, index: latest.index + 1 });
    } else if (latest.phase === "test" && latest.answers[latest.index]) {
      if (latest.index + 1 === latest.entries.length) update({ ...latest, phase: "saving" });
      else update({ ...latest, index: latest.index + 1, draft: emptyVocabularyAnswer(latest.entries[latest.index + 1]) });
    } else confirm();
  };
  const change = (spelling: string, formType?: IrregularFormType) => {
    const latest = current.current; if (!latest || latest.phase !== "test" || latest.answers[latest.index]) return;
    const draft = formType ? { ...latest.draft, irregularSpellings: latest.draft.irregularSpellings?.map(form => form.formType === formType ? { ...form, spelling } : form) }
      : { ...latest.draft, spelling };
    // Retain typed input in memory even when storage is temporarily full.
    const next = { ...latest, draft }; current.current = next; setRound(next);
    try { writeVocabularyRound(localStorage, next); setError(""); } catch { setError("当前输入暂未保存到本机，请释放浏览器存储空间；不要关闭页面。"); }
  };
  return <section ref={workspace} aria-label="填词题词表学习与测试" data-keyboard={keyboard}
    className={`${keyboard ? "relative min-h-screen" : "fixed inset-x-0 top-0 h-[100dvh]"} reading-theme flex min-w-0 flex-col overflow-x-hidden bg-white text-student-text`}
    style={!keyboard && viewport ? { height: viewport.height, top: viewport.top } : undefined}>
    <div className={`mx-auto flex ${keyboard ? "min-h-screen" : "h-full min-h-0"} w-full max-w-3xl min-w-0 flex-col px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-10 sm:pb-8 sm:pt-6`}>
      <header className="flex shrink-0 items-center gap-4 pb-4 sm:pb-6"><ReviewProgress study={study} total={round?.entries.length ?? 1}
        progress={saving ? round?.entries.length ?? 0 : study ? (round?.index ?? 0) + 1 : round?.answers.length ?? 0} />
        {study ? <button type="button" className="min-h-11 shrink-0 text-sm text-student-primary" onClick={() => setSkip(true)}>跳过复习</button> : null}
        <Link className="inline-flex min-h-11 shrink-0 items-center text-sm text-student-primary" href={sourceReturnHref(round?.source)}>暂停</Link>
      </header>
      <div className={`${keyboard ? "shrink-0 py-8" : "min-h-0 flex-1 overflow-y-auto overscroll-contain py-6"} grid min-w-0`}>
        <div className="my-auto grid min-w-0 gap-8 py-4">{!round ? <p className="text-center">{error ? "本轮未能恢复。" : "正在恢复学习进度…"}</p> : saving ?
          <div className="grid gap-5 text-center"><h1 className="text-2xl font-bold">{busy ? "正在保存本轮结果…" : "等待保存结果"}</h1>
            <p className="text-sm leading-6 text-student-muted">已完成 {round.entries.length} 词。只有服务端确认保存成功后，才会进入结果页。</p>
            {!busy ? <button type="button" className="student-button-primary justify-self-center" onClick={() => void save()}>重试保存</button> : null}</div> : entry ? <>
            {study ? <><h1 className="text-center text-5xl font-bold leading-tight [overflow-wrap:anywhere] sm:text-6xl">{entry.word}</h1>
              <div className="mx-auto grid w-full max-w-2xl gap-8">{entry.senses.map((sense, index) => <div key={index} className="grid gap-3">
                <p className="text-xl font-semibold leading-relaxed [overflow-wrap:anywhere] sm:text-2xl"><span className="mr-3 text-lg font-medium text-student-muted sm:text-xl">{POS_LABELS[sense.pos]}</span>{sense.meaning_zh}</p>
                <p className="text-base leading-7 [overflow-wrap:anywhere] sm:text-lg sm:leading-8">{sense.example_en}</p>
              </div>)}</div></> : <>
              <div className="grid gap-4 text-center">{entry.senses.map((sense, index) => <p key={index} className="text-2xl font-semibold leading-relaxed [overflow-wrap:anywhere] sm:text-3xl">
                <span className="mr-3 text-xl font-medium text-student-muted sm:text-2xl">{POS_LABELS[sense.pos]}</span>{sense.meaning_zh}</p>)}</div>
              <div className="grid gap-3" role="group" aria-label="原形拼写"><LetterSpelling shape={vocabularySpellingShape([entry.word])}
                value={answer?.spelling ?? round.draft.spelling} onChange={value => change(value)} disabled={busy || Boolean(answer)} onConfirm={confirm}
                feedback={feedback ? feedback.baseCorrect ? "correct" : "wrong" : undefined} />
                {entry.irregular_forms.length > 0 ? <p className="text-center text-sm text-student-muted">原形</p> : null}
                {feedback && !feedback.baseCorrect ? <p className="text-center text-lg font-semibold text-student-primary">{entry.word}</p> : null}</div>
              {entry.irregular_forms.map(form => {
                const grade = feedback?.forms.find(f => f.formType === form.form_type);
                return <div key={form.form_type} className="grid gap-3" role="group" aria-label={`${FORM_LABELS[form.form_type]}拼写`}>
                  <LetterSpelling shape={vocabularySpellingShape(form.answers)} value={(answer ?? round.draft).irregularSpellings?.find(f => f.formType === form.form_type)?.spelling ?? ""}
                    onChange={value => change(value, form.form_type)} disabled={busy || Boolean(answer)} onConfirm={confirm}
                    feedback={grade ? grade.correct ? "correct" : "wrong" : undefined} />
                  <p className="text-center text-sm text-student-muted">{FORM_LABELS[form.form_type]}</p>
                  {grade && !grade.correct ? <p className="text-center text-lg font-semibold text-student-primary">{form.answers.join(" / ")}</p> : null}
                </div>;
              })}
              {feedback ? <p role="status" className="text-center text-sm text-student-muted">{feedback.correct ? "全部拼写正确" : "请查看各项拼写结果"}</p> : null}
            </>}
          </> : null}</div>
      </div>
      <div className="shrink-0 py-3"><VocabularyFailure error={error} retry={!round ? () => setRevision(v => v + 1) : saving ? () => void save() : undefined} /></div>
      {entry && !saving ? <footer className="shrink-0 pt-2"><button type="button" className="student-button-primary min-h-12 w-full" disabled={busy}
        onClick={() => { (document.activeElement as HTMLElement)?.blur(); advance(); }}>{study ? round!.index + 1 === round!.entries.length ? "开始测试" : "下一个"
          : answer ? round!.index + 1 === round!.entries.length ? "保存并查看结果" : "下一个" : "确定"}</button></footer> : null}
    </div>
    <ConfirmDialog open={skip} title="确定直接开始测试吗？" confirmText="确定" cancelText="取消" onCancel={() => setSkip(false)}
      onConfirm={() => { const latest = current.current; if (latest && update({ ...latest, phase: "test", index: 0, draft: emptyVocabularyAnswer(latest.entries[0]) })) setSkip(false); }} />
  </section>;
}
