"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  CircleX,
  Clock3,
  FileText,
  GraduationCap,
  Search,
  Target,
  TrendingUp,
  UserRound,
  Users,
  type LucideIcon
} from "lucide-react";
import {
  buildSentenceDisplay,
  isBlankToken,
  splitSentenceTemplate,
  splitTextItems
} from "@/lib/questionText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  compareStudentSearchGroups,
  compareStudentSearchMetadata,
  createStudentSearchMetadata,
  studentSearchRank
} from "@/lib/studentSearch";
import {
  TEACHER_STATS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import { AttemptHistoryList } from "@/components/AttemptHistoryList";
import { PracticeResultView, type ResultPayload } from "@/components/PracticeResult";
import { PracticeHistoryCompactList } from "@/components/shared/PracticeHistoryCards";
import { QuestionDisplay } from "@/components/shared/QuestionDisplay";
import { TeacherBreadcrumbs } from "@/components/teacher/TeacherAppShell";
import {
  TeacherAccuracyBar,
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherIconTile,
  TeacherLoadingRegion,
  TeacherMetricCard,
  TeacherSectionTitle,
  TeacherSkeleton,
  TeacherTextLink
} from "@/components/teacher/TeacherUI";

type TeacherStatsPayload = {
  overview: {
    studentCount: number;
    totalAttemptCount: number;
    answeredQuestionCount: number;
    averageAccuracy: number;
  };
  missingAnswerAttemptIds: string[];
  students: StudentSummary[];
  sets: SetSummary[];
  attempts: AttemptSummary[];
  answers: AnswerSummary[];
  questions: QuestionSummary[];
};

type StudentSummary = {
  studentId: string;
  studentEmail: string;
  studentName: string;
  studentDisplayName: string;
  completedSetCount: number;
  totalAttemptCount: number;
  answeredQuestionCount: number;
  correctCount: number;
  averageAccuracy: number;
};

type SetSummary = {
  setId: string;
  setTitle: string;
  questionCount: number;
  totalAttemptCount: number;
  completedStudentCount: number;
  averageAccuracy: number;
};

type PracticeType = "official" | "wrongbook-today" | "wrongbook-history";

type AttemptSummary = {
  attemptId: string;
  studentId: string;
  setId: string;
  setTitle: string;
  practiceType: PracticeType;
  correctCount: number;
  totalQuestions: number;
  accuracy: number;
  timeSpentSeconds: number;
  submittedAt: string | null;
};

type AnswerSummary = {
  attemptAnswerId: string;
  attemptId: string;
  studentId: string;
  setId: string;
  setTitle: string;
  practiceType: PracticeType | "unknown";
  questionId: string;
  questionOrder: number;
  prompt: string;
  sentenceTemplate: string;
  optionsText: string;
  finalSentence: string;
  submittedOrderText: string;
  displaySubmittedOrderText: string;
  correctOrderText: string;
  isCorrect: boolean;
  questionTimeSeconds: number | null;
};

type QuestionSummary = {
  questionId: string;
  setId: string;
  setTitle: string;
  questionOrder: number;
  prompt: string;
  sentenceTemplate: string;
  correctOrderText: string;
  finalSentence: string;
  answerCount: number;
  correctCount: number;
  accuracy: number;
};

type StudentSearchEntry = {
  compactPinyin: string;
  directText: string;
  fullPinyin: string;
  group: string;
  initials: string;
  student: StudentSummary;
  surnamePinyin: string;
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const LOW_ACCURACY_THRESHOLD = 0.5;

export function TeacherDashboard() {
  const { error, loading, stats } = useTeacherStats();
  const todayAttempts = stats?.attempts.filter((attempt) => isToday(attempt.submittedAt)) ?? [];
  const recentAttempts = [...(stats?.attempts ?? [])]
    .filter((attempt) => attempt.submittedAt)
    .sort((left, right) => compareDatesDesc(left.submittedAt, right.submittedAt))
    .slice(0, 4);

  return (
    <div className="grid gap-8">
      {loading ? <TeacherLoadingRegion label="正在加载教师首页数据" /> : null}
      <section>
        <TeacherSectionTitle>管理入口</TeacherSectionTitle>
        <div className="mt-4 grid gap-5 md:grid-cols-3">
          <TeacherFeatureCard
            description="管理学生账号与学习情况"
            href="/teacher/students"
            icon={Users}
            metric={loading ? <TeacherSkeleton className="h-4 w-14" /> : error ? "—" : `${stats?.students.length ?? 0} 名学生`}
            title="学生"
          />
          <TeacherFeatureCard
            description="查看学生表现与套题分析"
            href="/teacher/sets"
            icon={BarChart3}
            metric={loading ? <TeacherSkeleton className="h-4 w-10" /> : error ? "—" : `${stats?.sets.length ?? 0} 套`}
            title="套题统计"
          />
          <TeacherFeatureCard
            description="浏览与管理所有题库内容"
            href="/teacher/question-bank"
            icon={FileText}
            metric={loading ? <TeacherSkeleton className="h-4 w-10" /> : error ? "—" : `${stats?.questions.length ?? 0} 题`}
            title="查看所有套题"
          />
        </div>
      </section>

      <section>
        <TeacherSectionTitle>数据概览</TeacherSectionTitle>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <TeacherMetricCard icon={Users} label="总学生数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(stats?.students.length ?? 0)} />
          <TeacherMetricCard icon={BookOpenCheck} label="总套题数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(stats?.sets.length ?? 0)} />
          <TeacherMetricCard icon={FileText} label="总题目数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(stats?.questions.length ?? 0)} />
          <TeacherMetricCard icon={TrendingUp} label="今日新增练习" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(todayAttempts.length)} />
        </div>
        {error ? <div className="mt-4"><TeacherDataError text={toTeacherErrorMessage(error)} /></div> : null}
      </section>

      <TeacherCard className="p-5 sm:p-6">
        <TeacherSectionTitle>近期动态</TeacherSectionTitle>
        {loading ? (
          <div className="mt-4 grid gap-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div className="flex items-center gap-3 py-1" key={index}>
                <TeacherSkeleton className="h-9 w-9 shrink-0 rounded-full" />
                <TeacherSkeleton className="h-4 flex-1" />
                <TeacherSkeleton className="h-4 w-20 shrink-0" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="mt-4"><TeacherDataError text={toTeacherErrorMessage(error)} /></div>
        ) : recentAttempts.length > 0 ? (
          <div className="mt-4 divide-y divide-student-border">
            {recentAttempts.map((attempt) => {
              const student = stats?.students.find((item) => item.studentId === attempt.studentId);
              return (
                <div className="flex items-center justify-between gap-4 py-3 first:pt-1 last:pb-0" key={attempt.attemptId}>
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                      <GraduationCap aria-hidden="true" size={19} strokeWidth={1.9} />
                    </span>
                    <p className="truncate text-sm text-student-text">
                      <span className="font-semibold">{student?.studentDisplayName ?? "学生"}</span>
                      {" 完成了 "}
                      <span className="font-medium">{attempt.setTitle}</span>
                    </p>
                  </div>
                  <time className="shrink-0 text-xs text-student-muted">{formatActivityTime(attempt.submittedAt)}</time>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="mt-4"><TeacherEmptyState text="暂无近期动态。" /></div>
        )}
      </TeacherCard>
    </div>
  );
}

export function TeacherStudentsList() {
  const [query, setQuery] = useState("");
  const sectionRefs = useRef(new Map<string, HTMLTableRowElement>());
  const { error, loading, stats } = useTeacherStats();
  const entries = (stats?.students ?? []).map(createStudentSearchEntry);
  const filtered = filterStudentEntries(entries, query);
  const sections = groupStudentEntries(filtered);
  const availableLetters = new Set(sections.map(([letter]) => letter));

  return (
    <div className="grid gap-6">
      {loading ? <TeacherLoadingRegion label="正在加载学生列表" /> : null}
            <TeacherCard className="p-5 sm:p-6">
              <div className="flex flex-wrap items-end justify-between gap-5">
                <div className="w-full max-w-[560px]">
                  <label className="relative block">
                    <Search
                      aria-hidden="true"
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-student-muted"
                      size={20}
                      strokeWidth={1.9}
                    />
                    <input
                      className="h-12 w-full rounded-xl border border-student-border bg-white pl-12 pr-4 text-sm text-student-text placeholder:text-student-muted focus:border-student-primary"
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索学生姓名 / 拼音"
                      type="search"
                      value={query}
                    />
                  </label>
                  <p className="mt-3 text-sm text-student-muted">
                    支持中文精确搜索，例如：丁煊航；支持拼音模糊搜索，例如：ding / zhang
                  </p>
                </div>
                <p className="text-sm font-medium text-student-text">按姓氏首字母排序</p>
              </div>
            </TeacherCard>

            <div className="flex items-start gap-3">
              <TeacherCard className="min-w-0 flex-1 overflow-hidden p-0">
                <div className="px-6 pt-6">
                  <TeacherSectionTitle>学生列表</TeacherSectionTitle>
                </div>
                {loading ? (
                  <StudentTableSkeleton />
                ) : error ? (
                  <StudentTableError text={toTeacherErrorMessage(error)} />
                ) : filtered.length === 0 ? (
                  <div className="p-6">
                    <TeacherEmptyState text={query.trim() ? "没有找到匹配的学生。" : "暂无学生。"} />
                  </div>
                ) : (
                  <div className="overflow-x-auto px-6 pb-6 pt-4">
                    <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                      <thead>
                        <tr className="border-b border-student-border text-student-muted">
                          <th className="px-3 py-3 font-medium">学生</th>
                          <th className="px-3 py-3 font-medium">完成套题数</th>
                          <th className="px-3 py-3 font-medium">总练习次数</th>
                          <th className="px-3 py-3 font-medium">平均正确率</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sections.flatMap(([letter, students]) => [
                          <tr
                            className="scroll-mt-28"
                            id={`student-letter-${letter}`}
                            key={`group-${letter}`}
                            ref={(node) => {
                              if (node) sectionRefs.current.set(letter, node);
                              else sectionRefs.current.delete(letter);
                            }}
                          >
                            <td className="bg-student-primary-soft px-3 py-2 font-bold text-student-primary" colSpan={4}>
                              {letter}
                            </td>
                          </tr>,
                          ...students.map((entry) => (
                            <tr
                              className="border-b border-student-border transition last:border-b-0 hover:bg-student-primary-soft/45"
                              key={entry.student.studentId}
                            >
                              <td className="px-3 py-3">
                                <div className="flex items-center gap-3">
                                  <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                                    <UserRound aria-hidden="true" size={20} strokeWidth={1.9} />
                                  </span>
                                  <TeacherTextLink href={`/teacher/students/${entry.student.studentId}`}>
                                    {entry.student.studentDisplayName}
                                  </TeacherTextLink>
                                </div>
                              </td>
                              <td className="px-3 py-3 tabular-nums">{entry.student.completedSetCount}</td>
                              <td className="px-3 py-3 tabular-nums">{entry.student.totalAttemptCount}</td>
                              <td className="px-3 py-3">
                                <TeacherAccuracyBar value={entry.student.averageAccuracy} />
                              </td>
                            </tr>
                          ))
                        ])}
                      </tbody>
                    </table>
                  </div>
                )}
              </TeacherCard>

              <nav aria-label="学生姓氏首字母索引" className="sticky top-[96px] hidden w-7 shrink-0 flex-col items-center gap-0.5 py-1 xl:flex">
                {ALPHABET.map((letter) => {
                  const available = availableLetters.has(letter);
                  return (
                    <button
                      aria-label={`跳转到 ${letter} 组`}
                      className={`h-[22px] w-7 rounded-md text-[11px] font-semibold transition ${
                        available
                          ? "text-student-primary hover:bg-student-primary hover:text-white"
                          : "cursor-default text-student-muted/35"
                      }`}
                      disabled={!available}
                      key={letter}
                      onClick={() => sectionRefs.current.get(letter)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      type="button"
                    >
                      {letter}
                    </button>
                  );
                })}
              </nav>
            </div>
    </div>
  );
}

export function TeacherStudentSummary({ studentId }: { studentId: string }) {
  const { error, loading, stats } = useTeacherStats();
  const student = stats?.students.find((item) => item.studentId === studentId);
  const attempts = stats?.attempts.filter((attempt) => attempt.studentId === studentId) ?? [];
  const attemptsBySet = groupBy(attempts, getAttemptGroupId);
  const setGroups = Array.from(attemptsBySet.entries())
    .map(([groupId, setAttempts], stableIndex) => {
      const latestAttempt = setAttempts
        .map((attempt, index) => ({
          attempt,
          index,
          timestamp: completedAttemptTimestamp(attempt.submittedAt)
        }))
        .sort((left, right) => {
          if (left.timestamp === null && right.timestamp === null) return left.index - right.index;
          if (left.timestamp === null) return 1;
          if (right.timestamp === null) return -1;
          return right.timestamp - left.timestamp || left.index - right.index;
        })[0]?.attempt;

      return {
        bestAccuracy: Math.max(...setAttempts.map((attempt) => attempt.accuracy)),
        groupId,
        latestAttempt,
        latestTimestamp: completedAttemptTimestamp(latestAttempt?.submittedAt ?? null),
        setAttempts,
        stableIndex
      };
    })
    .sort((left, right) => {
      if (left.latestTimestamp === null && right.latestTimestamp === null) {
        return left.stableIndex - right.stableIndex;
      }
      if (left.latestTimestamp === null) return 1;
      if (right.latestTimestamp === null) return -1;
      return right.latestTimestamp - left.latestTimestamp || left.stableIndex - right.stableIndex;
    });

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载学生概览" /> : null}
      <TeacherBreadcrumbs crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "学生", href: "/teacher/students" },
        { label: student?.studentDisplayName ?? "学生详情" }
      ]} />
      {error ? <TeacherDataError text={toTeacherErrorMessage(error)} /> : null}
      {!loading && !error && !student ? <EmptyState text="未找到学生。" /> : (
        <>
          <TeacherCard className="flex min-h-[96px] items-center p-5">
            <div className="flex min-w-0 items-center gap-4">
              <TeacherIconTile icon={UserRound} />
              <div className="min-w-0">
                {loading ? <TeacherSkeleton className="h-7 w-36" /> : <h2 className="truncate text-2xl font-bold text-student-text">{student?.studentDisplayName ?? "学生详情"}</h2>}
                {loading ? <TeacherSkeleton className="mt-2 h-4 w-52" /> : <p className="mt-1 truncate text-sm text-student-muted">{student?.studentEmail ?? "学生数据暂时无法显示"}</p>}
              </div>
            </div>
          </TeacherCard>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StudentOverviewMetricCard icon={BookOpenCheck} label="完成套题数" value={loading ? <TeacherSkeleton className="h-8 w-12" /> : error ? "—" : String(student?.completedSetCount ?? 0)} />
            <StudentOverviewMetricCard icon={Clock3} label="总练习次数" value={loading ? <TeacherSkeleton className="h-8 w-12" /> : error ? "—" : String(student?.totalAttemptCount ?? 0)} />
            <StudentOverviewMetricCard icon={Target} label="平均正确率" value={loading ? <TeacherSkeleton className="h-8 w-16" /> : error ? "—" : formatPercent(student?.averageAccuracy ?? 0)} />
            <StudentOverviewMetricCard icon={FileText} label="答题数" value={loading ? <TeacherSkeleton className="h-8 w-12" /> : error ? "—" : String(student?.answeredQuestionCount ?? 0)} />
          </div>
          {loading ? <PracticeHistorySkeleton /> : error ? <PracticeHistoryError /> : (
            <PracticeHistoryCompactList
              emptyState={<TeacherEmptyState text="该学生还没有完成练习。" />}
              items={setGroups.map(({ bestAccuracy, groupId, latestAttempt, setAttempts }) => ({
                attemptCount: setAttempts.length,
                bestAccuracy: formatPercent(bestAccuracy),
                href: `/teacher/students/${studentId}/details/${encodeURIComponent(groupId)}`,
                latestAccuracy: formatPercent(latestAttempt?.accuracy ?? 0),
                latestCompleted: formatCompactDateTime(latestAttempt?.submittedAt ?? null),
                setId: groupId,
                setTitle: getAttemptGroupTitle(groupId, latestAttempt?.setTitle ?? groupId)
              }))}
            />
          )}
        </>
      )}
    </div>
  );
}

function StudentOverviewMetricCard({
  icon: Icon,
  label,
  value
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="teacher-card flex min-h-[94px] items-center gap-4 p-5">
      <span className="inline-flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[14px] bg-student-primary-soft text-student-primary">
        <Icon aria-hidden="true" size={28} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <p className="text-[2rem] font-bold leading-none tracking-tight tabular-nums text-student-primary">{value}</p>
        <p className="mt-2 truncate text-sm font-medium text-student-muted">{label}</p>
      </div>
    </div>
  );
}

export function TeacherStudentSetDetails({
  setId,
  studentId
}: {
  setId: string;
  studentId: string;
}) {
  const { error, loading, stats } = useTeacherStats();
  const student = stats?.students.find((item) => item.studentId === studentId);
  const groupId = normalizeAttemptGroupId(setId);
  const attempts = (stats?.attempts ?? [])
    .filter(
      (attempt) =>
        attempt.studentId === studentId && getAttemptGroupId(attempt) === groupId
    )
    .sort((a, b) => compareDatesDesc(a.submittedAt, b.submittedAt));
  const setTitle = getAttemptGroupTitle(
    groupId,
    attempts[0]?.setTitle ??
      stats?.sets.find((set) => set.setId === groupId)?.setTitle ??
      groupId
  );
  const attemptIds = new Set(attempts.map((attempt) => attempt.attemptId));

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载套题练习记录" /> : null}
      <TeacherBreadcrumbs crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "学生", href: "/teacher/students" },
        { label: student?.studentDisplayName ?? "学生详情", href: `/teacher/students/${studentId}` },
        { label: "练习记录", href: `/teacher/students/${studentId}` },
        { label: loading ? "套题练习记录" : setTitle }
      ]} />
      {error ? <TeacherDataError text={toTeacherErrorMessage(error)} /> : null}
      {!loading && !error && !student ? <EmptyState text="未找到学生。" /> : (
        <>
          <TeacherCard className="p-5">
            {loading ? <TeacherSkeleton className="h-6 w-40" /> : <h2 className="text-xl font-bold text-student-text">{setTitle}</h2>}
            <p className="mt-1 text-sm text-student-muted">{groupId}</p>
          </TeacherCard>
          {loading ? <AttemptHistorySkeleton /> : (
            <AttemptHistoryList
              answers={(stats?.answers ?? []).filter((answer) => attemptIds.has(answer.attemptId))}
              attempts={attempts}
              getAnswerHref={(answer) => `/teacher/students/${studentId}/answers/${answer.attemptAnswerId}`}
              locale="zh-CN"
              missingAnswerAttemptIds={stats?.missingAnswerAttemptIds ?? []}
              variant="student"
            />
          )}
        </>
      )}
    </div>
  );
}

