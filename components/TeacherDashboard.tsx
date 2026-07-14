"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { buildSentenceDisplay } from "@/lib/questionText";
import { createBrowserSupabase } from "@/lib/supabase/client";
import {
  TEACHER_STATS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";

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

export function TeacherDashboard() {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      <HomeCard
        description="Review each student's completion history and answer details."
        href="/teacher/students"
        title="Students"
      />
      <HomeCard
        description="Review set-level and question-level performance."
        href="/teacher/sets"
        title="Practice Sets"
      />
      <HomeCard
        description="Browse the question bank by month and review each set's prompts, blanks, word blocks, and answers."
        href="/teacher/question-bank"
        title="All Practice Sets"
      />
    </div>
  );
}

export function TeacherStudentsList() {
  return (
    <TeacherStatsLoader>
      {(stats) => (
        <div className="grid gap-5">
          <TeacherNavigation
            backHref="/teacher/dashboard"
            crumbs={[
              { label: "Teacher Home", href: "/teacher/dashboard" },
              { label: "Students" }
            ]}
          />
          <div className="flex justify-end">
            <Link
              className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ocean"
              href="/teacher/students/new"
            >
              Add student
            </Link>
          </div>
          <Panel title="Students">
            <ResponsiveTable
              emptyText="No students yet."
              headers={["Student", "Completed sets", "Total attempts", "Average accuracy"]}
              rows={stats.students.map((student) => ({
                key: student.studentId,
                cells: [
                  <Link
                    className="font-semibold text-ocean hover:underline"
                    href={`/teacher/students/${student.studentId}`}
                    key="email"
                  >
                    {student.studentDisplayName}
                  </Link>,
                  student.completedSetCount,
                  student.totalAttemptCount,
                  <Accuracy value={student.averageAccuracy} key="accuracy" />
                ]
              }))}
            />
          </Panel>
        </div>
      )}
    </TeacherStatsLoader>
  );
}

export function TeacherStudentSummary({ studentId }: { studentId: string }) {
  return (
    <TeacherStatsLoader>
      {(stats) => {
        const student = stats.students.find((item) => item.studentId === studentId);
        if (!student) return <EmptyState text="Student not found." />;

        return (
          <div className="grid gap-5">
            <TeacherNavigation
              backHref="/teacher/students"
              crumbs={[
                { label: "Teacher Home", href: "/teacher/dashboard" },
                { label: "Students", href: "/teacher/students" },
                { label: student.studentDisplayName }
              ]}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink/60">Student</p>
                <h2 className="text-2xl font-bold">{student.studentDisplayName}</h2>
              </div>
              <Link
                className="rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-ocean"
                href={`/teacher/students/${studentId}/details`}
              >
                View details
              </Link>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Completed sets" value={String(student.completedSetCount)} />
              <Metric label="Total attempts" value={String(student.totalAttemptCount)} />
              <Metric label="Average accuracy" value={formatPercent(student.averageAccuracy)} />
              <Metric label="Answered questions" value={String(student.answeredQuestionCount)} />
            </div>
          </div>
        );
      }}
    </TeacherStatsLoader>
  );
}

