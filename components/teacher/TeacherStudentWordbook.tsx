"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@/components/RoleGate";
import { TeacherBreadcrumbs } from "./TeacherAppShell";
import { WordbookView, useWordbookRead, type WordbookReadAccess } from "@/components/student/StudentWordbook";
import { WordbookReviewHistoryList } from "@/components/student/WordbookReview";
import { WordbookReviewResult } from "@/components/student/WordbookReviewWorkspace";
import { createBrowserSupabase } from "@/lib/supabase/client";
import { safeTeacherReturnTo, teacherReturnToHref, teacherStudentDetailHref } from "@/lib/teacherNavigation";
import type { WordbookDomain } from "@/lib/lexical/wordbookList";
import type { ReviewHistory, ReviewState } from "@/lib/lexical/wordbookReview";

type Scope = { studentId: string; displayName: string; domains: WordbookDomain[] };
type Props = { studentId: string; returnTo?: string; domain?: string; view?: "history" | "result"; sessionId?: string };

export function TeacherStudentWordbook(props: Props) {
  const { userId } = useCurrentAccount();
  return <TeacherWordbookScope key={`${userId}:${props.studentId}`} {...props} actorId={userId} />;
}

function TeacherWordbookScope({ actorId, ...props }: Props & { actorId: string }) {
  const token = useRef<string | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const client = createBrowserSupabase(); let current = true;
    const update = (session: { access_token: string; user: { id: string } } | null) => {
      if (!current) return;
      token.current = session?.user.id === actorId ? session.access_token : null;
      setSessionReady(true); setRevision(value => value + 1);
    };
    void client.auth.getSession().then(({ data }) => update(data.session));
    const { data } = client.auth.onAuthStateChange((_event, session) => update(session));
    return () => { current = false; token.current = null; data.subscription.unsubscribe(); };
  }, [actorId]);
  const getSession = useCallback(() => token.current ? { accessToken: token.current } : null, []);
  const access: WordbookReadAccess = { studentId: props.studentId, sessionReady, getSession };
  const apiRoot = `/api/teacher/students/${encodeURIComponent(props.studentId)}/wordbook`;
  const scope = useWordbookRead<Scope>(`${apiRoot}/scope`, revision, access);
  return scope.data ? <TeacherWordbookContent key={`${revision}:${props.view ?? "list"}:${props.domain ?? ""}:${props.sessionId ?? ""}`}
    {...props} access={access} scope={scope.data} apiRoot={apiRoot} /> : <div className="grid gap-4">
    <Link className="teacher-button-secondary justify-self-start" href={safeTeacherReturnTo(props.returnTo, teacherStudentDetailHref(props.studentId))}>返回学生详情</Link>
    {scope.loading ? <p className="text-sm text-student-muted">正在加载生词本权限…</p> : null}
    {scope.error ? <p role="alert" className="text-sm text-student-error">{scope.error}</p> : null}
  </div>;
}

function TeacherWordbookContent({ access, scope, apiRoot, ...props }: Props & { access: WordbookReadAccess; scope: Scope; apiRoot: string }) {
  const [domain, setDomain] = useState<WordbookDomain>((props.domain ?? scope.domains[0]) as WordbookDomain);
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
    {props.view === "history" ? <>
      {scope.domains.length > 1 ? <div role="tablist" aria-label="复习历史分类" className={`flex gap-1 border-b border-student-border ${domain === "reading" ? "reading-theme" : ""}`}>
        {scope.domains.map(subject => <button type="button" role="tab" aria-selected={domain === subject} key={subject}
          className={`border-b-2 px-5 py-3 text-sm font-semibold ${domain === subject ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
          onClick={() => setDomain(subject)}>{subject === "reading" ? "Reading" : "Writing"}</button>)}
      </div> : null}
      <TeacherWordbookHistory key={domain} access={access} apiRoot={apiRoot} domain={domain}
        resultHref={id => teacherReturnToHref(`${teacherStudentDetailHref(props.studentId)}/wordbook/review/${id}?domain=${domain}`, studentHref)} />
    </> : <TeacherWordbookResult access={access} url={`${apiRoot}/review/${encodeURIComponent(props.sessionId ?? "")}?domain=${domain}`} />}
  </div>;
}

function ReadStatus({ loading, error, retry }: { loading: boolean; error?: string; retry: () => void }) {
  return <>{loading ? <p className="text-sm text-student-muted">正在加载复习记录…</p> : null}
    {error ? <div role="alert" className="grid gap-2 text-sm text-student-error"><p>{error}</p><button type="button" className="student-button-secondary justify-self-start" onClick={retry}>重试</button></div> : null}</>;
}

function TeacherWordbookHistory({ access, apiRoot, domain, resultHref }: {
  access: WordbookReadAccess; apiRoot: string; domain: WordbookDomain; resultHref: (id: string) => string;
}) {
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const history = useWordbookRead<ReviewHistory>(`${apiRoot}/review/history?domain=${domain}&page=${page}`, revision, access);
  const pages = Math.max(1, Math.ceil((history.data?.total ?? 0) / 10));
  return <><ReadStatus {...history} retry={() => setRevision(value => value + 1)} />
    {history.data ? <><WordbookReviewHistoryList history={history.data} readOnly resultHref={resultHref} />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-student-muted"><span>共 {history.data.total} 条 · 第 {page} / {pages} 页</span>
        <div className="flex gap-2"><button type="button" className="student-button-secondary" disabled={page <= 1 || history.loading} onClick={() => setPage(value => value - 1)}>上一页</button>
          <button type="button" className="student-button-secondary" disabled={page >= pages || history.loading} onClick={() => setPage(value => value + 1)}>下一页</button></div></div>
    </> : null}</>;
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
