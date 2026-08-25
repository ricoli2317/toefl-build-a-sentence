"use client";

import Link from "next/link";
import Image from "next/image";
import {
  ArrowRight,
  BookOpen,
  BookText,
  CalendarCheck,
  CalendarDays,
  FileText,
  Flame,
  Mail,
  MessageCircleMore,
  MessageSquareText,
  Puzzle,
  type LucideIcon
} from "lucide-react";
import {
  STUDENT_DASHBOARD_SUMMARY_CACHE_KEY,
  useStudentCachedData,
  type StudentCacheSession
} from "@/components/StudentDataCache";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import {
  beginStudentNavigationTrace,
  measureStudentRequest,
  useStudentPagePerformance
} from "@/lib/studentPerformance.client";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import type {
  StudentDashboardDraftSummary,
  StudentDashboardSummary
} from "@/lib/studentDashboardSummary";

export function StudentDashboard() {
  const state = useStudentCachedData<StudentDashboardSummary>(
    STUDENT_DASHBOARD_SUMMARY_CACHE_KEY,
    loadStudentDashboardSummary
  );
  useStudentPagePerformance({
    errors: [state.error],
    loading: state.loading,
    route: STUDENT_ROUTES.home
  });
  const summary = state.data;

  return (
    <div>
      <section className="relative flex h-[148px] items-center overflow-hidden rounded-3xl border border-student-primary-border bg-[linear-gradient(135deg,#fbfaff_0%,#f5f2ff_55%,#eeebff_100%)] px-7 py-4 shadow-[0_10px_30px_rgba(107,92,246,0.07)] sm:px-9">
        <div className="relative z-10 max-w-[58%] sm:max-w-[55%]">
          <h2 className="text-2xl font-bold tracking-[-0.02em] text-student-text sm:text-3xl">
            欢迎回来，继续加油！
          </h2>
          <p className="mt-3 text-sm text-student-muted sm:text-base">
            专注练习 · 提升能力 · 逐步精进
          </p>
        </div>
        <Image
          alt="打开的书、铅笔和纸飞机组成的学习插画"
          className="absolute bottom-0 right-0 h-full w-[42%] object-contain object-right-bottom sm:w-[44%]"
          height={1024}
          priority
          src="/illustrations/student-welcome-learning.png"
          width={1536}
        />
      </section>

      <DashboardSection title="写作练习" tone="purple">
        <div className="grid gap-4 lg:grid-cols-3">
          <PracticeHomeCard
            actionLabel="开始练习"
            description="组句练习"
            href={STUDENT_ROUTES.buildASentence}
            icon={Puzzle}
            meta={
              state.loading
                ? "正在加载进度..."
                : `已完成 ${summary?.buildSentence.completedSetCount ?? 0} / ${summary?.buildSentence.totalSetCount ?? 0}`
            }
            secondaryMeta={
              state.loading
                ? undefined
                : `本月 ${summary?.buildSentence.currentMonthSetCount ?? 0} 套`
            }
            title="Build a Sentence"
          />
          <WritingHomeCard draft={summary?.drafts.email ?? null} loading={state.loading} taskType="email" />
          <WritingHomeCard
            draft={summary?.drafts.academic_discussion ?? null}
            loading={state.loading}
            taskType="academic_discussion"
          />
        </div>
      </DashboardSection>

      <DashboardSection title="阅读练习" tone="blue">
        <div className="grid gap-4 lg:grid-cols-3">
          <ReadingHomeCard description="填词题练习" icon={BookText} title="Complete the Words" />
          <ReadingHomeCard description="日常生活阅读练习" icon={FileText} title="Read in Daily Life" />
          <ReadingHomeCard description="学术文章阅读练习" icon={BookOpen} title="Read an Academic Passage" />
        </div>
      </DashboardSection>

      <DashboardSection title="学习概览">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <OverviewCard icon={CalendarCheck} label="累计练习" tone="purple" value={String(summary?.overview.totalPracticeCount ?? 0)} />
          <OverviewCard icon={CalendarDays} label="本月练习" tone="blue" value={String(summary?.overview.currentMonthPracticeCount ?? 0)} />
          <OverviewCard icon={Flame} label="学习天数" tone="green" value={String(summary?.overview.learningDayCount ?? 0)} />
          <OverviewCard
            href={STUDENT_ROUTES.writingReviews}
            icon={MessageSquareText}
            label="待查看反馈"
            tone="orange"
            value={String(summary?.overview.pendingFeedbackCount ?? 0)}
          />
        </div>
      </DashboardSection>
    </div>
  );
}

