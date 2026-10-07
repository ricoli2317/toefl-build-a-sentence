"use client";
import Link from "next/link";
import { useStudentCachedData } from "@/components/StudentDataCache";
import { PracticeResultSummary } from "@/components/PracticeResult";
import { StudentNavigation, StudentLoadingState, StudentErrorState } from "@/components/student/StudentUI";
import { ReadingResultDetailCard } from "./ReadingResult";
import { CATEGORY_ROUTE, categoryPracticeHref, categoryResultHref, categoryRetakeHref, categoryResultAnswers, categorySessionTitle } from "@/lib/reading/questionCategory";
import { categorySessionCacheKey, loadCategorySession } from "@/lib/reading/questionCategory.client";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";

export function QuestionCategorySessionResult({ sessionId }: { sessionId: string }) {
  const state = useStudentCachedData(categorySessionCacheKey(sessionId), (auth) => loadCategorySession(sessionId, auth));
  if (state.loading) return <StudentLoadingState text="正在加载练习结果..." />;
  if (state.error || !state.data) return <StudentErrorState text={state.error || "没有找到这次练习。"} />;
  const { session, answers } = state.data;
  if (session.status !== "completed") return <section className="student-card grid gap-4 p-8 text-center">
    <h1 className="text-2xl font-bold">这次练习还没有完成</h1>
    <Link className="student-button-primary" href={categoryPracticeHref(session.questionCategory, session.amount, sessionId)}>继续练习</Link>
    <Link className="student-button-secondary" href={CATEGORY_ROUTE}>返回按题型分类练习</Link>
  </section>;
  const selfBase = categoryResultHref(sessionId);
  let ordered;
  try { ordered = categoryResultAnswers(session, answers); }
  catch { return <StudentErrorState text="练习结果不完整，请稍后重试。" />; }
  return <div className="reading-theme student-result-overview-layout">
    <div className="student-result-overview-navigation"><StudentNavigation backHref={CATEGORY_ROUTE} crumbs={[
      { label: STUDENT_UI_TEXT.studentHome, href: STUDENT_ROUTES.home },
      { label: STUDENT_UI_TEXT.questionCategoryPractice, href: CATEGORY_ROUTE }, { label: STUDENT_UI_TEXT.result }
    ]} /></div>
    <PracticeResultSummary correctPoints={session.correctPoints} totalPoints={session.totalPoints}
      elapsedSeconds={session.elapsedSeconds} title={categorySessionTitle(session.questionCategory)} scoreComparison={null} timeComparison={null} />
    <ReadingResultDetailCard answers={ordered} questionHrefBase={selfBase}
      questionHref={(index) => `${selfBase}/questions/${index}`} submittedAt={session.completedAt!}
      actions={<Link className="student-button-primary" href={categoryRetakeHref(session)}>重新练习</Link>} />
  </div>;
}
