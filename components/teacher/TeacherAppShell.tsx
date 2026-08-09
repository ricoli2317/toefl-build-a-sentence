"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  CloudUpload,
  FileText,
  Home,
  Menu,
  Users,
  X
} from "lucide-react";
import clsx from "clsx";
import { SignOutButton } from "@/components/SignOutButton";
import { useTeacherCachedData } from "@/components/TeacherDataCache";
import { createBrowserSupabase } from "@/lib/supabase/client";

export type TeacherCrumb = { href?: string; label: string };

const navigation = [
  {
    href: "/teacher/dashboard",
    icon: Home,
    label: "首页",
    match: (path: string) => path === "/teacher/dashboard"
  },
  {
    href: "/teacher/students",
    icon: Users,
    label: "学生",
    match: (path: string) => path.startsWith("/teacher/students")
  },
  {
    href: "/teacher/sets",
    icon: BarChart3,
    label: "套题统计",
    match: (path: string) => path.startsWith("/teacher/sets")
  },
  {
    href: "/teacher/question-bank",
    icon: FileText,
    label: "查看所有套题",
    match: (path: string) => path.startsWith("/teacher/question-bank")
  }
];

export function TeacherAppShell({
  action,
  children,
  crumbs,
  subtitle,
  title
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  crumbs?: TeacherCrumb[];
  subtitle?: string;
  title: string;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const { data: teacherEmail } = useTeacherCachedData<string>(
    "teacher:current-user-email",
    loadTeacherEmail
  );

  return (
    <div className="teacher-shell min-h-screen">
      <header className="sticky top-0 z-50 h-[74px] border-b border-student-border bg-white">
        <div className="flex h-full items-center justify-between gap-4 px-5 sm:px-7 lg:px-8">
          <div className="flex items-center gap-3">
            <button
              aria-label={menuOpen ? "关闭导航" : "打开导航"}
              className="teacher-button-secondary h-10 w-10 p-0 lg:hidden"
              onClick={() => setMenuOpen((open) => !open)}
              type="button"
            >
              {menuOpen ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
            </button>
            <Link
              className="text-[19px] font-bold tracking-[-0.015em] text-student-primary"
              href="/teacher/dashboard"
            >
              Build a Sentence
            </Link>
          </div>
          <div className="flex items-center gap-3">
            {teacherEmail ? (
              <span className="hidden text-sm font-medium text-student-text md:inline">
                {teacherEmail}
              </span>
            ) : null}
            <SignOutButton locale="zh-CN" showIdentity={false} variant="student" />
            <Link className="teacher-button-primary" href="/teacher/import">
              <CloudUpload aria-hidden="true" size={17} strokeWidth={2} />
              导入 CSV
            </Link>
          </div>
        </div>
      </header>

      <div className="flex min-h-[calc(100vh-74px)]">
        {menuOpen ? (
          <button
            aria-label="关闭导航"
            className="fixed inset-0 top-[74px] z-30 bg-student-text/20 lg:hidden"
            onClick={() => setMenuOpen(false)}
            type="button"
          />
        ) : null}
        <aside
          className={clsx(
            "fixed bottom-0 left-0 top-[74px] z-40 w-[252px] border-r border-student-border bg-white px-5 py-7 transition-transform lg:sticky lg:top-[74px] lg:h-[calc(100vh-74px)] lg:translate-x-0",
            menuOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <nav aria-label="教师端主导航" className="grid gap-2">
            {navigation.map((item) => {
              const active = item.match(pathname);
              const Icon = item.icon;
              return (
                <Link
                  aria-current={active ? "page" : undefined}
                  className={clsx(
                    "flex min-h-[56px] items-center gap-4 rounded-xl px-5 text-[15px] font-semibold transition",
                    active
                      ? "bg-student-primary-soft text-student-primary"
                      : "text-student-text hover:bg-student-bg hover:text-student-primary"
                  )}
                  href={item.href}
                  key={item.href}
                  onClick={() => setMenuOpen(false)}
                >
                  <Icon aria-hidden="true" size={22} strokeWidth={1.9} />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">
          <div className="teacher-page">
            <header className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="teacher-page-title">{title}</h1>
                {subtitle ? <p className="mt-2 text-base text-student-muted">{subtitle}</p> : null}
              </div>
              {action}
            </header>
            {crumbs && crumbs.length > 0 ? <TeacherBreadcrumbs crumbs={crumbs} /> : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export function TeacherBreadcrumbs({ crumbs }: { crumbs: TeacherCrumb[] }) {
  return (
    <nav aria-label="页面路径" className="text-sm text-student-muted">
      <ol className="flex flex-wrap items-center gap-2.5">
        {crumbs.map((crumb, index) => (
          <li className="flex items-center gap-2.5" key={`${crumb.label}-${index}`}>
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.href ? (
              <Link className="font-semibold text-student-primary hover:underline" href={crumb.href}>
                {crumb.label}
              </Link>
            ) : (
              <span className="font-medium text-student-muted">{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

async function loadTeacherEmail() {
  const supabase = createBrowserSupabase();
  const {
    data: { user }
  } = await supabase.auth.getUser();
  return user?.email ?? "";
}