function WritingHomeCard({
  draft,
  loading,
  taskType
}: {
  draft: StudentDashboardDraftSummary | null;
  loading: boolean;
  taskType: "email" | "academic_discussion";
}) {
  const config = WRITING_TASK_CONFIG[taskType];
  const icon = taskType === "email" ? Mail : MessageCircleMore;
  const description = taskType === "email" ? "邮件写作练习" : "学术讨论写作练习";
  return (
    <PracticeHomeCard
      actionLabel={draft ? "继续练习" : "开始练习"}
      description={description}
      href={config.listHref}
      icon={icon}
      meta={
        loading
          ? "正在加载草稿..."
          : draft
            ? `最近草稿：${draft.displayName}`
            : "暂无草稿"
      }
      secondaryMeta={draft ? `${draft.wordCount} words · 已保存` : undefined}
      title={config.label}
    />
  );
}

function PracticeHomeCard({
  actionLabel,
  description,
  href,
  icon: Icon,
  meta,
  secondaryMeta,
  title
}: {
  actionLabel: string;
  description: string;
  href: string;
  icon: LucideIcon;
  meta: string;
  secondaryMeta?: string;
  title: string;
}) {
  return (
    <article className="flex min-h-[178px] flex-col rounded-2xl border border-student-primary-border bg-white p-4 shadow-[0_4px_18px_rgba(60,47,119,0.055)]">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
          <Icon aria-hidden="true" size={25} strokeWidth={1.9} />
        </span>
        <div>
          <h3 className="text-lg font-bold text-student-primary">{title}</h3>
          <p className="mt-1 text-sm text-student-text">{description}</p>
        </div>
      </div>
      <div className="my-2.5 h-px bg-student-border" />
      <div className="min-h-6 text-sm leading-5 text-student-muted">
        <p>{meta}</p>
        {secondaryMeta ? <p>{secondaryMeta}</p> : null}
      </div>
      <Link
        className="student-button-primary mt-2 min-h-[42px] w-full py-1.5"
        href={href}
        onClick={() => beginStudentNavigationTrace(href)}
      >
        {actionLabel}
        <ArrowRight aria-hidden="true" size={18} />
      </Link>
    </article>
  );
}

function ReadingHomeCard({
  description,
  icon: Icon,
  title
}: {
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <article className="flex min-h-[132px] flex-col rounded-2xl border border-[#d7e6fb] bg-white px-4 py-3 opacity-75">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#edf5ff] text-[#4b8fe8]">
          <Icon aria-hidden="true" size={25} strokeWidth={1.9} />
        </span>
        <div>
          <h3 className="text-lg font-bold text-[#347fdc]">{title}</h3>
          <p className="mt-1 text-sm text-student-text">{description}</p>
        </div>
      </div>
      <button className="mt-auto min-h-9 rounded-[10px] bg-[#edf5ff] text-sm font-semibold text-[#4b8fe8]" disabled type="button">即将上线</button>
    </article>
  );
}

function DashboardSection({
  children,
  title,
  tone = "purple"
}: {
  children: React.ReactNode;
  title: string;
  tone?: "blue" | "purple";
}) {
  return (
    <section className="mt-[18px]">
      <h2 className={`text-lg font-bold ${tone === "blue" ? "text-[#347fdc]" : "text-student-primary"}`}>{title}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

const overviewToneClasses = {
  blue: "bg-blue-50 text-blue-500",
  green: "bg-emerald-50 text-emerald-600",
  orange: "bg-orange-50 text-orange-500",
  purple: "bg-student-primary-soft text-student-primary"
} as const;

function OverviewCard({
  href,
  icon: Icon,
  label,
  tone,
  value
}: {
  href?: string;
  icon: LucideIcon;
  label: string;
  tone: keyof typeof overviewToneClasses;
  value: string;
}) {
  const content = (
    <>
      <span className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${overviewToneClasses[tone]}`}>
        <Icon aria-hidden="true" size={24} />
      </span>
      <div>
        <p className="text-sm font-medium text-student-text">{label}</p>
        <p className="mt-1 text-4xl font-bold leading-none tabular-nums text-student-text">{value}</p>
      </div>
    </>
  );
  const className = "flex min-h-[108px] items-center gap-3.5 rounded-2xl border border-student-border bg-white px-4 py-3";
  return href ? (
    <Link className={`${className} transition hover:-translate-y-px hover:border-student-primary-border`} href={href}>
      {content}
    </Link>
  ) : <div className={className}>{content}</div>;
}

async function loadStudentDashboardSummary(session: StudentCacheSession) {
  return measureStudentRequest("GET /api/student/dashboard-summary", async (captureResponse) => {
    const response = await fetch("/api/student/dashboard-summary", {
      cache: "no-store",
      headers: { Authorization: `Bearer ${session.accessToken}` }
    });
    captureResponse(response);
    const payload = (await response.json()) as StudentDashboardSummary & { error?: string };
    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? "无法加载学生首页概览。");
    }
    return payload;
  });
}
