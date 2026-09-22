"use client";

import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  BookOpenCheck,
  CircleX,
  ClipboardList,
  ClipboardPenLine,
  CloudUpload,
  Clock3,
  FileText,
  GraduationCap,
  Network,
  Target,
  TrendingUp,
  UserRound,
  Users,
  type LucideIcon
} from "lucide-react";
import {
  buildSentenceDisplay,
  formatTextItems,
  isBlankToken,
  splitSentenceTemplate,
  splitTextItems
} from "@/lib/questionText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { formatAccountForDisplay } from "@/lib/accountIdentifier";
import { useCurrentAccount } from "@/components/RoleGate";
import {
  TEACHER_DASHBOARD_CACHE_KEY,
  TEACHER_STATS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import type { StudentBindingDomain } from "@/lib/studentBindings";
import type { TeacherDashboardPayload } from "@/lib/teacherDashboard";
import { loadTeacherDashboardPayload } from "@/lib/teacherDashboardClient";
import { AttemptHistoryList } from "@/components/AttemptHistoryList";
import { PracticeResultView, type ResultPayload } from "@/components/PracticeResult";
import { PracticeHistoryCompactList } from "@/components/shared/PracticeHistoryCards";
import { QuestionDisplay } from "@/components/shared/QuestionDisplay";
import { DomainChip, TeacherStudentReadingSection } from "@/components/teacher/TeacherStudentReading";
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
  teacherDomains: StudentBindingDomain[];
  overview: {
    studentCount: number;
    totalAttemptCount: number;
    answeredQuestionCount: number;
    averageAccuracy: number;
  };
  missingAnswerAttemptIds: string[];
  students: StudentSummary[];
  sets: LogicalSetSummary[];
  logicalQuestionStats: LogicalItemQuestionStats[];
  rawSets: RawSetSummary[];
  attempts: AttemptSummary[];
  answers: AnswerSummary[];
  questions: QuestionSummary[];
};

type StudentSummary = {
  studentId: string;
  studentEmail: string;
  studentName: string;
  studentDisplayName: string;
  domains: StudentBindingDomain[];
  completedSetCount: number;
  totalAttemptCount: number;
  answeredQuestionCount: number;
  correctCount: number;
  averageAccuracy: number;
};

type LogicalSetSummary = {
  itemId: string;
  displayNumber: string;
  setTitle: string;
  firstSeenDate: string;
  occurrenceDates: string[];
  sourceSetIds: string[];
  questionCount: number;
  totalAttemptCount: number;
  completedStudentCount: number;
  averageAccuracy: number;
  isActive: boolean;
};

type RawSetSummary = {
  setId: string;
  setTitle: string;
  questionCount: number;
  totalAttemptCount: number;
  completedStudentCount: number;
  averageAccuracy: number;
};

type LogicalRepresentativeQuestion = {
  sourceId: string;
  sourceSetId: string;
  sourceQuestionId: string;
  sourceQuestionOrder: number;
  setTitle: string;
  prompt: string;
  sentenceTemplate: string;
  optionsText: string;
  correctOrderText: string;
  finalSentence: string;
};

type LogicalQuestionSummary = {
  logicalQuestionId: string;
  itemId: string;
  logicalQuestionOrder: number;
  representativeQuestion: LogicalRepresentativeQuestion | null;
  attemptAnswerIds: string[];
  answerCount: number;
  correctCount: number;
  incorrectCount: number;
  accuracy: number;
};