export function TeacherStudentQuestionDetail({ attemptAnswerId }: { attemptAnswerId: string }) {
  const { error, loading, stats } = useTeacherStats();

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载答题详情" /> : null}
      {loading ? <QuestionDetailSkeleton /> : error ? (
        <QuestionDetailError text={toTeacherErrorMessage(error)} />
      ) : stats ? (
        <TeacherStudentQuestionDetailContent
          initialAttemptAnswerId={attemptAnswerId}
          stats={stats}
        />
      ) : <TeacherEmptyState text="暂无答题数据。" />}
    </div>
  );
}

function TeacherStudentQuestionDetailContent({
  initialAttemptAnswerId,
  stats
}: {
  initialAttemptAnswerId: string;
  stats: TeacherStatsPayload;
}) {
  const initialAnswer = stats.answers.find(
    (item) => item.attemptAnswerId === initialAttemptAnswerId
  );
  if (!initialAnswer) return <TeacherEmptyState text="未找到答题记录。" />;
  const attempt = stats.attempts.find((item) => item.attemptId === initialAnswer.attemptId);
  if (!attempt) return <TeacherEmptyState text="未找到对应的练习结果。" />;
  const attemptAnswers = stats.answers
    .filter((item) => item.studentId === initialAnswer.studentId && item.attemptId === initialAnswer.attemptId)
    .sort((a, b) => a.questionOrder - b.questionOrder);
  const groupId = getAttemptGroupId(attempt);
  const groupTitle = getAttemptGroupTitle(
    groupId,
    attempt.setTitle || initialAnswer.setTitle
  );
  const student = stats.students.find((item) => item.studentId === initialAnswer.studentId);
  const studentLabel = student?.studentDisplayName ?? "学生";
  const payload: ResultPayload = {
    attempt: {
      attempt_id: attempt.attemptId,
      set_id: attempt.setId,
      set_title: groupTitle,
      correct_count: attempt.correctCount,
      total_questions: attempt.totalQuestions,
      accuracy: attempt.accuracy,
      time_spent_seconds: attempt.timeSpentSeconds,
      submitted_at: attempt.submittedAt ?? ""
    },
    total_count: attempt.totalQuestions,
    correct_count: attempt.correctCount,
    accuracy: attempt.accuracy,
    answers: attemptAnswers.map((answer) => ({
      attempt_answer_id: answer.attemptAnswerId,
      question_id: answer.questionId,
      question_order: answer.questionOrder,
      prompt: answer.prompt,
      submitted_order_text: answer.displaySubmittedOrderText || answer.submittedOrderText,
      correct_order_text: answer.correctOrderText,
      sentence_template: answer.sentenceTemplate,
      options_text: answer.optionsText,
      final_sentence: answer.finalSentence,
      is_correct: answer.isCorrect,
      grammar_tags_text: null,
      question_time_seconds: answer.questionTimeSeconds
    }))
  };

  return (
    <PracticeResultView
      answerLabel="学生答案"
      correctAnswerVisibility="always"
      initialQuestionId={initialAnswer.questionId}
      navigation={<TeacherBreadcrumbs crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "学生", href: "/teacher/students" },
        { label: studentLabel, href: `/teacher/students/${initialAnswer.studentId}` },
        { label: "练习记录", href: `/teacher/students/${initialAnswer.studentId}` },
        { label: groupTitle, href: `/teacher/students/${initialAnswer.studentId}/details/${encodeURIComponent(groupId)}` },
        { label: `第 ${initialAnswer.questionOrder} 题` }
      ]} />}
      payload={payload}
      showQuestionTime
    />
  );
}

