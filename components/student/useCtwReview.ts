"use client";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useStudentDataCache } from "@/components/StudentDataCache";
import { useVocabularyRequest } from "./useCtwVocabulary";
import { CTW_PROGRESS_CHANGED } from "./useCtwVocabularyProgress";
import { useWordbookLocalReview, type LocalReviewAdapter } from "./useWordbookLocalReview";
import { applyReviewAction, localReview, saveLocalReview } from "@/lib/lexical/wordbookReviewLocal";
import type { ReviewRound } from "@/lib/lexical/wordbookReview";
import type { AttemptResult } from "@/lib/ctw-vocabulary/model";
import { CTW_REVIEW_NAMESPACE, CTW_REVIEW_ROOT, ctwCacheKey, ctwLegacyRowValues, ctwMetadata } from "@/lib/ctw-vocabulary/review";
import { readVocabularyRound, roundKey, VOCABULARY_API, VOCABULARY_ROOT } from "@/lib/ctw-vocabulary/round";

export function useCtwReview(sessionId: string) {
  const { studentId, request } = useVocabularyRequest();
  const { markStale, invalidate } = useStudentDataCache();
  const adapter = useMemo<LocalReviewAdapter>(() => ({ root: CTW_REVIEW_ROOT, namespace: CTW_REVIEW_NAMESPACE, cacheKey: ctwCacheKey,
    onSynced: (local, command) => {
      if (command.action === "answer") window.dispatchEvent(new Event(CTW_PROGRESS_CHANGED));
      if (command.action === "answer" || command.action === "advance") markStale(ctwCacheKey(CTW_REVIEW_ROOT));
      if (local.phase === "result" && command.action === "advance" && command.itemId === local.round.cards[local.round.cards.length - 1].itemId) {
        const source = ctwMetadata(local.round).source;
        invalidate(ctwCacheKey(`${CTW_REVIEW_ROOT}/${local.round.session.session_id}?round=1`));
        markStale(ctwCacheKey(`${VOCABULARY_API}/lists?edition=${source.kind === "list" ? "mixed" : "cefr"}`));
      }
    },
    restoreLegacy: async (owner, id, send) => {
      const old = readVocabularyRound(localStorage, owner, id);
      if (!old || old.phase === "saved") return null;
      if (old.source.kind !== "list" && old.source.kind !== "cefr_list") throw new Error("旧轮次来源无法自动迁移；本机记录已保留，请联系老师。");
      const round = await send<ReviewRound>(CTW_REVIEW_ROOT, { requestId: id, source: old.source });
      let local = localReview(owner, round);
      if (round.session.status === "completed") {
        const historical = await send<AttemptResult>(`${VOCABULARY_API}/attempts/${id}`);
        for (const answer of old.answers) {
          const saved = historical.answers.find(item => item.entryId === answer.entryId);
          if (!saved || saved.spelling !== answer.spelling || (answer.irregularSpellings ?? []).some(f => saved.irregularResults?.find(item => item.formType === f.formType)?.spelling !== f.spelling))
            throw new Error("服务器已有不同答案；本地旧记录已保留，请核对。");
        }
        saveLocalReview(localStorage, local, CTW_REVIEW_NAMESPACE); localStorage.removeItem(roundKey(owner, id)); return local;
      }
      const command = (action: "study_next" | "start_test" | "answer" | "advance", answer?: import("@/lib/lexical/wordbookReview").ReviewAnswer["student"], at = Date.now()) => {
        local = applyReviewAction(local, { id: crypto.randomUUID(), itemId: local.round.cards[local.position - 1].itemId, action, ...(answer ? { answer } : {}) }, at);
      };
      if (old.phase === "study") for (let i = 0; i < old.index; i++) command("study_next");
      else {
        command("start_test");
        for (let i = 0; i < old.answers.length; i++) {
          const a = old.answers[i];
          if (a.entryId !== local.round.cards[local.position - 1].itemId) throw new Error("旧轮次词序已变化；本机记录已保留，不能跳过已作答词条。");
          command("answer", { spellings: { base: a.spelling,
            ...ctwLegacyRowValues(local.round.cards[local.position - 1], old.entries[i], a.irregularSpellings) } }, Date.now() - 1000);
          if (i < old.index || old.phase === "saving") command("advance");
        }
        local.draft = { spellings: { base: old.draft.spelling,
          ...ctwLegacyRowValues(local.round.cards[local.position - 1], old.entries[old.index], old.draft.irregularSpellings) } };
      }
      saveLocalReview(localStorage, local, CTW_REVIEW_NAMESPACE);
      localStorage.removeItem(roundKey(owner, id));
      return local;
    }
  }), [markStale, invalidate]);
  return useWordbookLocalReview(studentId, sessionId, request, adapter);
}
export function useCtwRetry() {
  const router = useRouter(), { request, studentId } = useVocabularyRequest(), { markStale } = useStudentDataCache();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false), identity = useRef<{ parent: string; request: string }>();
  const retry = async (round: ReviewRound) => {
    if (!studentId || locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try {
      const parent = round.session.session_id;
      if (identity.current?.parent !== parent) identity.current = { parent, request: crypto.randomUUID() };
      const created = await request<ReviewRound>(CTW_REVIEW_ROOT, { source: ctwMetadata(round).source, requestId: identity.current.request, parent });
      saveLocalReview(localStorage, localReview(studentId, created), CTW_REVIEW_NAMESPACE);
      markStale(ctwCacheKey(CTW_REVIEW_ROOT)); router.push(`${VOCABULARY_ROOT}/session/${created.session.session_id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "重测创建失败，请重试。"); }
    finally { locked.current = false; setBusy(false); }
  };
  return { retry, busy, error };
}