type LogicalItemQuestionStats = {
  itemId: string;
  displayNumber: string;
  isActive: boolean;
  questions: LogicalQuestionSummary[];
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

const LOW_ACCURACY_THRESHOLD = 0.5;

export function TeacherDashboard() {
  const { dashboard, error, loading } = useTeacherDashboard();
  const recentActivity = dashboard?.recentActivity ?? [];

  return (
    <div className="grid gap-8">
      {loading ? <TeacherLoadingRegion label="正在加载教师首页数据" /> : null}
      {/*
        Management entries are fixed for every ordinary teacher. Missing data
        renders zero or a normal empty state; entries are never removed because
        the teacher has no Reading or no Writing students.
      */}
      <section>
        <TeacherSectionTitle>管理入口</TeacherSectionTitle>
        <div className="mt-4 grid gap-5 md:grid-cols-3">
          <TeacherFeatureCard
            description="查看学生练习情况与学习记录"
            href="/teacher/students"
            icon={Users}
            metric={loading ? <TeacherSkeleton className="h-4 w-14" /> : error ? "—" : `${dashboard?.studentCount ?? 0} 名学生`}
            title="学生"
          />
          <TeacherFeatureCard
            description="查看学生 BAS 表现与套题分析"
            href="/teacher/sets"
            icon={BarChart3}
            metric={loading ? <TeacherSkeleton className="h-4 w-10" /> : `${dashboard?.writing?.setCount ?? 0} 套`}
            title="套题统计"
          />
          <TeacherFeatureCard
            description="查看学生阅读表现与练习统计"
            href="/teacher/reading/statistics"
            icon={BookOpenCheck}
            metric={loading ? <TeacherSkeleton className="h-4 w-10" /> : `${dashboard?.reading?.completedAttemptCount ?? 0} 次`}
            title="阅读统计"
          />
          <TeacherFeatureCard
            description="布置写作任务并查看完成状态"
            href="/teacher/writing/assignments"
            icon={ClipboardList}
            metric="作业"
            title="作业管理"
          />
          <TeacherFeatureCard
            description="批改学生写作并发布反馈"
            href="/teacher/writing/reviews"
            icon={ClipboardPenLine}
            metric="批改"
            title="写作批改"
          />
          <TeacherFeatureCard
            description="浏览与管理所有题库内容"
            href="/teacher/question-bank"
            icon={FileText}
            metric="题库"
            title="查看所有套题"
          />
        </div>
      </section>

      <section>
        <TeacherSectionTitle>数据概览</TeacherSectionTitle>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <TeacherMetricCard icon={Users} label="总学生数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(dashboard?.studentCount ?? 0)} />
          <TeacherMetricCard icon={BookOpenCheck} label="总套题数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : String(dashboard?.writing?.setCount ?? 0)} />
          <TeacherMetricCard icon={FileText} label="总题目数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : String(dashboard?.writing?.questionCount ?? 0)} />
          <TeacherMetricCard icon={TrendingUp} label="今日新增练习" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : String(dashboard?.writing?.todayAttemptCount ?? 0)} />
          <TeacherMetricCard icon={BookOpenCheck} label="已完成阅读练习" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : String(dashboard?.reading?.completedAttemptCount ?? 0)} />
          <TeacherMetricCard icon={Clock3} label="今日新增阅读练习" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : String(dashboard?.reading?.todayAttemptCount ?? 0)} />
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
        ) : recentActivity.length > 0 ? (
          <div className="mt-4 divide-y divide-student-border">
            {recentActivity.map((activity) => (
              <div className="flex items-center justify-between gap-4 py-3 first:pt-1 last:pb-0" key={activity.activityId}>
                <div className="flex min-w-0 items-center gap-3">
                  <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                    <GraduationCap aria-hidden="true" size={19} strokeWidth={1.9} />
                  </span>
                  <p className="truncate text-sm text-student-text">
                    <span className="font-semibold">{activity.studentName}</span>
                    {" 完成了 "}
                    <span className="font-medium">{activity.domainLabel} · {activity.taskLabel}</span>
                    <span className="text-student-muted"> {activity.title}</span>
                  </p>
                </div>
                <time className="shrink-0 text-xs text-student-muted">{formatActivityTime(activity.submittedAt)}</time>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-4"><TeacherEmptyState text="暂无近期动态。" /></div>
        )}
      </TeacherCard>
    </div>
  );
}

export function TeacherHome() {
  const { role } = useCurrentAccount();
  return role === "admin" ? <AdminPlatformHome /> : <TeacherDashboard />;
}

export function AdminPlatformHome() {
  return (
    <div className="grid gap-8">
      <section>
        <TeacherSectionTitle>平台管理</TeacherSectionTitle>
        <div className="mt-4 grid gap-5 md:grid-cols-3">
          <TeacherFeatureCard
            description="管理学生账号与教师账号"
            href="/teacher/students"
            icon={Users}
            metric="学生"
            title="账号"
          />
          <TeacherFeatureCard
            description="创建教师账号并调整学生额度"
            href="/teacher/accounts/teachers"
            icon={BarChart3}
            metric="教师"
            title="教师账号"
          />
          <TeacherFeatureCard
            description="分配 Reading / Writing 教师权限"
            href="/admin/student-bindings"
            icon={Network}
            metric="绑定"
            title="教师绑定"
          />
        </div>
      </section>
      <section>
        <TeacherSectionTitle>内容浏览</TeacherSectionTitle>
        <div className="mt-4 grid gap-5 md:grid-cols-3">
          <TeacherFeatureCard
            description="浏览与管理所有题库内容"
            href="/teacher/question-bank"
            icon={FileText}
            metric="题库"
            title="查看所有套题"
          />
          <TeacherFeatureCard
            description="从 CSV 批量导入题目内容"
            href="/teacher/import"
            icon={CloudUpload}
            metric="导入"
            title="导入 CSV"
          />
        </div>
      </section>
      <TeacherCard className="p-5 sm:p-6">
        <TeacherSectionTitle>角色说明</TeacherSectionTitle>
        <p className="mt-3 text-sm text-student-muted">
          Admin 是平台管理员，负责账号与权限管理。作业管理、写作批改、阅读统计等教学工作流仅对普通教师开放。
        </p>
      </TeacherCard>
    </div>
  );
}

