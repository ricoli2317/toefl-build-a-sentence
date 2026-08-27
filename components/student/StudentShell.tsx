"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BookOpen,
  BookText,
  Clock3,
  ClipboardList,
  ClipboardX,
  FileText,
  Home,
  Mail,
  Menu,
  MessageCircleMore,
  Puzzle,
  X,
  type LucideIcon
} from "lucide-react";
import clsx from "clsx";
import { SignOutButton } from "@/components/SignOutButton";
import { StudentBrand } from "@/components/student/StudentBrand";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { beginStudentNavigationTrace } from "@/lib/studentPerformance.client";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";
import { AdminAreaSwitch } from "@/components/RoleGate";

type NavigationItem = {
  disabled?: boolean;
  href?: string;
  icon: LucideIcon;
  label: string;
  match?: (path: string) => boolean;
};

const navigationSections: Array<{ items: NavigationItem[]; label?: string }> = [
  {
    items: [
      { href: STUDENT_ROUTES.home, icon: Home, label: "首页", match: (path) => path === STUDENT_ROUTES.home }
    ]
  },
  {
    label: "写作练习",
    items: [
      {
        href: STUDENT_ROUTES.buildASentence,
        icon: Puzzle,
        label: "Build a Sentence",
        match: (path) => path.startsWith(STUDENT_ROUTES.buildASentence) || path.startsWith("/student/practice/")
      },
      {
        href: STUDENT_ROUTES.writeEmail,
        icon: Mail,
        label: "Write an Email",
        match: (path) => path.startsWith(STUDENT_ROUTES.writeEmail)
      },
      {
        href: STUDENT_ROUTES.academicDiscussion,
        icon: MessageCircleMore,
        label: "Academic Discussion",
        match: (path) => path.startsWith(STUDENT_ROUTES.academicDiscussion)
      }
    ]
  },
  {
    label: "阅读练习",
    items: [
      { disabled: true, icon: BookText, label: "Complete the Words" },
      { disabled: true, icon: FileText, label: "Read in Daily Life" },
      { disabled: true, icon: BookOpen, label: "Read an Academic Passage" }
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
      },
      {
        href: STUDENT_ROUTES.practiceHistory,
        icon: Clock3,
        label: STUDENT_UI_TEXT.practiceHistory,
        match: (path) => path.startsWith(STUDENT_ROUTES.practiceHistory) || path.startsWith("/student/results/")
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
  const [menuOpen, setMenuOpen] = useState(false);
  const immersive =
    pathname.startsWith("/student/write-email/practice/") ||
    pathname.startsWith("/student/write-email/submission/") ||
    pathname.startsWith("/student/academic-discussion/practice/") ||
    pathname.startsWith("/student/academic-discussion/submission/") ||
    /^\/student\/assignments\/[^/]+/.test(pathname) ||
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
              {section.label ? <p className="mb-2 px-3 text-xs font-bold tracking-[0.08em] text-student-primary">{section.label}</p> : null}
              <div className="grid gap-1">
                {section.items.map((item) => (
                  <StudentNavItem item={item} key={item.label} onNavigate={() => setMenuOpen(false)} pathname={pathname} />
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
            <AdminAreaSwitch current="student" />
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
  pathname
}: {
  item: NavigationItem;
  onNavigate: () => void;
  pathname: string;
}) {
  const Icon = item.icon;
  const active = item.match?.(pathname) ?? false;
  const className = clsx(
    "relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-[13px] font-semibold transition",
    active
      ? "bg-student-primary-soft text-student-primary"
      : item.disabled
        ? "cursor-not-allowed text-student-muted/55"
        : "text-student-muted hover:bg-student-bg hover:text-student-text"
  );
  const content = (
    <>
      <Icon aria-hidden="true" className="shrink-0" size={20} strokeWidth={1.9} />
      <span className="min-w-0 flex-1">{item.label}</span>
      {item.disabled ? <span className="text-[9px] font-semibold">即将上线</span> : null}
    </>
  );

  return item.href ? (
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
  ) : (
    <span aria-disabled="true" className={className}>{content}</span>
  );
}
