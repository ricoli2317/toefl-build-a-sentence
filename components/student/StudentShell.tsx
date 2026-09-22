"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import {
  BookOpen,
  Clock3,
  ClipboardList,
  ClipboardX,
  Home,
  Menu,
  X
} from "lucide-react";
import clsx from "clsx";
import { STUDENT_PRACTICE_ICONS } from "@/components/icons/StudentPracticeIcons";
import { SignOutButton } from "@/components/SignOutButton";
import { StudentBrand } from "@/components/student/StudentBrand";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { beginStudentNavigationTrace } from "@/lib/studentPerformance.client";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import { AreaSwitch, useCurrentAccount } from "@/components/RoleGate";

type NavigationItem = {
  href: string;
  icon: NavigationIcon;
  iconClassName?: string;
  label: string;
  match?: (path: string, searchParams: { get(name: string): string | null }) => boolean;
  tone?: "reading";
};

type NavigationIcon = React.ComponentType<{
  "aria-hidden"?: boolean | "true" | "false";
  className?: string;
  size?: number | string;
  strokeWidth?: number | string;
}>;

const navigationSections: Array<{ items: NavigationItem[]; label?: string; tone?: "reading" | "writing" }> = [
  {
    items: [
      { href: STUDENT_ROUTES.home, icon: Home, label: "首页", match: (path) => path === STUDENT_ROUTES.home }
    ]
  },
  {
    label: "写作练习",
    tone: "writing",
    items: [
      {
        href: STUDENT_ROUTES.buildASentence,
        icon: STUDENT_PRACTICE_ICONS.build_sentence,
        label: "Build a Sentence",
        match: (path) => path.startsWith(STUDENT_ROUTES.buildASentence) || path.startsWith("/student/practice/")
      },
      {
        href: STUDENT_ROUTES.writeEmail,
        icon: STUDENT_PRACTICE_ICONS.email,
        label: "Write an Email",
        match: (path) => path.startsWith(STUDENT_ROUTES.writeEmail)
      },
      {
        href: STUDENT_ROUTES.academicDiscussion,
        icon: STUDENT_PRACTICE_ICONS.academic_discussion,
        label: "Academic Discussion",
        match: (path) => path.startsWith(STUDENT_ROUTES.academicDiscussion)
      }
    ]
  },
  {
    label: "阅读练习",
    tone: "reading",
    items: [
      {
        href: STUDENT_ROUTES.readingCtw,
        icon: STUDENT_PRACTICE_ICONS.ctw,
        label: "Complete the Words",
        match: (path) => path === STUDENT_ROUTES.readingCtw,
        tone: "reading"
      },
      {
        href: STUDENT_ROUTES.readingRdl,
        icon: STUDENT_PRACTICE_ICONS.rdl,
        label: "Read in Daily Life",
        match: (path) => path === STUDENT_ROUTES.readingRdl,
        tone: "reading"
      },
      {
        href: STUDENT_ROUTES.readingRap,
        icon: STUDENT_PRACTICE_ICONS.rap,
        label: "Read an Academic Passage",
        match: (path) => path === STUDENT_ROUTES.readingRap,
        tone: "reading"
      },
      {
        href: STUDENT_ROUTES.readingFullSets,
        icon: STUDENT_PRACTICE_ICONS.full_set,
        label: "Full Set Practice",
        match: (path, searchParams) =>
          path.startsWith(STUDENT_ROUTES.readingFullSets)
          && !isPracticeHistoryResult(path, searchParams),
        tone: "reading"
      }
    ]
  },
  {
    label: "学习",
    items: [
      {
        href: STUDENT_ROUTES.wrongQuestions,
        icon: ClipboardX,
        label: STUDENT_UI_TEXT.wrongQuestions,
        match: (path) => path.startsWith(STUDENT_ROUTES.wrongQuestions)
          || path.startsWith("/student/reading/wrongbook-results/")
      },
      {
        href: STUDENT_ROUTES.grammarPractice,
        icon: BookOpen,
        label: STUDENT_UI_TEXT.grammarPractice,
        match: (path) => path.startsWith(STUDENT_ROUTES.grammarPractice)
      },
      {
        href: STUDENT_ROUTES.practiceHistory,
        icon: Clock3,
        label: STUDENT_UI_TEXT.practiceHistory,
        match: (path, searchParams) =>
          path.startsWith(STUDENT_ROUTES.practiceHistory)
          || isPracticeHistoryResult(path, searchParams)
      },
      {
        href: STUDENT_ROUTES.assignments,
        icon: ClipboardList,
        label: "我的作业",
        match: (path) => path.startsWith(STUDENT_ROUTES.assignments)
      }
    ]
  }
];

