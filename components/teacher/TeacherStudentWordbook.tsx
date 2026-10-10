"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@/components/RoleGate";
import { TeacherBreadcrumbs } from "./TeacherAppShell";
import { WordbookView, useWordbookRead, type WordbookReadAccess } from "@/components/student/StudentWordbook";
import { WordbookReviewHistoryView } from "@/components/student/WordbookReview";
import { WordbookReviewResult } from "@/components/student/WordbookReviewWorkspace";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { safeTeacherReturnTo, teacherReturnToHref, teacherStudentDetailHref } from "@/lib/teacherNavigation";
import type { WordbookDomain } from "@/lib/lexical/wordbookList";
import type { ReviewState } from "@/lib/lexical/wordbookReview";

type Scope = { studentId: string; displayName: string; domains: WordbookDomain[] };
type Props = { studentId: string; returnTo?: string; domain?: string; view?: "history" | "result"; sessionId?: string };

export function TeacherStudentWordbook(props: Props) {
  const { userId } = useCurrentAccount();
  return <TeacherWordbookScope key={`${userId}:${props.studentId}`} {...props} actorId={userId} />;
}

function TeacherWordbookScope({ actorId, ...props }: Props & { actorId: string }) {
  const token = useRef<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  useEffect(() => {
    const client = createBrowserSupabase(); let current = true;
    const update = (session: { access_token: string; user: { id: string } } | null) => {
      if (!current) return;
      token.current = session?.user.id === actorId ? session.access_token : null;
      setSessionReady(Boolean(token.current));
    };
    void client.auth.getSession().then(({ data }) => update(data.session));
    const { data } = client.auth.onAuthStateChange((_event, session) => update(session));
    return () => { current = false; token.current = null; data.subscription.unsubscribe(); };
  }, [actorId]);
  const getSession = useCallback(() => token.current ? { accessToken: token.current } : null, []);
  const access: WordbookReadAccess = { studentId: props.studentId, sessionReady, getSession, actorId };
  const apiRoot = `/api/teacher/students/${encodeURIComponent(props.studentId)}/wordbook`;
  const scope = useWordbookRead<Scope>(`${apiRoot}/scope`, 0, access);
  return scope.data ? <TeacherWordbookContent key={`${props.view ?? "list"}:${props.domain ?? ""}:${props.sessionId ?? ""}`}
    {...props} access={access} scope={scope.data} apiRoot={apiRoot} /> : <div className="grid gap-4">
    <Link className="teacher-button-secondary justify-self-start" href={safeTeacherReturnTo(props.returnTo, teacherStudentDetailHref(props.studentId))}>返回学生详情</Link>
    {scope.loading ? <p className="text-sm text-student-muted">正在加载生词本权限…</p> : null}
    {scope.error ? <p role="alert" className="text-sm text-student-error">{scope.error}</p> : null}
  </div>;
}

function TeacherWordbookContent({ access, scope, apiRoot, ...props }: Props & { access: WordbookReadAccess; scope: Scope; apiRoot: string }) {
  const domain = (props.domain ?? scope.domains[0]) as WordbookDomain;
  const studentHref = safeTeacherReturnTo(props.returnTo, teacherStudentDetailHref(props.studentId));
  const root = teacherReturnToHref(`${teacherStudentDetailHref(props.studentId)}/wordbook`, studentHref);
  const historyHref = (subject: WordbookDomain) => teacherReturnToHref(`${teacherStudentDetailHref(props.studentId)}/wordbook/review/history?domain=${subject}`, studentHref);
  const navigation = <div className="grid gap-3"><TeacherBreadcrumbs crumbs={[
    { label: "教师首页", href: "/teacher/dashboard" }, { label: scope.displayName, href: studentHref },
    { label: "生词本", ...(props.view ? { href: root } : {}) },
    ...(props.view ? [{ label: "复习历史", ...(props.view === "result" ? { href: historyHref(domain) } : {}) }] : []),
    ...(props.view === "result" ? [{ label: "历史结果" }] : [])
  ]} /><Link className="teacher-button-secondary justify-self-start" href={props.view === "result" ? historyHref(domain) : props.view ? root : studentHref}>
    {props.view === "result" ? "返回复习历史" : props.view ? "返回生词本" : "返回学生详情"}</Link></div>;
  if (!scope.domains.includes(domain)) return <div className="grid gap-4">{navigation}<p role="alert" className="text-sm text-student-error">无权查看该学科的生词本。</p></div>;
  if (!props.view) return <WordbookView access={access} apiRoot={apiRoot} readOnly domains={scope.domains} navigation={navigation} historyHref={historyHref} />;
  return <div className="grid min-w-0 gap-5">{navigation}
    {props.view === "history" ? <WordbookReviewHistoryView access={access} apiRoot={`${apiRoot}/review`} domains={scope.domains} initialDomain={domain} readOnly
      resultHref={(id, subject) => teacherReturnToHref(`${teacherStudentDetailHref(props.studentId)}/wordbook/review/${id}?domain=${subject}`, studentHref)} />
      : <TeacherWordbookResult access={access} url={`${apiRoot}/review/${encodeURIComponent(props.sessionId ?? "")}?domain=${domain}`} />}
  </div>;
}

function ReadStatus({ loading, error, retry }: { loading: boolean; error?: string; retry: () => void }) {
  return <>{loading ? <p className="text-sm text-student-muted">正在加载复习记录…</p> : null}
    {error ? <div role="alert" className="grid gap-2 text-sm text-student-error"><p>{error}</p><button type="button" className="student-button-secondary justify-self-start" onClick={retry}>重试</button></div> : null}</>;
}

function TeacherWordbookResult({ access, url }: { access: WordbookReadAccess; url: string }) {
  const [revision, setRevision] = useState(0);
  const result = useWordbookRead<ReviewState>(url, revision, access);
  return <><ReadStatus {...result} retry={() => setRevision(value => value + 1)} />
    {result.data ? <section className={`student-card mx-auto grid w-full max-w-3xl gap-6 p-6 ${result.data.session.domain === "reading" ? "reading-theme" : ""}`}>
      <p className="text-sm text-student-muted">{result.data.session.status === "completed" ? "已完成" : "未完成 · 仅展示已保存记录"} · 进度 {result.data.session.answered}/{result.data.session.total}</p>
      <WordbookReviewResult state={result.data} readOnly />
    </section> : null}</>;
}