export function TeacherStudentDetails({ studentId }: { studentId: string }) {
  return (
    <TeacherStatsLoader>
      {(stats) => {
        const student = stats.students.find((item) => item.studentId === studentId);
        if (!student) return <EmptyState text="Student not found." />;

        const attempts = stats.attempts
          .filter((attempt) => attempt.studentId === studentId)
          .sort(
            (a, b) =>
              compareAttemptGroupIds(getAttemptGroupId(a), getAttemptGroupId(b)) ||
              compareDatesDesc(a.submittedAt, b.submittedAt)
          );
        const attemptsBySet = groupBy(attempts, getAttemptGroupId);
        const setGroups = Array.from(attemptsBySet.entries()).sort(([leftSetId], [rightSetId]) =>
          compareAttemptGroupIds(leftSetId, rightSetId)
        );

        return (
          <div className="grid gap-5">
            <TeacherNavigation
              backHref={`/teacher/students/${studentId}`}
              crumbs={[
                { label: "Teacher Home", href: "/teacher/dashboard" },
                { label: "Students", href: "/teacher/students" },
                { label: student.studentDisplayName, href: `/teacher/students/${studentId}` },
                { label: "Details" }
              ]}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink/60">Student details</p>
                <h2 className="text-2xl font-bold">{student.studentDisplayName}</h2>
              </div>
            </div>
            {attempts.length === 0 ? <EmptyState text="No completed practice sets yet." /> : null}
            <div className="grid gap-4 md:grid-cols-2">
              {setGroups.map(([groupId, setAttempts]) => {
                const latestAttempt = [...setAttempts].sort((a, b) =>
                  compareDatesDesc(a.submittedAt, b.submittedAt)
                )[0];
                const bestAccuracy = Math.max(...setAttempts.map((attempt) => attempt.accuracy));
                const setTitle = getAttemptGroupTitle(
                  groupId,
                  latestAttempt?.setTitle ?? groupId
                );
                const href = `/teacher/students/${studentId}/details/${encodeURIComponent(groupId)}`;

                return (
                  <Link
                    className="rounded-lg border border-line bg-white p-5 shadow-sm hover:border-ocean"
                    href={href}
                    key={groupId}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-ocean">{setTitle}</p>
                        <h3 className="mt-1 text-sm font-semibold text-ink/60">{groupId}</h3>
                      </div>
                      <span className="rounded-full bg-paper px-3 py-1 text-xs font-semibold">
                        {setAttempts.length} attempt{setAttempts.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <div className="mt-4 grid gap-2 text-sm">
                      <p>
                        <span className="font-semibold text-ink/60">Latest completed:</span>{" "}
                        {formatDateTime(latestAttempt?.submittedAt ?? null)}
                      </p>
                      <p>
                        <span className="font-semibold text-ink/60">Latest accuracy:</span>{" "}
                        {formatPercent(latestAttempt?.accuracy ?? 0)}
                      </p>
                      <p>
                        <span className="font-semibold text-ink/60">Best accuracy:</span>{" "}
                        {formatPercent(bestAccuracy)}
                      </p>
                    </div>
                    <span className="mt-5 inline-flex rounded-md bg-ink px-4 py-2 text-sm font-semibold text-white">
                      View attempts
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      }}
    </TeacherStatsLoader>
  );
}

export function TeacherStudentSetDetails({
  setId,
  studentId
}: {
  setId: string;
  studentId: string;
}) {
  const [incorrectOnly, setIncorrectOnly] = useState(false);

  return (
    <TeacherStatsLoader>
      {(stats) => {
        const student = stats.students.find((item) => item.studentId === studentId);
        if (!student) return <EmptyState text="Student not found." />;

        const groupId = normalizeAttemptGroupId(setId);
        const attempts = stats.attempts
          .filter(
            (attempt) =>
              attempt.studentId === studentId && getAttemptGroupId(attempt) === groupId
          )
          .sort((a, b) => compareDatesDesc(a.submittedAt, b.submittedAt));
        const setTitle = getAttemptGroupTitle(
          groupId,
          attempts[0]?.setTitle ??
            stats.sets.find((set) => set.setId === groupId)?.setTitle ??
            groupId
        );

        return (
          <div className="grid gap-5">
            <TeacherNavigation
              backHref={`/teacher/students/${studentId}/details`}
              crumbs={[
                { label: "Teacher Home", href: "/teacher/dashboard" },
                { label: "Students", href: "/teacher/students" },
                { label: student.studentDisplayName, href: `/teacher/students/${studentId}` },
                { label: "Details", href: `/teacher/students/${studentId}/details` },
                { label: setTitle }
              ]}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-ink/60">Set attempts</p>
                <h2 className="text-2xl font-bold">{setTitle}</h2>
                <p className="text-sm text-ink/60">{groupId}</p>
              </div>
              <label className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold">
                <input
                  checked={incorrectOnly}
                  className="h-4 w-4 accent-ocean"
                  onChange={(event) => setIncorrectOnly(event.target.checked)}
                  type="checkbox"
                />
                Show incorrect only
              </label>
            </div>
            {attempts.length === 0 ? <EmptyState text="No attempts found for this set." /> : null}
            <div className="grid gap-4">
              {attempts.map((attempt) => {
                const attemptAnswers = stats.answers
                  .filter((answer) => answer.attemptId === attempt.attemptId)
                  .sort((a, b) => a.questionOrder - b.questionOrder);
                const answers = attemptAnswers.filter((answer) =>
                  incorrectOnly ? !answer.isCorrect : true
                );

                if (
                  attemptAnswers.length === 0 &&
                  stats.missingAnswerAttemptIds.includes(attempt.attemptId)
                ) {
                  return (
                    <div
                      className="rounded-md border border-coral bg-coral/10 p-4"
                      key={attempt.attemptId}
                    >
                      <AttemptHeader attempt={attempt} />
                      <p className="mt-3 text-sm font-semibold text-coral">
                        No answer records were saved for attempt {attempt.attemptId}.
                      </p>
                    </div>
                  );
                }

                if (incorrectOnly && answers.length === 0) {
                  return (
                    <div className="rounded-md border border-line bg-paper p-4" key={attempt.attemptId}>
                      <AttemptHeader attempt={attempt} />
                      <p className="mt-3 text-sm text-ink/60">No incorrect answers.</p>
                    </div>
                  );
                }

                return (
                  <div className="rounded-md border border-line bg-paper p-4" key={attempt.attemptId}>
                    <AttemptHeader attempt={attempt} />
                    <div className="mt-3 flex flex-wrap gap-2">
                      {answers.map((answer) => (
                        <AttemptAnswerJumpLink
                          href={`/teacher/students/${studentId}/answers/${answer.attemptAnswerId}`}
                          key={answer.attemptAnswerId}
                          answer={answer}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      }}
    </TeacherStatsLoader>
  );
}

export function TeacherStudentQuestionDetail({ attemptAnswerId }: { attemptAnswerId: string }) {
  return (
    <TeacherStatsLoader>
      {(stats) => (
        <TeacherStudentQuestionDetailContent
          initialAttemptAnswerId={attemptAnswerId}
          stats={stats}
        />
      )}
    </TeacherStatsLoader>
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
  const [attemptAnswers] = useState<AnswerSummary[]>(() =>
    initialAnswer
      ? stats.answers
          .filter(
            (item) =>
              item.studentId === initialAnswer.studentId &&
              item.attemptId === initialAnswer.attemptId
          )
          .sort((a, b) => a.questionOrder - b.questionOrder)
      : []
  );
  const [activeAttemptAnswerId, setActiveAttemptAnswerId] = useState(initialAttemptAnswerId);

  useEffect(() => {
    function selectAnswerFromUrl() {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const requestedQuestionId = hash.get("question");
      const requestedAnswer = attemptAnswers.find(
        (item) => item.questionId === requestedQuestionId
      );
      const nextAnswerId = requestedAnswer?.attemptAnswerId ?? initialAttemptAnswerId;

      setActiveAttemptAnswerId(nextAnswerId);
    }

    selectAnswerFromUrl();
    window.addEventListener("popstate", selectAnswerFromUrl);
    window.addEventListener("hashchange", selectAnswerFromUrl);
    return () => {
      window.removeEventListener("popstate", selectAnswerFromUrl);
      window.removeEventListener("hashchange", selectAnswerFromUrl);
    };
  }, [attemptAnswers, initialAttemptAnswerId]);

  if (!initialAnswer) return <EmptyState text="Question detail not found." />;

  const answer =
    attemptAnswers.find((item) => item.attemptAnswerId === activeAttemptAnswerId) ??
    initialAnswer;
  const attempt = stats.attempts.find((item) => item.attemptId === answer.attemptId);
  const groupId = attempt ? getAttemptGroupId(attempt) : answer.setId;
  const groupTitle = getAttemptGroupTitle(
    groupId,
    attempt?.setTitle ?? answer.setTitle
  );
  const student = stats.students.find((item) => item.studentId === answer.studentId);
  const studentLabel = student?.studentDisplayName ?? "Student";

  function selectAnswer(nextAnswer: AnswerSummary) {
    setActiveAttemptAnswerId(nextAnswer.attemptAnswerId);
    const hash = new URLSearchParams();
    hash.set("question", nextAnswer.questionId);
    window.history.pushState(
      null,
      "",
      `${window.location.pathname}${window.location.search}#${hash}`
    );
  }

  return (
    <div className="grid gap-5">
      <TeacherNavigation
        backHref={`/teacher/students/${answer.studentId}/details/${encodeURIComponent(groupId)}`}
        crumbs={[
          { label: "Teacher Home", href: "/teacher/dashboard" },
          { label: "Students", href: "/teacher/students" },
          { label: studentLabel, href: `/teacher/students/${answer.studentId}` },
          { label: "Details", href: `/teacher/students/${answer.studentId}/details` },
          {
            label: groupTitle,
            href: `/teacher/students/${answer.studentId}/details/${encodeURIComponent(groupId)}`
          },
          { label: `Q${answer.questionOrder}` }
        ]}
      />
      <QuestionDetailCard
        badge={
          <div className="flex flex-wrap items-center gap-2">
            <TimeSpentBadge seconds={answer.questionTimeSeconds} />
            <StatusBadge correct={answer.isCorrect} />
          </div>
        }
        correctAnswer={buildSentenceDisplay(
          answer.sentenceTemplate,
          answer.correctOrderText,
          answer.finalSentence
        )}
        prompt={answer.prompt}
        studentAnswer={buildSentenceDisplay(
          answer.sentenceTemplate,
          answer.displaySubmittedOrderText || answer.submittedOrderText
        )}
      />
      {attemptAnswers.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          {attemptAnswers.map((item) => (
            <AttemptAnswerJumpLink
              active={item.attemptAnswerId === answer.attemptAnswerId}
              answer={item}
              href={`/teacher/students/${answer.studentId}/answers/${item.attemptAnswerId}`}
              key={item.attemptAnswerId}
              onNavigate={() => selectAnswer(item)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function TeacherSetsList() {
  return (
    <TeacherStatsLoader>
      {(stats) => (
        <div className="grid gap-5">
          <TeacherNavigation
            backHref="/teacher/dashboard"
            crumbs={[
              { label: "Teacher Home", href: "/teacher/dashboard" },
              { label: "Practice Sets" }
            ]}
          />
          <Panel title="Practice Sets">
            <ResponsiveTable
              emptyText="No practice sets yet."
              headers={["Set", "Set ID", "Questions", "Total attempts", "Average accuracy"]}
              rows={stats.sets.map((set) => ({
                key: set.setId,
                cells: [
                  <Link
                    className="font-semibold text-ocean hover:underline"
                    href={`/teacher/sets/${encodeURIComponent(set.setId)}`}
                    key="set"
                  >
                    {set.setTitle}
                  </Link>,
                  <code className="text-xs" key="id">{set.setId}</code>,
                  set.questionCount,
                  set.totalAttemptCount,
                  <Accuracy value={set.averageAccuracy} key="accuracy" />
                ]
              }))}
            />
          </Panel>
        </div>
      )}
    </TeacherStatsLoader>
  );
}

export function TeacherSetSummary({ setId }: { setId: string }) {
  return (
    <TeacherStatsLoader>
      {(stats) => {
        const set = stats.sets.find((item) => item.setId === setId);
        if (!set) return <EmptyState text="Practice set not found." />;

        const questions = stats.questions
          .filter((question) => question.setId === setId)
          .sort((a, b) => a.questionOrder - b.questionOrder);

        return (
          <div className="grid gap-5">
            <TeacherNavigation
              backHref="/teacher/sets"
              crumbs={[
                { label: "Teacher Home", href: "/teacher/dashboard" },
                { label: "Practice Sets", href: "/teacher/sets" },
                { label: set.setTitle }
              ]}
            />
            <div>
              <p className="text-sm font-semibold text-ink/60">Practice set</p>
              <h2 className="text-2xl font-bold">{set.setTitle}</h2>
              <p className="text-sm text-ink/60">{set.setId}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Total attempts" value={String(set.totalAttemptCount)} />
              <Metric label="Completed students" value={String(set.completedStudentCount)} />
              <Metric label="Average accuracy" value={formatPercent(set.averageAccuracy)} />
            </div>
            <Panel title="Question accuracy">
              {questions.length === 0 ? (
                <EmptyState text="No questions in this set." />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {questions.map((question) => (
                    <Link
                      className="rounded-md border border-line bg-paper p-4 hover:border-ocean"
                      href={`/teacher/sets/${encodeURIComponent(setId)}/questions/${encodeURIComponent(question.questionId)}`}
                      key={question.questionId}
                    >
                      <p className="text-lg font-bold">Q{question.questionOrder}</p>
                      <p className="mt-1 text-2xl font-bold text-ocean">
                        {formatPercent(question.accuracy)}
                      </p>
                    </Link>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        );
      }}
    </TeacherStatsLoader>
  );
}

export function TeacherSetQuestionDetail({
  questionId,
  setId
}: {
  questionId: string;
  setId: string;
}) {
  return (
    <TeacherStatsLoader>
      {(stats) => {
        const question = stats.questions.find(
          (item) => item.setId === setId && item.questionId === questionId
        );
        if (!question) return <EmptyState text="Question not found." />;

        const answers = stats.answers.filter(
          (answer) =>
            answer.practiceType === "official" && answer.questionId === questionId
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

        return (
          <div className="grid gap-5">
            <TeacherNavigation
              backHref={`/teacher/sets/${encodeURIComponent(setId)}`}
              crumbs={[
                { label: "Teacher Home", href: "/teacher/dashboard" },
                { label: "Practice Sets", href: "/teacher/sets" },
                {
                  label: question.setTitle,
                  href: `/teacher/sets/${encodeURIComponent(setId)}`
                },
                { label: `Q${question.questionOrder}` }
              ]}
            />
            <QuestionDetailCard
              correctAnswer={buildSentenceDisplay(
                question.sentenceTemplate,
                question.correctOrderText || answers[0]?.correctOrderText || "",
                question.finalSentence
              )}
              prompt={question.prompt}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <Metric label="Average accuracy" value={formatPercent(question.accuracy)} />
              <Metric label="Total answers" value={String(question.answerCount)} />
              <Metric label="Incorrect answers" value={String(wrongAnswers.length)} />
            </div>
            <Panel title="Frequent incorrect answers">
              <ResponsiveTable
                emptyText="No incorrect answers yet."
                headers={["Student answer", "Count"]}
                rows={frequentWrong.map((item) => ({
                  key: item.submittedOrderText || "empty",
                  highlight: true,
                  cells: [
                    item.submittedOrderText
                      ? buildSentenceDisplay(question.sentenceTemplate, item.submittedOrderText)
                      : "No answer",
                    item.count
                  ]
                }))}
              />
            </Panel>
          </div>
        );
      }}
    </TeacherStatsLoader>
  );
}

function TeacherStatsLoader({
  children
}: {
  children: (stats: TeacherStatsPayload) => ReactNode;
}) {
  const { data: stats, error, loading } = useTeacherCachedData<TeacherStatsPayload>(
    TEACHER_STATS_CACHE_KEY,
    loadTeacherStats
  );

  if (loading) {
    return <p className="text-sm text-ink/70">Loading analytics...</p>;
  }

  if (error) {
    return <p className="font-semibold text-coral">{error}</p>;
  }

  if (!stats) {
    return <EmptyState text="No analytics yet." />;
  }

  return <>{children(stats)}</>;
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
      : { error: "The teacher stats API returned an empty response." };
  } catch {
    payload = { error: "The teacher stats API returned invalid JSON." };
  }

  if (!response.ok || "error" in payload) {
    throw new Error(getErrorMessage(payload, "Could not load teacher stats."));
  }

  return payload as TeacherStatsPayload;
}

function HomeCard({
  description,
  href,
  title
}: {
  description: string;
  href: string;
  title: string;
}) {
  return (
    <Link className="rounded-lg border border-line bg-white p-6 shadow-sm hover:border-ocean" href={href}>
      <h2 className="text-2xl font-bold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-ink/70">{description}</p>
    </Link>
  );
}

export function TeacherNavigation({
  backHref,
  crumbs
}: {
  backHref: string;
  crumbs: Array<{
    href?: string;
    label: string;
  }>;
}) {
  return (
    <nav className="rounded-lg border border-line bg-white p-4 shadow-sm" aria-label="Teacher navigation">
      <div className="flex flex-wrap gap-2">
        <Link className="rounded-md border border-line px-3 py-2 text-sm font-semibold hover:border-ocean" href={backHref}>
          Back
        </Link>
        <Link className="rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white hover:bg-ocean" href="/teacher/dashboard">
          Teacher Home
        </Link>
      </div>
      <ol className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink/60">
        {crumbs.map((crumb, index) => (
          <li className="flex items-center gap-2" key={`${crumb.label}-${index}`}>
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.href ? (
              <Link className="font-semibold text-ocean hover:underline" href={crumb.href}>
                {crumb.label}
              </Link>
            ) : (
              <span className="font-semibold text-ink">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

function Panel({
  children,
  subtitle,
  title
}: {
  children: ReactNode;
  subtitle?: string;
  title: string;
}) {
  return (
    <section className="rounded-lg border border-line bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-xl font-bold">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-ink/60">{subtitle}</p> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function ResponsiveTable({
  emptyText,
  headers,
  rows
}: {
  emptyText: string;
  headers: string[];
  rows: Array<{
    key: string;
    highlight?: boolean;
    cells: ReactNode[];
  }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-line text-ink/60">
            {headers.map((header) => (
              <th className="py-2 pr-3 align-top" key={header}>
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className={`border-b border-line last:border-0 ${row.highlight ? "bg-red-50" : ""}`} key={row.key}>
              {row.cells.map((cell, index) => (
                <td className="max-w-xl py-3 pr-3 align-top leading-6" key={index}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td className="py-4 text-ink/60" colSpan={headers.length}>
                {emptyText}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function QuestionDetailCard({
  badge,
  correctAnswer,
  prompt,
  studentAnswer
}: {
  badge?: ReactNode;
  correctAnswer: string;
  prompt: string;
  studentAnswer?: string;
}) {
  return (
    <Panel title="Question detail">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink/60">Prompt</p>
            <p className="mt-1 text-lg font-semibold">{prompt || "No prompt"}</p>
          </div>
          {badge}
        </div>
        {studentAnswer !== undefined ? (
          <AnswerBlock label="Student answer" value={studentAnswer || "No answer"} />
        ) : null}
        <AnswerBlock label="Correct answer" value={correctAnswer || "No correct answer"} />
      </div>
    </Panel>
  );
}

function AnswerBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-paper p-4">
      <p className="text-sm font-semibold text-ink/60">{label}</p>
      <p className="mt-1 text-lg leading-7">{value}</p>
    </div>
  );
}

function AttemptHeader({ attempt }: { attempt: AttemptSummary }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="font-semibold">{formatDateTime(attempt.submittedAt)}</p>
        <p className="text-sm text-ink/60">
          Accuracy {formatPercent(attempt.accuracy)} · Time {formatDuration(attempt.timeSpentSeconds)}
        </p>
      </div>
    </div>
  );
}

function AttemptAnswerJumpLink({
  active = false,
  answer,
  href,
  onNavigate
}: {
  active?: boolean;
  answer: AnswerSummary;
  href: string;
  onNavigate?: () => void;
}) {
  const colorClass = answer.isCorrect
    ? "border-green-200 bg-green-50 text-green-700"
    : "border-red-200 bg-red-50 text-red-700";
  const activeClass = answer.isCorrect
    ? "ring-2 ring-green-500 ring-offset-2"
    : "ring-2 ring-red-500 ring-offset-2";

  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={`rounded-md border px-3 py-2 text-sm font-bold ${colorClass} ${
        active ? activeClass : ""
      }`}
      href={href}
      onClick={(event) => {
        if (
          !onNavigate ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        event.preventDefault();
        onNavigate();
      }}
      prefetch={onNavigate ? false : undefined}
    >
      Q{answer.questionOrder} · {formatQuestionDuration(answer.questionTimeSeconds)}
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-ink/60">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function Accuracy({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 w-28 overflow-hidden rounded-full bg-paper">
        <div className="h-full bg-ocean" style={{ width: formatPercent(value) }} />
      </div>
      <span className="font-semibold">{formatPercent(value)}</span>
    </div>
  );
}

function StatusBadge({ correct }: { correct: boolean }) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-sm font-bold ${
        correct ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
      }`}
    >
      {correct ? "Correct" : "Incorrect"}
    </span>
  );
}

function TimeSpentBadge({ seconds }: { seconds: number | null }) {
  return (
    <span className="rounded-full bg-paper px-3 py-1 text-sm font-bold text-ink">
      Time spent: {formatNullableQuestionDuration(seconds)}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="rounded-lg border border-line bg-white p-5 text-ink/60">{text}</p>;
}

function getErrorMessage(value: TeacherStatsPayload | { error?: string }, fallback: string) {
  return "error" in value && value.error ? value.error : fallback;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatDateTime(value: string | null) {
  if (!value) return "Unknown date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "N/A";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.max(0, Math.round(seconds % 60));
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function formatQuestionDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "0s";
  const safeSeconds = Math.max(0, Math.round(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;

  const minutes = Math.floor(safeSeconds / 60);
  const remaining = safeSeconds % 60;
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

function formatNullableQuestionDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "N/A";
  return formatQuestionDuration(seconds);
}

function compareDatesDesc(a: string | null, b: string | null) {
  return new Date(b ?? 0).getTime() - new Date(a ?? 0).getTime();
}

function parseSetSortKey(setId: string) {
  const parts = setId.split("-");
  const datePart = Number(parts[1] ?? 0);
  const setNumber = Number(parts[2] ?? 1);

  return {
    datePart: Number.isFinite(datePart) ? datePart : 0,
    setNumber: Number.isFinite(setNumber) ? setNumber : 1
  };
}

function compareSetIds(a: string, b: string) {
  const ak = parseSetSortKey(a);
  const bk = parseSetSortKey(b);

  return ak.datePart - bk.datePart || ak.setNumber - bk.setNumber || a.localeCompare(b);
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
  if (groupId === WRONGBOOK_TODAY_GROUP_ID) return "Today's Wrong Questions";
  if (groupId === WRONGBOOK_HISTORY_GROUP_ID) return "Historical Wrong Questions";
  return fallback;
}

function compareAttemptGroupIds(left: string, right: string) {
  if (left === right) return 0;

  const leftWrongbook = left === WRONGBOOK_TODAY_GROUP_ID || left === WRONGBOOK_HISTORY_GROUP_ID;
  const rightWrongbook = right === WRONGBOOK_TODAY_GROUP_ID || right === WRONGBOOK_HISTORY_GROUP_ID;

  if (leftWrongbook !== rightWrongbook) return leftWrongbook ? 1 : -1;
  if (leftWrongbook && rightWrongbook) {
    return left === WRONGBOOK_TODAY_GROUP_ID ? -1 : 1;
  }
  return compareSetIds(left, right);
}

function groupBy<T>(items: T[], getKey: (item: T) => string) {
  return items.reduce((groups, item) => {
    const key = getKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
    return groups;
  }, new Map<string, T[]>());
}
