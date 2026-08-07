"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BookOpen, CalendarDays, Clock3, ClipboardX, Home, Menu, X } from "lucide-react";
import clsx from "clsx";
import { SignOutButton } from "@/components/SignOutButton";
import { STUDENT_ROUTES } from "@/lib/studentNavigation";
import { STUDENT_UI_TEXT } from "@/lib/studentUiText";

const navigation = [
  { href: STUDENT_ROUTES.home, icon: Home, label: "首页", match: (path: string) => path === STUDENT_ROUTES.home },
  { href: STUDENT_ROUTES.wrongQuestions, icon: ClipboardX, label: STUDENT_UI_TEXT.wrongQuestions, match: (path: string) => path.startsWith(STUDENT_ROUTES.wrongQuestions) },
  { href: STUDENT_ROUTES.practiceSets, icon: CalendarDays, label: STUDENT_UI_TEXT.practiceSets, match: (path: string) => path.startsWith(STUDENT_ROUTES.practiceSets) || path.startsWith("/student/practice/") },
  { href: STUDENT_ROUTES.grammarPractice, icon: BookOpen, label: STUDENT_UI_TEXT.grammarPractice, match: (path: string) => path.startsWith(STUDENT_ROUTES.grammarPractice) },
  { href: STUDENT_ROUTES.practiceHistory, icon: Clock3, label: STUDENT_UI_TEXT.practiceHistory, match: (path: string) => path.startsWith(STUDENT_ROUTES.practiceHistory) || path.startsWith("/student/results/") }
];

export function StudentShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="student-shell min-h-screen">
      <header className="sticky top-0 z-40 h-[74px] border-b border-student-border bg-white">
        <div className="flex h-full items-center justify-between gap-4 px-5 sm:px-7">
          <div className="flex items-center gap-3">
            <button
              aria-label={menuOpen ? "关闭导航" : "打开导航"}
              className="student-button-secondary h-10 w-10 p-0 lg:hidden"
              onClick={() => setMenuOpen((open) => !open)}
              type="button"
            >
              {menuOpen ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
            </button>
            <Link className="text-lg font-bold tracking-[-0.015em] text-student-primary" href={STUDENT_ROUTES.home}>
              Build a Sentence
            </Link>
          </div>
          <SignOutButton locale="zh-CN" variant="student" />
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-74px)]">
        {menuOpen ? (
          <button
            aria-label="关闭导航"
            className="fixed inset-0 top-[74px] z-20 bg-student-text/20 lg:hidden"
            onClick={() => setMenuOpen(false)}
            type="button"
          />
        ) : null}
        <aside
          className={clsx(
            "fixed bottom-0 left-0 top-[74px] z-30 w-[196px] border-r border-student-border bg-white px-3 py-5 transition-transform lg:sticky lg:top-[74px] lg:h-[calc(100vh-74px)] lg:translate-x-0",
            menuOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <nav aria-label="学生端主导航" className="grid gap-1.5">
            {navigation.map((item) => {
              const active = item.match(pathname);
              const Icon = item.icon;
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={clsx(
                    "relative flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold transition",
                    active
                      ? "bg-student-primary-soft text-student-primary before:absolute before:-left-3 before:h-7 before:w-[3px] before:rounded-r-full before:bg-student-primary"
                      : "text-student-muted hover:bg-student-bg hover:text-student-text"
                  )}
                  href={item.href}
                  key={item.href}
                  onClick={() => setMenuOpen(false)}
                >
                  <Icon aria-hidden="true" className="shrink-0" size={21} strokeWidth={1.9} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
