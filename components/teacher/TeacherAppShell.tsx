"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  ClipboardPenLine,
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
    href: "/teacher/writing/reviews",
    icon: ClipboardPenLine,
    label: "写作批改",
    match: (path: string) => path.startsWith("/teacher/writing/reviews")
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
  title,
  workspace = false
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  crumbs?: TeacherCrumb[];
  subtitle?: string;
  title: string;
  workspace?: boolean;
}) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [headerOverlayOpen, setHeaderOverlayOpen] = useState(false);
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const headerCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { data: teacherEmail } = useTeacherCachedData<string>(
    "teacher:current-user-email",
    loadTeacherEmail
  );

  useEffect(
    () => () => {
      if (headerCloseTimer.current) clearTimeout(headerCloseTimer.current);
      if (sidebarCloseTimer.current) clearTimeout(sidebarCloseTimer.current);
    },
    []
  );

  function showHeaderOverlay() {
    if (headerCloseTimer.current) clearTimeout(headerCloseTimer.current);
    setHeaderOverlayOpen(true);
  }

  function hideHeaderOverlaySoon() {
    if (headerCloseTimer.current) clearTimeout(headerCloseTimer.current);
    headerCloseTimer.current = setTimeout(() => setHeaderOverlayOpen(false), 450);
  }

  function showSidebarOverlay() {
    if (sidebarCloseTimer.current) clearTimeout(sidebarCloseTimer.current);
    setSidebarOverlayOpen(true);
  }

  function hideSidebarOverlaySoon() {
    if (sidebarCloseTimer.current) clearTimeout(sidebarCloseTimer.current);
    sidebarCloseTimer.current = setTimeout(() => setSidebarOverlayOpen(false), 450);
  }

  return (
    <div className={clsx("teacher-shell", workspace ? "h-dvh overflow-hidden" : "min-h-screen")}>
      {workspace ? (
        <div
          aria-hidden="true"
          className="fixed inset-x-0 top-0 z-[80] h-3"
          data-immersive-trigger="header"
          onMouseEnter={showHeaderOverlay}
          onMouseLeave={hideHeaderOverlaySoon}
        />
      ) : null}
      <header
        className={clsx(
          "z-[70] h-[74px] border-b border-student-border bg-white transition-transform duration-200",
          workspace
            ? "fixed inset-x-0 top-0 shadow-[0_8px_24px_rgba(23,32,51,0.12)]"
            : "sticky top-0 z-50",
          workspace && !headerOverlayOpen && "-translate-y-full"
        )}
        data-immersive-overlay={workspace ? "header" : undefined}
        onMouseEnter={workspace ? showHeaderOverlay : undefined}
        onMouseLeave={workspace ? hideHeaderOverlaySoon : undefined}
      >
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

      <div className={clsx("flex", workspace ? "h-dvh" : "min-h-[calc(100vh-74px)]")}>
        {menuOpen ? (
          <button
            aria-label="关闭导航"
            className="fixed inset-0 top-[74px] z-30 bg-student-text/20 lg:hidden"
            onClick={() => setMenuOpen(false)}
            type="button"
          />
        ) : null}
        {workspace ? (
          <div
            aria-hidden="true"
            className="fixed inset-y-0 left-0 z-[65] w-3"
            data-immersive-trigger="sidebar"
            onMouseEnter={showSidebarOverlay}
            onMouseLeave={hideSidebarOverlaySoon}
          />
        ) : null}
        <aside
          className={clsx(
            "fixed bottom-0 left-0 z-[68] w-[252px] border-r border-student-border bg-white px-5 py-7 transition-transform duration-200",
            workspace
              ? "top-0 h-dvh shadow-[8px_0_24px_rgba(23,32,51,0.12)]"
              : "top-[74px] lg:sticky lg:top-[74px] lg:h-[calc(100vh-74px)] lg:translate-x-0",
            workspace
              ? sidebarOverlayOpen
                ? "translate-x-0"
                : "-translate-x-full"
              : menuOpen
                ? "translate-x-0"
                : "-translate-x-full"
          )}
          data-immersive-overlay={workspace ? "sidebar" : undefined}
          onMouseEnter={workspace ? showSidebarOverlay : undefined}
          onMouseLeave={workspace ? hideSidebarOverlaySoon : undefined}
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
          <div className={clsx("teacher-page", workspace && "!max-w-none !gap-0 !p-3")}>
            <header className={clsx("flex flex-wrap items-end justify-between gap-4", workspace && "sr-only")}>
              <div>
                <h1 className="teacher-page-title">{title}</h1>
                {subtitle ? <p className="mt-2 text-base text-student-muted">{subtitle}</p> : null}
              </div>
              {action}
            </header>
            {!workspace && crumbs && crumbs.length > 0 ? <TeacherBreadcrumbs crumbs={crumbs} /> : null}
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