export function TeacherStudentSummary({ studentId }: { studentId: string }) {
  const { error, loading, stats } = useTeacherStats();
  const student = stats?.students.find((item) => item.studentId === studentId);
  const domains = student?.domains ?? [];
  const hasReading = domains.includes("reading");
  const hasWriting = domains.includes("writing");
  // BAS history only exists for writing-bound students; Reading-only students
  // never see BAS attempts, answers, or BAS summary numbers.
  const attempts = (stats?.attempts ?? []).filter(
    (attempt) => hasWriting && attempt.studentId === studentId
  );
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
                {loading ? <TeacherSkeleton className="mt-2 h-4 w-52" /> : <p className="mt-1 truncate text-sm text-student-muted">账号：{formatAccountForDisplay(student?.studentEmail) || "学生数据暂时无法显示"}</p>}
              </div>
              {!loading && domains.length > 0 ? (
                <div className="ml-auto flex flex-wrap gap-1.5">
                  {domains.map((domain) => <DomainChip domain={domain} key={domain} />)}
                </div>
              ) : null}
            </div>
          </TeacherCard>
          {loading ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StudentOverviewMetricCard icon={BookOpenCheck} label="完成套题数" value={<TeacherSkeleton className="h-8 w-12" />} />
                <StudentOverviewMetricCard icon={Clock3} label="总练习次数" value={<TeacherSkeleton className="h-8 w-12" />} />
                <StudentOverviewMetricCard icon={Target} label="平均正确率" value={<TeacherSkeleton className="h-8 w-16" />} />
                <StudentOverviewMetricCard icon={FileText} label="答题数" value={<TeacherSkeleton className="h-8 w-12" />} />
              </div>
              <PracticeHistorySkeleton />
            </>
          ) : error ? (
            <PracticeHistoryError />
          ) : (
            <>
              {hasReading ? <TeacherStudentReadingSection studentId={studentId} /> : null}
              {hasWriting ? (
                <section className="grid gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <TeacherSectionTitle>Writing 练习</TeacherSectionTitle>
                    <DomainChip domain="writing" />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <StudentOverviewMetricCard icon={BookOpenCheck} label="完成套题数" value={String(student?.completedSetCount ?? 0)} />
                    <StudentOverviewMetricCard icon={Clock3} label="总练习次数" value={String(student?.totalAttemptCount ?? 0)} />
                    <StudentOverviewMetricCard icon={Target} label="平均正确率" value={formatPercent(student?.averageAccuracy ?? 0)} />
                    <StudentOverviewMetricCard icon={FileText} label="答题数" value={String(student?.answeredQuestionCount ?? 0)} />
                  </div>
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
                </section>
              ) : null}
              {!hasReading && !hasWriting ? <TeacherEmptyState text="该学生尚未绑定教学领域。" /> : null}
            </>
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
  // BAS detail is writing-domain only. A reading-bound student reached through
  // a direct URL resolves to no BAS attempts and gets an explicit message.
  const hasWritingDomain = Boolean(student?.domains.includes("writing"));
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
      stats?.rawSets.find((set) => set.setId === groupId)?.setTitle ??
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
      {!loading && !error && !student ? <EmptyState text="未找到学生。" /> : !loading && !error && !hasWritingDomain ? (
        <TeacherEmptyState text="该学生不在你的写作教学范围内，无法查看 BAS 练习记录。" />
      ) : (
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

export function TeacherStudentQuestionDetail({
  attemptAnswerId,
  studentId
}: {
  attemptAnswerId: string;
  studentId: string;
}) {
  const { error, loading, stats } = useTeacherStats();
  const student = stats?.students.find((item) => item.studentId === studentId);
  const hasWritingDomain = Boolean(student?.domains.includes("writing"));

  return (
    <div className="grid gap-5">
      {loading ? <TeacherLoadingRegion label="正在加载答题详情" /> : null}
      {loading ? <QuestionDetailSkeleton /> : error ? (
        <QuestionDetailError text={toTeacherErrorMessage(error)} />
      ) : !hasWritingDomain ? (
        <TeacherEmptyState text="该学生不在你的写作教学范围内，无法查看 BAS 答题记录。" />
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
        <table className="w-full min-w-[820px] border-separate border-spacing-0 overflow-hidden rounded-xl border border-student-border text-left text-sm">
          <thead className="bg-student-primary-soft/55">
            <tr className="text-student-text">
              <th className="px-4 py-4 font-semibold">套题</th>
              <th className="px-4 py-4 font-semibold">首次出现日期</th>
              <th className="px-4 py-4 font-semibold">题目数</th>
              <th className="px-4 py-4 font-semibold">总练习次数</th>
              <th className="px-4 py-4 font-semibold">平均正确率</th>
            </tr>
          </thead>
          {loading ? <SetTableSkeleton /> : stats && stats.sets.length > 0 ? (
            <tbody>
              {stats.sets.map((set) => (
                <tr className="border-t border-student-border transition hover:bg-student-primary-soft/45" key={set.itemId}>
                  <td className="border-t border-student-border px-4 py-4">
                    <TeacherTextLink href={`/teacher/sets/${encodeURIComponent(set.itemId)}`}>{set.setTitle}</TeacherTextLink>
                    <p className="mt-1 text-xs text-student-muted">
                      首次出现 {formatLogicalDate(set.firstSeenDate)}
                      {set.occurrenceDates.length > 1 ? ` · ${set.occurrenceDates.length} 个日期` : ""}
                    </p>
                  </td>
                  <td className="border-t border-student-border px-4 py-4 text-student-muted">{formatLogicalDate(set.firstSeenDate)}</td>
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
  const logicalSet = stats?.sets.find((item) => item.itemId === setId);
  const logicalQuestions = stats?.logicalQuestionStats.find((item) => item.itemId === setId);
  const rawSet = logicalSet ? undefined : stats?.rawSets.find((item) => item.setId === setId);
  const set = logicalSet ?? rawSet;
  const questions = (stats?.questions ?? [])
    .filter((question) => rawSet && question.setId === rawSet.setId)
    .sort((a, b) => a.questionOrder - b.questionOrder);

  return (
    <div className="grid gap-8">
      {loading ? <TeacherLoadingRegion label="正在加载套题详情" /> : null}
      {error ? <TeacherDataError text={toTeacherErrorMessage(error)} /> : null}
      {!loading && !error && !set ? <EmptyState text="未找到套题。" /> : (
        <>
          {loading ? <TeacherSkeleton className="h-5 w-56" /> : (
            <p className="-mt-3 text-base font-medium text-student-muted">
              {set?.setTitle}
            </p>
          )}
          <div className="grid gap-5 md:grid-cols-3">
            <TeacherMetricCard icon={BookOpenCheck} label="总练习次数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(set?.totalAttemptCount ?? 0)} />
            <TeacherMetricCard icon={Users} label="完成学生数" value={loading ? <TeacherSkeleton className="h-8 w-14" /> : error ? "—" : String(set?.completedStudentCount ?? 0)} />
            <TeacherMetricCard icon={TrendingUp} label="平均正确率" value={loading ? <TeacherSkeleton className="h-8 w-16" /> : error ? "—" : (set?.totalAttemptCount ?? 0) === 0 ? "--" : formatPercent(set?.averageAccuracy ?? 0)} />
          </div>
          {logicalSet ? (
            <>
              <TeacherCard className="p-5 sm:p-7">
                <TeacherSectionTitle>各题正确率</TeacherSectionTitle>
                {!logicalQuestions || logicalQuestions.questions.length === 0 ? (
                  <div className="mt-5"><TeacherDataError text="各题统计暂时不可用。" /></div>
                ) : (
                  <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-5">
                    {logicalQuestions.questions.map((question) => (
                      <Link
                        className={`flex min-h-[76px] flex-col items-center justify-center rounded-xl border px-3 py-2 text-center transition hover:-translate-y-px hover:shadow-sm ${
                          question.answerCount === 0
                            ? "border-student-border bg-white"
                            : question.accuracy < LOW_ACCURACY_THRESHOLD
                            ? "border-student-error-border bg-student-error-soft"
                            : "border-student-primary-border bg-student-primary-soft/65"
                        }`}
                        href={`/teacher/sets/${encodeURIComponent(logicalSet.itemId)}/questions/${question.logicalQuestionOrder}`}
                        key={question.logicalQuestionId}
                      >
                        <p className={question.answerCount === 0 ? "text-sm font-semibold text-student-muted" : question.accuracy < LOW_ACCURACY_THRESHOLD ? "text-sm font-semibold text-student-error" : "text-sm font-semibold text-student-primary"}>
                          Q{question.logicalQuestionOrder}
                        </p>
                        <p className={question.answerCount === 0 ? "mt-1 text-xl font-bold leading-none text-student-muted" : question.accuracy < LOW_ACCURACY_THRESHOLD ? "mt-1 text-xl font-bold leading-none text-student-error" : "mt-1 text-xl font-bold leading-none text-student-text"}>
                          {question.answerCount === 0 ? "--" : formatPercent(question.accuracy)}
                        </p>
                        {!question.representativeQuestion ? <p className="mt-2 text-xs text-student-error">代表题目缺失</p> : null}
                      </Link>
                    ))}
                  </div>
                )}
              </TeacherCard>
            </>
          ) : (
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
          )}
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
  const logicalSet = stats?.sets.find((item) => item.itemId === setId);
  const logicalQuestion = logicalSet
    ? stats?.logicalQuestionStats
        .find((item) => item.itemId === logicalSet.itemId)
        ?.questions.find((item) => item.logicalQuestionOrder === Number(questionId))
    : undefined;
  const representative = logicalQuestion?.representativeQuestion;
  const rawQuestion = logicalSet ? undefined : stats?.questions.find(
    (item) => item.setId === setId && item.questionId === questionId
  );
  const question = representative && logicalQuestion && logicalSet
    ? {
        questionId: representative.sourceQuestionId,
        setId: logicalSet.itemId,
        setTitle: logicalSet.setTitle,
        questionOrder: logicalQuestion.logicalQuestionOrder,
        prompt: representative.prompt,
        sentenceTemplate: representative.sentenceTemplate,
        correctOrderText: representative.correctOrderText,
        finalSentence: representative.finalSentence,
        answerCount: logicalQuestion.answerCount,
        correctCount: logicalQuestion.correctCount,
        accuracy: logicalQuestion.accuracy
      }
    : rawQuestion;
  const logicalAnswerIds = new Set(logicalQuestion?.attemptAnswerIds ?? []);
  const answers = (stats?.answers ?? []).filter(
    (answer) => logicalQuestion
      ? logicalAnswerIds.has(answer.attemptAnswerId)
      : answer.practiceType === "official" && answer.questionId === questionId
  );
  const wrongAnswers = answers.filter((answer) => !answer.isCorrect);
  const frequentWrong = Array.from(
    groupBy(
      wrongAnswers,
      (answer) => formatTextItems(answer.displaySubmittedOrderText || answer.submittedOrderText) || "__empty__"
    ).entries()
  )
    .map(([displayText, grouped]) => ({
      submittedOrderText: displayText === "__empty__"
        ? ""
        : grouped[0]?.displaySubmittedOrderText || grouped[0]?.submittedOrderText || "",
      count: grouped.length
    }))
    .sort((a, b) => b.count - a.count);
  const optionChunks = splitTextItems(representative?.optionsText ?? answers[0]?.optionsText ?? "").map((text, index) => ({
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
        { label: logicalSet?.setTitle ?? question?.setTitle ?? setId, href: `/teacher/sets/${encodeURIComponent(setId)}` },
        { label: logicalQuestion ? `Q${logicalQuestion.logicalQuestionOrder}` : question ? `第 ${question.questionOrder} 题` : "单题详情" }
      ]} />
      {loading ? (
        <QuestionStatisticsSkeleton />
      ) : error ? (
        <QuestionStatisticsError text={toTeacherErrorMessage(error)} />
      ) : logicalQuestion && !representative ? (
        <QuestionStatisticsError text={`Q${logicalQuestion.logicalQuestionOrder} 的代表题目暂时不可用。`} />
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
            <TeacherMetricCard icon={Target} label="平均正确率" value={question.answerCount === 0 ? "--" : formatPercent(question.accuracy)} />
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
                          <td className="px-4 py-3 leading-6 text-student-text">
                            {buildSentenceDisplay(
                              question.sentenceTemplate,
                              item.submittedOrderText
                            ) || "未作答"}
                          </td>
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

function useTeacherDashboard() {
  const { data, error, loading } = useTeacherCachedData<TeacherDashboardPayload | null>(
    TEACHER_DASHBOARD_CACHE_KEY,
    loadTeacherDashboardPayload
  );

  return { dashboard: data, error, loading };
}

async function loadTeacherStats(): Promise<TeacherStatsPayload> {
  const supabase = createBrowserSupabase();
  const {
    data: { session }
  } = await supabase.auth.getSession();

  const response = await fetch("/api/teacher/stats", {
    cache: "no-store",
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

function formatLogicalDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return value || "日期未知";
  return `${match[1]}年${Number(match[2])}月${Number(match[3])}日`;
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