export function TeacherSetsList() {
  const { error, loading, stats } = useTeacherStats();

  return (
    <TeacherCard className="overflow-hidden p-0">
      {loading ? <TeacherLoadingRegion label="正在加载套题统计" /> : null}
      <div className="px-6 pt-6">
        <TeacherSectionTitle>套题列表</TeacherSectionTitle>
      </div>
      <div className="overflow-x-auto px-6 pb-6 pt-4">
        <table className="w-full min-w-[880px] border-separate border-spacing-0 overflow-hidden rounded-xl border border-student-border text-left text-sm">
          <thead className="bg-student-primary-soft/55">
            <tr className="text-student-text">
              <th className="px-4 py-4 font-semibold">套题</th>
              <th className="px-4 py-4 font-semibold">套题 ID</th>
              <th className="px-4 py-4 font-semibold">题目数</th>
              <th className="px-4 py-4 font-semibold">总练习次数</th>
              <th className="px-4 py-4 font-semibold">平均正确率</th>
            </tr>
          </thead>
          {loading ? <SetTableSkeleton /> : stats && stats.sets.length > 0 ? (
            <tbody>
              {stats.sets.map((set) => (
                <tr className="border-t border-student-border transition hover:bg-student-primary-soft/45" key={set.setId}>
                  <td className="border-t border-student-border px-4 py-4"><TeacherTextLink href={`/teacher/sets/${encodeURIComponent(set.setId)}`}>{set.setTitle}</TeacherTextLink></td>
                  <td className="border-t border-student-border px-4 py-4 font-mono text-xs text-student-muted">{set.setId}</td>
                  <td className="border-t border-student-border px-4 py-4 tabular-nums">{set.questionCount}</td>
                  <td className="border-t border-student-border px-4 py-4 tabular-nums">{set.totalAttemptCount}</td>
                  <td className="border-t border-student-border px-4 py-4"><TeacherAccuracyBar value={set.averageAccuracy} /></td>
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
        {error ? <div className="mt-4"><TeacherDataError text={toTeacherErrorMessage(error)} /></div> : null}
        {!loading && !error && (!stats || stats.sets.length === 0) ? <div className="mt-4"><TeacherEmptyState text="暂无套题。" /></div> : null}
      </div>
    </TeacherCard>
  );
}

export function TeacherSetSummary({ setId }: { setId: string }) {
  const { error, loading, stats } = useTeacherStats();
  const set = stats?.sets.find((item) => item.setId === setId);
  const questions = (stats?.questions ?? [])
    .filter((question) => question.setId === setId)
    .sort((a, b) => a.questionOrder - b.questionOrder);

  return (
    <div className="grid gap-8">
      {loading ? <TeacherLoadingRegion label="正在加载套题详情" /> : null}
      {error ? <TeacherDataError text={toTeacherErrorMessage(error)} /> : null}
      {!loading && !error && !set ? <EmptyState text="未找到套题。" /> : (
        <>
          {loading ? <TeacherSkeleton className="h-5 w-56" /> : <p className="-mt-3 text-base font-medium text-student-muted">{set?.setTitle} · {set?.setId}</p>}
          <div className="grid gap-5 md:grid-cols-3">
            <TeacherMetricCard icon={BookOpenCheck} label="总练习次数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(set?.totalAttemptCount ?? 0)} />
            <TeacherMetricCard icon={Users} label="完成学生数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(set?.completedStudentCount ?? 0)} />
            <TeacherMetricCard icon={TrendingUp} label="平均正确率" value={loading ? <TeacherSkeleton className="h-8 w-16" /> : error ? "—" : formatPercent(set?.averageAccuracy ?? 0)} />
          </div>
          <TeacherCard className="p-5 sm:p-7">
            <TeacherSectionTitle>单题正确率</TeacherSectionTitle>
            {loading ? <QuestionAccuracySkeleton /> : error ? <div className="mt-5"><TeacherDataError text={toTeacherErrorMessage(error)} /></div> : questions.length === 0 ? (
              <div className="mt-5"><TeacherEmptyState text="该套题暂无题目。" /></div>
            ) : (
              <div className="mt-6 grid gap-5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
                {questions.map((question) => (
                    <Link
                      className={`flex min-h-[140px] flex-col items-center justify-center rounded-2xl border p-5 text-center transition hover:-translate-y-px hover:shadow-md ${
                        question.accuracy < LOW_ACCURACY_THRESHOLD
                          ? "border-student-error-border bg-student-error-soft"
                          : "border-student-primary-border bg-student-primary-soft/65"
                      }`}
                      href={`/teacher/sets/${encodeURIComponent(setId)}/questions/${encodeURIComponent(question.questionId)}`}
                      key={question.questionId}
                    >
                      <p className={question.accuracy < LOW_ACCURACY_THRESHOLD ? "text-base font-semibold text-student-error" : "text-base font-semibold text-student-primary"}>第 {question.questionOrder} 题</p>
                      <p className={question.accuracy < LOW_ACCURACY_THRESHOLD ? "mt-3 text-[2.35rem] font-bold leading-none text-student-error" : "mt-3 text-[2.35rem] font-bold leading-none text-student-text"}>
                        {formatPercent(question.accuracy)}
                      </p>
                    </Link>
                ))}
              </div>
            )}
          </TeacherCard>
        </>
      )}
    </div>
  );
}

export function TeacherSetQuestionDetail({
  questionId,
  setId
}: {
  questionId: string;
  setId: string;
}) {
  const { error, loading, stats } = useTeacherStats();
  const question = stats?.questions.find(
    (item) => item.setId === setId && item.questionId === questionId
  );
  const answers = (stats?.answers ?? []).filter(
    (answer) => answer.practiceType === "official" && answer.questionId === questionId
  );
  const wrongAnswers = answers.filter((answer) => !answer.isCorrect);
  const frequentWrong = Array.from(
    groupBy(
      wrongAnswers,
      (answer) => answer.displaySubmittedOrderText || answer.submittedOrderText || "__empty__"
    ).entries()
  )
    .map(([submittedOrderText, grouped]) => ({
      submittedOrderText: submittedOrderText === "__empty__" ? "" : submittedOrderText,
      count: grouped.length
    }))
    .sort((a, b) => b.count - a.count);
  const optionChunks = splitTextItems(answers[0]?.optionsText ?? "").map((text, index) => ({
    id: `${questionId}-${index}`,
    text
  }));
  const blankCount = question
    ? splitSentenceTemplate(question.sentenceTemplate).filter(isBlankToken).length
    : 0;

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载单题统计" /> : null}
      <TeacherBreadcrumbs crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "套题统计", href: "/teacher/sets" },
        { label: question?.setTitle ?? setId, href: `/teacher/sets/${encodeURIComponent(setId)}` },
        { label: question ? `第 ${question.questionOrder} 题` : "单题详情" }
      ]} />
      {loading ? (
        <QuestionStatisticsSkeleton />
      ) : error ? (
        <QuestionStatisticsError text={toTeacherErrorMessage(error)} />
      ) : !question ? (
        <EmptyState text="未找到题目。" />
      ) : (
        <>
            <QuestionDisplay
              answers={Array.from({ length: blankCount }, () => null)}
              locale="zh-CN"
              options={optionChunks}
              prompt={question.prompt}
              questionNumber={question.questionOrder}
              readOnly
              template={question.sentenceTemplate}
            />
          <TeacherCard className="border-student-primary-border bg-student-primary-soft/55 p-5">
              <p className="text-sm font-semibold text-student-primary">正确答案</p>
              <p className="mt-2 text-lg font-semibold leading-7 text-student-text">
                {buildSentenceDisplay(
                question.sentenceTemplate,
                question.correctOrderText || answers[0]?.correctOrderText || "",
                question.finalSentence
                )}
              </p>
          </TeacherCard>
          <div className="grid gap-5 sm:grid-cols-3">
            <TeacherMetricCard icon={Target} label="平均正确率" value={formatPercent(question.accuracy)} />
            <TeacherMetricCard icon={FileText} label="总作答次数" value={String(question.answerCount)} />
            <TeacherMetricCard icon={CircleX} label="错误次数" tone="warning" value={String(wrongAnswers.length)} />
          </div>
          <TeacherCard className="overflow-hidden p-0">
              <div className="px-6 pt-6"><TeacherSectionTitle>常见错误答案</TeacherSectionTitle></div>
              {frequentWrong.length === 0 ? (
                <div className="p-6"><TeacherEmptyState text="暂时没有错误答案。" /></div>
              ) : (
                <div className="overflow-x-auto px-6 pb-6 pt-4">
                  <table className="w-full min-w-[560px] overflow-hidden rounded-xl border border-student-border text-left text-sm">
                    <thead className="bg-student-primary-soft/55"><tr><th className="px-4 py-3 font-semibold">学生答案</th><th className="w-28 px-4 py-3 text-right font-semibold">次数</th></tr></thead>
                    <tbody>
                      {frequentWrong.map((item) => (
                        <tr className="border-t border-student-error-border bg-student-error-soft/45" key={item.submittedOrderText || "empty"}>
                          <td className="px-4 py-3 leading-6 text-student-text">{item.submittedOrderText ? buildSentenceDisplay(question.sentenceTemplate, item.submittedOrderText) : "未作答"}</td>
                          <td className="px-4 py-3 text-right font-semibold tabular-nums text-student-error">{item.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </TeacherCard>
        </>
      )}
    </div>
  );
}

function useTeacherStats() {
  const { data: stats, error, loading } = useTeacherCachedData<TeacherStatsPayload>(
    TEACHER_STATS_CACHE_KEY,
    loadTeacherStats
  );

  return { error, loading, stats };
}

async function loadTeacherStats(): Promise<TeacherStatsPayload> {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();

  const response = await fetch("/api/teacher/stats", {
    headers: {
      Authorization: `Bearer ${session?.access_token ?? ""}`
    }
  });
  const responseText = await response.text();
  let payload: TeacherStatsPayload | { error?: string };

  try {
    payload = responseText
      ? JSON.parse(responseText)
      : { error: "统计数据服务返回了空响应。" };
  } catch {
    payload = { error: "统计数据服务返回的数据格式无效。" };
  }

  if (!response.ok || "error" in payload) {
    throw new Error(getErrorMessage(payload, "无法加载统计数据。"));
  }

  return payload as TeacherStatsPayload;
}

function TeacherFeatureCard({
  description,
  href,
  icon,
  metric,
  title
}: {
  description: string;
  href: string;
  icon: typeof Users;
  metric: React.ReactNode;
  title: string;
}) {
  return (
    <Link
      className="group flex min-h-[142px] items-center gap-5 rounded-2xl border border-student-primary-border bg-gradient-to-br from-white to-student-primary-soft/65 p-5 shadow-[0_2px_10px_rgba(88,65,170,0.05)] transition hover:-translate-y-px hover:shadow-[0_10px_28px_rgba(88,65,170,0.09)]"
      href={href}
    >
      <TeacherIconTile icon={icon} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-xl font-bold text-student-text">{title}</h3>
          <span className="rounded-full border border-student-primary-border bg-white/70 px-3 py-1 text-xs font-semibold text-student-primary">
            {metric}
          </span>
        </div>
        <p className="mt-2 text-sm leading-6 text-student-muted">{description}</p>
      </div>
      <ArrowRight
        aria-hidden="true"
        className="shrink-0 text-student-primary transition group-hover:translate-x-1"
        size={21}
        strokeWidth={2}
      />
    </Link>
  );
}

function createStudentSearchEntry(student: StudentSummary): StudentSearchEntry {
  const displayName = student.studentDisplayName.trim();
  return {
    ...createStudentSearchMetadata(displayName),
    student,
  };
}

function filterStudentEntries(entries: StudentSearchEntry[], query: string) {
  const sorted = [...entries].sort(compareStudentEntries);
  if (!query.trim()) return sorted;

  return sorted
    .map((entry) => ({
      entry,
      rank: studentSearchRank(entry, entry.student.studentDisplayName, query)
    }))
    .filter((item) => Number.isFinite(item.rank))
    .sort((left, right) => left.rank - right.rank || compareStudentEntries(left.entry, right.entry))
    .map((item) => item.entry);
}

function groupStudentEntries(entries: StudentSearchEntry[]) {
  const groups = new Map<string, StudentSearchEntry[]>();
  for (const entry of entries) {
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  }
  return Array.from(groups.entries()).sort(([left], [right]) => compareStudentGroups(left, right));
}

function compareStudentEntries(left: StudentSearchEntry, right: StudentSearchEntry) {
  return compareStudentSearchMetadata(
    { ...left, displayName: left.student.studentDisplayName, id: left.student.studentId },
    { ...right, displayName: right.student.studentDisplayName, id: right.student.studentId }
  );
}

function compareStudentGroups(left: string, right: string) {
  return compareStudentSearchGroups(left, right);
}

function isToday(value: string | null) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

function formatActivityTime(value: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  if (isToday(value)) return `今天 ${time}`;
  if (
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()
  ) {
    return `昨天 ${time}`;
  }
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function EmptyState({ text }: { text: string }) {
  return <TeacherEmptyState text={text} />;
}

function getErrorMessage(value: TeacherStatsPayload | { error?: string }, fallback: string) {
  return "error" in value && value.error ? value.error : fallback;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function completedAttemptTimestamp(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  const timestamp = date.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatCompactDateTime(value: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";

  const now = new Date();
  const dateLabel = date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const timeLabel = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit"
  });

  return `${dateLabel} ${timeLabel}`;
}

function compareDatesDesc(a: string | null, b: string | null) {
  return new Date(b ?? 0).getTime() - new Date(a ?? 0).getTime();
}

const WRONGBOOK_TODAY_GROUP_ID = "wrongbook-today";
const WRONGBOOK_HISTORY_GROUP_ID = "wrongbook-history";

function getAttemptGroupId(attempt: AttemptSummary) {
  if (attempt.practiceType === "wrongbook-today") return WRONGBOOK_TODAY_GROUP_ID;
  if (attempt.practiceType === "wrongbook-history") return WRONGBOOK_HISTORY_GROUP_ID;
  return attempt.setId;
}

function normalizeAttemptGroupId(setId: string) {
  if (setId === WRONGBOOK_TODAY_GROUP_ID || setId.startsWith("wrongbook-today-")) {
    return WRONGBOOK_TODAY_GROUP_ID;
  }
  if (
    setId === WRONGBOOK_HISTORY_GROUP_ID ||
    setId.startsWith("wrongbook-all-") ||
    setId.startsWith("wrongbook-random-")
  ) {
    return WRONGBOOK_HISTORY_GROUP_ID;
  }
  return setId;
}

function getAttemptGroupTitle(groupId: string, fallback: string) {
  if (groupId === WRONGBOOK_TODAY_GROUP_ID) return "今日错题";
  if (groupId === WRONGBOOK_HISTORY_GROUP_ID) return "历史错题";
  return fallback;
}

function toTeacherErrorMessage(message: string) {
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  if (/empty response/i.test(message)) return "数据服务返回了空响应，请稍后重试。";
  if (/invalid json/i.test(message)) return "数据服务返回的数据格式无效，请稍后重试。";
  return /[\u3400-\u9fff]/.test(message) ? message : "数据加载失败，请稍后重试。";
}

function StudentTableSkeleton() {
  return (
    <div className="overflow-x-auto px-6 pb-6 pt-4">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-student-border text-student-muted">
            <th className="px-3 py-3 font-medium">学生</th>
            <th className="px-3 py-3 font-medium">完成套题数</th>
            <th className="px-3 py-3 font-medium">总练习次数</th>
            <th className="px-3 py-3 font-medium">平均正确率</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }, (_, index) => (
            <tr className="border-b border-student-border" key={index}>
              <td className="px-3 py-3"><TeacherSkeleton className="h-10 w-40" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-5 w-12" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-5 w-12" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-5 w-40" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StudentTableError({ text }: { text: string }) {
  return (
    <div className="overflow-x-auto px-6 pb-6 pt-4">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-student-border text-student-muted">
            <th className="px-3 py-3 font-medium">学生</th>
            <th className="px-3 py-3 font-medium">完成套题数</th>
            <th className="px-3 py-3 font-medium">总练习次数</th>
            <th className="px-3 py-3 font-medium">平均正确率</th>
          </tr>
        </thead>
      </table>
      <div className="mt-4"><TeacherDataError text={text} /></div>
    </div>
  );
}

function SetTableSkeleton() {
  return (
    <tbody>
      {Array.from({ length: 5 }, (_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: 5 }, (_, cellIndex) => (
            <td className="border-t border-student-border px-4 py-4" key={cellIndex}>
              <TeacherSkeleton className={cellIndex === 0 ? "h-5 w-40" : cellIndex === 4 ? "h-5 w-40" : "h-5 w-20"} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

function PracticeHistorySkeleton() {
  return (
    <section className="rounded-2xl border border-student-border bg-white p-4 shadow-[0_2px_12px_rgba(60,47,119,0.045)] sm:p-5">
      <h2 className="text-xl font-bold text-student-text">练习记录</h2>
      <div className="mt-4 grid gap-2">
        {Array.from({ length: 3 }, (_, index) => <TeacherSkeleton className="h-[68px] w-full rounded-xl" key={index} />)}
      </div>
    </section>
  );
}

function PracticeHistoryError() {
  return (
    <section className="rounded-2xl border border-student-border bg-white p-4 shadow-[0_2px_12px_rgba(60,47,119,0.045)] sm:p-5">
      <h2 className="text-xl font-bold text-student-text">练习记录</h2>
      <p className="mt-4 text-sm text-student-muted">练习记录暂时无法显示。</p>
    </section>
  );
}

function AttemptHistorySkeleton() {
  return (
    <div className="grid gap-5">
      <div className="flex justify-end">
        <div className="rounded-[10px] border border-student-primary-border bg-white px-3 py-2 text-sm font-semibold text-student-primary">只看错题</div>
      </div>
      {Array.from({ length: 3 }, (_, index) => <TeacherSkeleton className="h-28 w-full rounded-2xl" key={index} />)}
    </div>
  );
}

function QuestionDetailSkeleton() {
  return (
    <>
      <TeacherBreadcrumbs crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "学生", href: "/teacher/students" },
        { label: "答题详情" }
      ]} />
      <TeacherCard className="p-5"><TeacherSkeleton className="h-6 w-48" /><TeacherSkeleton className="mt-5 h-32 w-full" /></TeacherCard>
      <TeacherCard className="p-5"><TeacherSectionTitle>答题情况</TeacherSectionTitle><TeacherSkeleton className="mt-4 h-44 w-full" /></TeacherCard>
    </>
  );
}

function QuestionDetailError({ text }: { text: string }) {
  return (
    <>
      <TeacherBreadcrumbs crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "学生", href: "/teacher/students" },
        { label: "答题详情" }
      ]} />
      <TeacherCard className="p-5"><TeacherSectionTitle>练习概览</TeacherSectionTitle><div className="mt-4"><TeacherDataError text={text} /></div></TeacherCard>
      <TeacherCard className="p-5"><TeacherSectionTitle>答题情况</TeacherSectionTitle><p className="mt-4 text-sm text-student-muted">答题数据暂时无法显示。</p></TeacherCard>
    </>
  );
}

function QuestionAccuracySkeleton() {
  return (
    <div className="mt-6 grid gap-5 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
      {Array.from({ length: 5 }, (_, index) => <TeacherSkeleton className="h-[140px] w-full rounded-2xl" key={index} />)}
    </div>
  );
}

function QuestionStatisticsSkeleton() {
  return (
    <>
      <TeacherCard className="p-5"><TeacherSkeleton className="h-5 w-20" /><TeacherSkeleton className="mt-3 h-7 w-64" /><TeacherSkeleton className="mt-6 h-28 w-full" /></TeacherCard>
      <TeacherCard className="border-student-primary-border bg-student-primary-soft/55 p-5"><p className="text-sm font-semibold text-student-primary">正确答案</p><TeacherSkeleton className="mt-3 h-6 w-3/4" /></TeacherCard>
      <div className="grid gap-5 sm:grid-cols-3">
        <TeacherMetricCard icon={Target} label="平均正确率" value={<TeacherSkeleton className="h-8 w-16" />} />
        <TeacherMetricCard icon={FileText} label="总作答次数" value={<TeacherSkeleton className="h-8 w-14" />} />
        <TeacherMetricCard icon={CircleX} label="错误次数" tone="warning" value={<TeacherSkeleton className="h-8 w-14" />} />
      </div>
      <TeacherCard className="p-6"><TeacherSectionTitle>常见错误答案</TeacherSectionTitle><TeacherSkeleton className="mt-4 h-24 w-full" /></TeacherCard>
    </>
  );
}

function QuestionStatisticsError({ text }: { text: string }) {
  return (
    <>
      <TeacherCard className="p-5"><TeacherDataError text={text} /></TeacherCard>
      <TeacherCard className="border-student-primary-border bg-student-primary-soft/55 p-5"><p className="text-sm font-semibold text-student-primary">正确答案</p><p className="mt-3 text-sm text-student-muted">题目数据暂时无法显示。</p></TeacherCard>
      <div className="grid gap-5 sm:grid-cols-3">
        <TeacherMetricCard icon={Target} label="平均正确率" value="—" />
        <TeacherMetricCard icon={FileText} label="总作答次数" value="—" />
        <TeacherMetricCard icon={CircleX} label="错误次数" tone="warning" value="—" />
      </div>
      <TeacherCard className="p-6"><TeacherSectionTitle>常见错误答案</TeacherSectionTitle><p className="mt-4 text-sm text-student-muted">错误答案数据暂时无法显示。</p></TeacherCard>
    </>
  );
}

function groupBy<T>(items: T[], getKey: (item: T) => string) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
    return groups;
  }, new Map<string, T[]>());
}
