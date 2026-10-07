"use client";
import Link from "next/link";
import { useStudentCachedData } from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import { StudentNavigation, StudentLoadingState, StudentErrorState } from "@/components/student/StudentUI";
import { ReadingResultDetailCard } from "./ReadingResult";
import { categoryPracticeHref, categoryResultHref, categoryRetakeHref, categoryResultAnswers, categorySessionTitle } from "@/lib/reading/questionCategory";
import { categorySessionCacheKey, loadCategorySession } from "@/lib/reading/questionCategory.client";
import { getReadingCategoryResultNavigation, withStudentReturnTo } from "@/lib/studentNavigation";

export function QuestionCategorySessionResult({ sessionId, returnTo }: { sessionId: string; returnTo?: string | null }) {
  const state = useStudentCachedData(categorySessionCacheKey(sessionId), (auth) => loadCategorySession(sessionId, auth));
  if (state.loading) return <StudentLoadingState text="正在加载练习结果..." />;
  if (state.error || !state.data) return <StudentErrorState text={state.error || "没有找到这次练习。"} />;
  const { session, answers } = state.data;
  const navigation = getReadingCategoryResultNavigation(returnTo);
  if (session.status !== "completed") return <section className="student-card grid gap-4 p-8 text-center">
    <h1 className="text-2xl font-bold">这次练习还没有完成</h1>
    <Link className="student-button-primary" href={categoryPracticeHref(session.questionCategory, session.amount, sessionId)}>继续练习</Link>
    <Link className="student-button-secondary" href={navigation.backHref}>返回</Link>
  </section>;
  const selfBase = categoryResultHref(sessionId);
  let ordered;
  try { ordered = categoryResultAnswers(session, answers); }
  catch { return <StudentErrorState text="练习结果不完整，请稍后重试。" />; }
  return <div className="reading-theme student-result-overview-layout">
    <div className="student-result-overview-navigation"><StudentNavigation backHref={navigation.backHref} crumbs={navigation.crumbs} /></div>
    <PracticeResultSummary correctPoints={session.correctPoints} totalPoints={session.totalPoints}
      elapsedSeconds={session.elapsedSeconds} title={categorySessionTitle(session.questionCategory)} scoreComparison={null} timeComparison={null} />
    <ReadingResultDetailCard answers={ordered} questionHrefBase={selfBase}
      questionHref={(index) => withStudentReturnTo(`${selfBase}/questions/${index}`, returnTo)} submittedAt={session.completedAt!}
      actions={<Link className="student-button-primary" href={categoryRetakeHref(session)}>重新练习</Link>} />
  </div>;
}