export function StudentShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { displayName } = useCurrentAccount();
  const [menuOpen, setMenuOpen] = useState(false);
  const immersive =
    pathname.startsWith("/student/write-email/practice/") ||
    pathname.startsWith("/student/write-email/submission/") ||
    pathname.startsWith("/student/academic-discussion/practice/") ||
    pathname.startsWith("/student/academic-discussion/submission/") ||
    pathname.startsWith("/student/reading/practice/") ||
    /^\/student\/reading\/full-sets\/[^/]+\/attempt\/[^/]+/.test(pathname) ||
    /^\/student\/reading\/full-sets\/[^/]+\/result\/[^/]+\/questions\/[^/]+/.test(pathname) ||
    /^\/student\/reading\/(?:results|wrongbook-results)\/[^/]+\/questions\/[^/]+/.test(pathname) ||
    /^\/student\/wrong-questions\/(?:today|history)\/reading\/practice/.test(pathname) ||
    /^\/student\/assignments\/(?!day(?:\/|$))[^/]+/.test(pathname) ||
    pathname.startsWith("/student/writing-reviews/");

  if (immersive) return <main>{children}</main>;

  return (
    <div className="student-shell min-h-screen bg-white lg:flex">
      {menuOpen ? (
        <button
          aria-label="关闭导航"
          className="fixed inset-0 z-30 bg-student-text/20 lg:hidden"
          onClick={() => setMenuOpen(false)}
          type="button"
        />
      ) : null}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-40 w-[248px] overflow-y-auto border-r border-student-border bg-white px-4 py-5 transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0",
          menuOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex items-start justify-between gap-3 px-3 pb-5">
          <Link
            href={STUDENT_ROUTES.home}
            onClick={() => {
              beginStudentNavigationTrace(STUDENT_ROUTES.home);
              setMenuOpen(false);
            }}
          >
            <StudentBrand />
          </Link>
          <button aria-label="关闭导航" className="p-2 text-student-muted lg:hidden" onClick={() => setMenuOpen(false)} type="button">
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <nav aria-label="学生端主导航" className="grid gap-4">
          {navigationSections.map((section, sectionIndex) => (
            <div className={sectionIndex > 0 ? "border-t border-student-border pt-4" : ""} key={section.label ?? "home"}>
              {section.label ? (
                <p className={clsx(
                  "mb-2 px-3 text-xs font-bold tracking-[0.08em]",
                  section.tone === "reading" ? "text-[#347fdc]" : "text-student-primary"
                )}>{section.label}</p>
              ) : null}
              <div className="grid gap-1">
                {section.items.map((item) => (
                  <StudentNavItem
                    item={item}
                    key={item.label}
                    onNavigate={() => setMenuOpen(false)}
                    pathname={pathname}
                    searchParams={searchParams}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex h-[72px] items-center justify-between border-b border-student-border bg-white/95 px-5 backdrop-blur sm:px-7">
          <div className="flex items-center gap-3 lg:invisible">
            <button aria-label="打开导航" className="student-button-secondary h-10 w-10 p-0" onClick={() => setMenuOpen(true)} type="button">
              <Menu aria-hidden="true" size={20} />
            </button>
            <StudentBrand compact />
          </div>
          <div className="flex items-center gap-2">
            <AreaSwitch current="student" />
            {displayName ? (
              <span className="hidden max-w-[160px] truncate text-sm font-medium text-student-muted sm:inline">
                {displayName}
              </span>
            ) : null}
            <SignOutButton locale="zh-CN" variant="student" />
          </div>
        </header>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}

function StudentNavItem({
  item,
  onNavigate,
  pathname,
  searchParams
}: {
  item: NavigationItem;
  onNavigate: () => void;
  pathname: string;
  searchParams: { get(name: string): string | null };
}) {
  const Icon = item.icon;
  const active = item.match?.(pathname, searchParams) ?? false;
  const className = clsx(
    "relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-semibold transition",
    active
      ? item.tone === "reading"
        ? "bg-blue-50 text-[#347fdc]"
        : "bg-student-primary-soft text-student-primary"
      : "text-student-muted hover:bg-student-bg hover:text-student-text"
  );
  const content = (
    <>
      <Icon aria-hidden="true" className={clsx("shrink-0", item.iconClassName)} size={20} strokeWidth={1.9} />
      <span className="min-w-0 flex-1">{item.label}</span>
    </>
  );

  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={className}
      href={item.href}
      onClick={() => {
        beginStudentNavigationTrace(item.href!);
        onNavigate();
      }}
    >
      {content}
    </Link>
  );
}

function isPracticeHistoryResult(
  path: string,
  searchParams: { get(name: string): string | null }
) {
  const isResult = path.startsWith("/student/results/")
    || path.startsWith("/student/reading/results/")
    || /^\/student\/reading\/full-sets\/[^/]+\/result\/[^/]+/.test(path);
  return isResult && searchParams.get("source")?.startsWith("practice-history") === true;
}
