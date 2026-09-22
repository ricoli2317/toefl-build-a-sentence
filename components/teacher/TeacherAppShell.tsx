"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  BookOpenCheck,
  ClipboardPenLine,
  ClipboardList,
  CloudUpload,
  FileText,
  Home,
  Menu,
  Network,
  Users,
  X
} from "lucide-react";
import clsx from "clsx";
import { SignOutButton } from "@/components/SignOutButton";
import { StudentBrand } from "@/components/student/StudentBrand";
import { AreaSwitch, useCurrentAccount } from "@/components/RoleGate";

export type TeacherCrumb = { href?: string; label: string };

/**
 * Teacher feature entry points are identical for every ordinary teacher and
 * depend only on `role === teacher`. Binding domains never hide navigation;
 * detailed student data access stays binding-scoped on the pages themselves.
 * Whole-student statistics (套题统计, 阅读统计) are platform-wide reporting and
 * stay with Admin only.
 *
 * Teachers work without a sidebar: the teacher home hosts the three work
 * entries and the student list, so this navigation array is rendered only for
 * Admin (platform management), which keeps its existing IA.
 */
const navigation: Array<{
  href: string;
  icon: import("lucide-react").LucideIcon;
  label: string;
  adminOnly?: boolean;
  teacherOnly?: boolean;
  match: (path: string) => boolean;
}> = [
  {
    href: "/teacher/dashboard",
    icon: Home,
    label: "首页",
    match: (path: string) => path === "/teacher/dashboard"
  },
  {
    href: "/teacher/students",
    icon: Users,
    label: "账号",
    match: (path: string) => path.startsWith("/teacher/students")
  },
  {
    href: "/teacher/sets",
    icon: BarChart3,
    label: "套题统计",
    adminOnly: true,
    match: (path: string) => path.startsWith("/teacher/sets")
  },
  {
    href: "/teacher/reading/statistics",
    icon: BookOpenCheck,
    label: "阅读统计",
    adminOnly: true,
    match: (path: string) => path.startsWith("/teacher/reading")
  },
  {
    href: "/teacher/writing/assignments",
    icon: ClipboardList,
    label: "作业管理",
    teacherOnly: true,
    match: (path: string) => path.startsWith("/teacher/writing/assignments")
  },
  {
    href: "/teacher/writing/reviews",
    icon: ClipboardPenLine,
    label: "写作批改",
    teacherOnly: true,
    match: (path: string) => path.startsWith("/teacher/writing/reviews")
  },
  {
    href: "/teacher/question-bank",
    icon: FileText,
    label: "查看所有套题",
    match: (path: string) => path.startsWith("/teacher/question-bank")
  },
  {
    href: "/admin/student-bindings",
    icon: Network,
    label: "教师绑定",
    adminOnly: true,
    match: (path: string) => path.startsWith("/admin/student-bindings")
  }
];

export function TeacherAppShell({
  action,
  children,
  crumbs,
  subtitle,
  title,
  wide = false,
  workspace = false
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  crumbs?: TeacherCrumb[];
  subtitle?: string;
  title: string;
  wide?: boolean;
  workspace?: boolean;
}) {
  const pathname = usePathname();
  const { displayName, role } = useCurrentAccount();
  // Teachers navigate through the home work entries and pages' own
  // breadcrumbs; Admin keeps the management sidebar exactly as before.
  const showSidebar = role === "admin";
  const [menuOpen, setMenuOpen] = useState(false);
  const [headerOverlayOpen, setHeaderOverlayOpen] = useState(false);
  const [sidebarOverlayOpen, setSidebarOverlayOpen] = useState(false);
  const headerCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    <div
      className={clsx(
        "teacher-shell",
        !showSidebar && "teacher-shell--no-sidebar",
        workspace ? "h-dvh overflow-hidden" : "min-h-screen"
      )}
    >
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
            {showSidebar ? (
              <button
                aria-label={menuOpen ? "关闭导航" : "打开导航"}
                className="teacher-button-secondary h-10 w-10 p-0 lg:hidden"
                onClick={() => setMenuOpen((open) => !open)}
                type="button"
              >
                {menuOpen ? <X aria-hidden="true" size={20} /> : <Menu aria-hidden="true" size={20} />}
              </button>
            ) : null}
            <Link href="/teacher/dashboard"><StudentBrand compact /></Link>
          </div>
          <div className="flex items-center gap-3">
            <AreaSwitch current="teacher" />
            {displayName ? (
              <span className="hidden max-w-[180px] truncate text-sm font-medium text-student-text md:inline">
                {displayName}
              </span>
            ) : null}
            <SignOutButton locale="zh-CN" variant="student" />
            {role === "admin" ? (
              <Link className="teacher-button-primary" href="/teacher/import">
                <CloudUpload aria-hidden="true" size={17} strokeWidth={2} />
                导入 CSV
              </Link>
            ) : null}
          </div>
        </div>
      </header>

      <div className={clsx("flex", workspace ? "h-dvh" : "min-h-[calc(100vh-74px)]")}>
        {showSidebar && menuOpen ? (
          <button
            aria-label="关闭导航"
            className="fixed inset-0 top-[74px] z-30 bg-student-text/20 lg:hidden"
            onClick={() => setMenuOpen(false)}
            type="button"
          />
        ) : null}
        {showSidebar && workspace ? (
          <div
            aria-hidden="true"
            className="fixed inset-y-0 left-0 z-[65] w-3"
            data-immersive-trigger="sidebar"
            onMouseEnter={showSidebarOverlay}
            onMouseLeave={hideSidebarOverlaySoon}
          />
        ) : null}
        {showSidebar ? (
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
            {navigation
              .filter((item) => {
                if (role === "admin") return !item.teacherOnly;
                return !item.adminOnly;
              })
              .map((item) => {
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
        ) : null}

        <main className="min-w-0 flex-1">
          <div className={clsx("teacher-page", wide && "!max-w-none", workspace && "!max-w-none !gap-0 !p-3")}>
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
