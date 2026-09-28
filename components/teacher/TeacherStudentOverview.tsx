"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, UserRound } from "lucide-react";
import {
  TEACHER_STUDENT_OVERVIEW_CACHE_KEY,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherCard,
  TeacherDataError,
  TeacherEmptyState,
  TeacherLoadingRegion,
  TeacherSectionTitle,
  TeacherSkeleton,
  TeacherTextLink
} from "@/components/teacher/TeacherUI";
import { InlineStudentNameEditor } from "@/components/shared/InlineStudentNameEditor";
import { PasswordResetApprovalPrompt } from "@/components/shared/PasswordResetApprovalPrompt";
import { TeacherStudentHeaderActions } from "@/components/teacher/TeacherStudentHeaderActions";
import { TeacherClassList } from "@/components/teacher/TeacherClassList";
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  teacherQueryUrl,
  teacherReturnToHref,
  TEACHER_HOME_HREF
} from "@/lib/teacherNavigation";
import {
  compareStudentSearchGroups,
  compareStudentSearchMetadata,
  createStudentSearchMetadata,
  studentSearchRank,
  type StudentSearchMetadata
} from "@/lib/studentSearch";
import type { StudentBindingDomain } from "@/lib/studentBindings";
import { STUDENT_BINDING_DOMAINS } from "@/lib/studentBindings";
import { SubjectBindingBadges } from "@/components/teacher/SubjectBadges";
import {
  addStudentBindingDomains,
  removeStudentBindingDomain
} from "@/lib/teacherStudentBindingClient";
import {
  formatLatestPracticeAt,
  formatPracticeDuration,
  type TeacherStudentOverviewEntry
} from "@/lib/teacherStudentOverview";

type StudentOverviewResponse = { students: TeacherStudentOverviewEntry[] };

type StudentSearchEntry = StudentSearchMetadata & {
  student: TeacherStudentOverviewEntry;
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

/**
 * Lightweight student overview. It only renders the shared practice summary
 * (总时间 / 最近练习) and never loads accuracy, writing scores, or question
 * details; those stay on the domain-scoped student detail pages.
 *
 * With `showClassTabs` the same card gains the 学生列表 | 班级列表 tabs used
 * by the teacher home; the student tab keeps its existing behavior unchanged.
 */
export function TeacherStudentOverviewList({
  initialTab = "students",
  showManageActions = false,
  showClassTabs = false,
  studentReturnTo = TEACHER_HOME_HREF
}: {
  initialTab?: "students" | "classes";
  showManageActions?: boolean;
  showClassTabs?: boolean;
  studentReturnTo?: string;
} = {}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [classQuery, setClassQuery] = useState("");
  const [activeTab, setActiveTab] = useState<"students" | "classes">(
    initialTab === "classes" ? "classes" : "students"
  );
  const classMode = showClassTabs && activeTab === "classes";

  useEffect(() => {
    setActiveTab(initialTab === "classes" ? "classes" : "students");
  }, [initialTab]);

  function selectTab(nextTab: "students" | "classes") {
    setActiveTab(nextTab);
    if (!showClassTabs) return;
    // Keep 首页?tab=classes in the URL so the breadcrumb and the browser Back
    // button both restore the class list tab.
    router.replace(
      teacherQueryUrl({ tab: nextTab === "classes" ? "classes" : null }),
      { scroll: false }
    );
  }

  const sectionRefs = useRef(new Map<string, HTMLTableRowElement>());
  const cache = useTeacherDataCache();
  const { data, error, loading } = useTeacherCachedData<StudentOverviewResponse>(
    TEACHER_STUDENT_OVERVIEW_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/students/overview")
  );

  const entries = (data?.students ?? []).map(createStudentSearchEntry);
  const filtered = filterStudentEntries(entries, query);
  const sections = groupStudentEntries(filtered);
  const availableLetters = new Set(sections.map(([letter]) => letter));

  /**
   * 授课科目 quick edit. It mutates exactly the current teacher's binding for
   * this student and then patches the loaded overview row in place. The
   * invalidation is published first (so stats/dashboard/reading surfaces
   * refetch) and the row is re-seeded right after, which keeps the list from
   * flashing back into a loading state.
   */
  async function addStudentDomain(studentId: string, domain: StudentBindingDomain) {
    await addStudentBindingDomains(studentId, [domain]);
    patchStudentDomains(studentId, (current) => [...current, domain]);
  }

  async function removeStudentDomain(studentId: string, domain: StudentBindingDomain) {
    await removeStudentBindingDomain(studentId, domain);
    patchStudentDomains(studentId, (current) => current.filter((item) => item !== domain));
  }

  function patchStudentDomains(
    studentId: string,
    mutate: (current: StudentBindingDomain[]) => StudentBindingDomain[]
  ) {
    const entry = cache.getEntry(TEACHER_STUDENT_OVERVIEW_CACHE_KEY);
    const latest =
      entry?.status === "success" || entry?.status === "refreshing"
        ? (entry.data as StudentOverviewResponse)
        : null;
    const nextStudents = latest
      ? latest.students
          .map((student) =>
            student.studentId === studentId
              ? {
                  ...student,
                  domains: STUDENT_BINDING_DOMAINS.filter((domain) =>
                    mutate(student.domains).includes(domain)
                  )
                }
              : student
          )
          // A student with no remaining binding leaves this teacher's scope.
          .filter((student) => student.domains.length > 0)
      : null;

    publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED", studentId });

    if (latest && nextStudents) {
      cache.set<StudentOverviewResponse>(TEACHER_STUDENT_OVERVIEW_CACHE_KEY, {
        ...latest,
        students: nextStudents
      });
    }
  }

  async function renameStudent(studentId: string, fullName: string) {
    const result = await teacherApiFetch<{ student?: { displayName?: string } }>(
      `/api/teacher/students/${encodeURIComponent(studentId)}`,
      { method: "PATCH", body: JSON.stringify({ fullName }) }
    );
    // Names feed search metadata, sorting, and surname-letter grouping, so the
    // overview cache must be regenerated instead of patching the row in place.
    cache.invalidate(TEACHER_STUDENT_OVERVIEW_CACHE_KEY);
    publishCacheInvalidation({ type: "TEACHER_BINDING_UPDATED" });
    return result.student?.displayName ?? fullName;
  }

  /**
   * Approve/reject only changes one request id on one row, so the cached list
   * is patched in place. Reading the latest cache entry at click time plus the
   * cache generation guard means an in-flight stale response can never
   * resurrect the resolved request or overwrite the new state.
   */
  function handleResetRequestResolved(studentId: string) {
    const entry = cache.getEntry(TEACHER_STUDENT_OVERVIEW_CACHE_KEY);
    const latest =
      entry?.status === "success" || entry?.status === "refreshing"
        ? (entry.data as StudentOverviewResponse)
        : null;
    if (!latest) return;
    cache.set<StudentOverviewResponse>(TEACHER_STUDENT_OVERVIEW_CACHE_KEY, {
      ...latest,
      students: latest.students.map((student) =>
        student.studentId === studentId
          ? { ...student, passwordResetRequestId: null }
          : student
      )
    });
  }

  return (
    <div className="grid gap-6">
      {!classMode && loading ? <TeacherLoadingRegion label="正在加载学生列表" /> : null}
      <TeacherCard className="p-0">
        <div className="px-6 pt-6">
          {showClassTabs ? (
            <nav aria-label="列表类型" className="flex gap-2 border-b border-student-border">
              <button
                className={`border-b-2 px-5 py-3 text-sm font-bold ${activeTab === "students" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
                onClick={() => selectTab("students")}
                type="button"
              >
                学生列表
              </button>
              <button
                className={`border-b-2 px-5 py-3 text-sm font-bold ${activeTab === "classes" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
                onClick={() => selectTab("classes")}
                type="button"
              >
                班级列表
              </button>
            </nav>
          ) : (
            <TeacherSectionTitle>学生列表</TeacherSectionTitle>
          )}
        </div>
        <div className="px-6 pt-4">
          <div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-4">
            <div className="w-full max-w-[560px]">
              {classMode ? (
                <label className="relative block">
                  <Search
                    aria-hidden="true"
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-student-muted"
                    size={20}
                    strokeWidth={1.9}
                  />
                  <input
                    className="h-12 w-full rounded-xl border border-student-border bg-white pl-12 pr-4 text-sm text-student-text placeholder:text-student-muted focus:border-student-primary"
                    onChange={(event) => setClassQuery(event.target.value)}
                    placeholder="搜索班级名称"
                    type="search"
                    value={classQuery}
                  />
                </label>
              ) : (
                <label className="relative block">
                  <Search
                    aria-hidden="true"
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-student-muted"
                    size={20}
                    strokeWidth={1.9}
                  />
                  <input
                    className="h-12 w-full rounded-xl border border-student-border bg-white pl-12 pr-4 text-sm text-student-text placeholder:text-student-muted focus:border-student-primary"
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索学生姓名 / 拼音"
                    type="search"
                    value={query}
                  />
                </label>
              )}
              <p className="mt-3 text-sm text-student-muted">
                {classMode
                  ? "输入班级名称即可筛选。"
                  : "支持中文精确搜索，例如：张三；支持拼音模糊搜索，例如：zhang / san"}
              </p>
            </div>
            <div className="flex flex-col items-end gap-3">
              {showManageActions ? (
                <TeacherStudentHeaderActions showClassAction={showClassTabs} />
              ) : null}
              <p className="text-sm font-medium text-student-text">按姓氏首字母排序</p>
            </div>
          </div>
        </div>

        <div className="flex">
          <div className="min-w-0 flex-1">
          {classMode ? (
            <TeacherClassList query={classQuery} />
          ) : loading ? (
            <StudentTableSkeleton />
          ) : error ? (
            <StudentTableError text={toStudentOverviewErrorMessage(error)} />
          ) : filtered.length === 0 ? (
            <div className="px-6 pb-6 pt-4">
              <TeacherEmptyState text={query.trim() ? "没有找到匹配的学生。" : "暂无学生。"} />
            </div>
          ) : (
            <div className="overflow-x-auto px-6 pb-6 pt-4">
              <table className="w-full min-w-[860px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-student-border text-student-muted">
                    <th className="px-3 py-3 font-medium">学生</th>
                    <th className="px-3 py-3 font-medium">授课科目</th>
                    <th className="px-3 py-3 font-medium">练习总时间</th>
                    <th className="px-3 py-3 font-medium">最近练习</th>
                    <th className="w-px whitespace-nowrap px-3 py-3 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sections.flatMap(([letter, students]) => [
                    <tr
                      className="scroll-mt-28"
                      id={`student-letter-${letter}`}
                      key={`group-${letter}`}
                      ref={(node) => {
                        if (node) sectionRefs.current.set(letter, node);
                        else sectionRefs.current.delete(letter);
                      }}
                    >
                      <td className="bg-student-primary-soft px-3 py-2 font-bold text-student-primary" colSpan={5}>
                        {letter}
                      </td>
                    </tr>,
                    ...students.map((entry) => (
                      <tr
                        className="border-b border-student-border transition last:border-b-0 hover:bg-student-primary-soft/45"
                        key={entry.student.studentId}
                      >
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-student-primary-soft text-student-primary">
                              <UserRound aria-hidden="true" size={20} strokeWidth={1.9} />
                            </span>
                            <InlineStudentNameEditor
                              displayName={entry.student.studentDisplayName}
                              onSave={(fullName) =>
                                renameStudent(entry.student.studentId, fullName)
                              }
                              renderName={(name) => (
                                <TeacherTextLink
                                  href={teacherReturnToHref(
                                    `/teacher/students/${encodeURIComponent(entry.student.studentId)}`,
                                    studentReturnTo
                                  )}
                                >
                                  {name}
                                </TeacherTextLink>
                              )}
                            />
                            {entry.student.passwordResetRequestId ? (
                              <PasswordResetApprovalPrompt
                                endpoint={`/api/teacher/password-reset-requests/${encodeURIComponent(entry.student.passwordResetRequestId)}/resolve`}
                                onResolved={() => handleResetRequestResolved(entry.student.studentId)}
                                prompt="是否允许学生重置密码？"
                              />
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <SubjectBindingBadges
                            actionFallback="授课科目更新失败，请稍后重试。"
                            domains={entry.student.domains}
                            lastRemovalWarning="取消后该学生将不再出现在你的学生列表中，可通过「绑定学生」重新添加。"
                            onAddDomain={(domain) =>
                              addStudentDomain(entry.student.studentId, domain)
                            }
                            onRemoveDomain={(domain) =>
                              removeStudentDomain(entry.student.studentId, domain)
                            }
                            removeSubjectLabel="该学生"
                          />
                        </td>
                        <td className="px-3 py-3 tabular-nums text-student-text">
                          {formatPracticeDuration(entry.student.totalPracticeSeconds)}
                        </td>
                        <td className="px-3 py-3 tabular-nums text-student-text">
                          {formatLatestPracticeAt(entry.student.latestPracticeAt)}
                        </td>
                        <td className="w-px whitespace-nowrap px-3 py-3 text-right">
                          <div className="flex flex-nowrap items-center justify-end gap-2">
                            <Link
                              className="teacher-button-secondary"
                              href={`/teacher/writing/assignments?studentId=${encodeURIComponent(entry.student.studentId)}`}
                            >
                              作业管理
                            </Link>
                            <Link
                              className="teacher-button-secondary"
                              href={teacherReturnToHref(
                                `/teacher/students/${encodeURIComponent(entry.student.studentId)}`,
                                studentReturnTo
                              )}
                            >
                              查看详情
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))
                  ])}
                </tbody>
              </table>
            </div>
          )}
          </div>

          <nav aria-label="学生姓氏首字母索引" className="sticky top-[96px] hidden w-7 shrink-0 flex-col items-center gap-0.5 self-start pr-6 pt-4 xl:flex">
          {ALPHABET.map((letter) => {
            // In 班级列表 the index stays in place but is fully disabled, so the
            // card layout never shifts between tabs.
            const available = !classMode && availableLetters.has(letter);
            return (
              <button
                aria-label={`跳转到 ${letter} 组`}
                className={`h-[22px] w-7 rounded-md text-[11px] font-semibold transition ${
                  available
                    ? "text-student-primary hover:bg-student-primary hover:text-white"
                    : "cursor-default text-student-muted/35"
                }`}
                disabled={!available}
                key={letter}
                onClick={() => sectionRefs.current.get(letter)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                type="button"
              >
                {letter}
              </button>
            );
          })}
          </nav>
        </div>
      </TeacherCard>
    </div>
  );
}

function createStudentSearchEntry(student: TeacherStudentOverviewEntry): StudentSearchEntry {
  const displayName = student.studentDisplayName.trim();
  return {
    ...createStudentSearchMetadata(displayName),
    student
  };
}

function filterStudentEntries(entries: StudentSearchEntry[], query: string) {
  const sorted = [...entries].sort(compareStudentEntries);
  if (!query.trim()) return sorted;

  return sorted
    .map((entry) => ({
      entry,
      rank: studentSearchRank(entry, entry.student.studentDisplayName, query)
    }))
    .filter((item) => Number.isFinite(item.rank))
    .sort((left, right) => left.rank - right.rank || compareStudentEntries(left.entry, right.entry))
    .map((item) => item.entry);
}

function groupStudentEntries(entries: StudentSearchEntry[]) {
  const groups = new Map<string, StudentSearchEntry[]>();
  for (const entry of entries) {
    groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry]);
  }
  return Array.from(groups.entries()).sort(([left], [right]) => compareStudentSearchGroups(left, right));
}

function compareStudentEntries(left: StudentSearchEntry, right: StudentSearchEntry) {
  return compareStudentSearchMetadata(
    { ...left, displayName: left.student.studentDisplayName, id: left.student.studentId },
    { ...right, displayName: right.student.studentDisplayName, id: right.student.studentId }
  );
}

function StudentTableSkeleton() {
  return (
    <div className="overflow-x-auto px-6 pb-6 pt-4">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-student-border text-student-muted">
            <th className="px-3 py-3 font-medium">学生</th>
            <th className="px-3 py-3 font-medium">授课科目</th>
            <th className="px-3 py-3 font-medium">练习总时间</th>
            <th className="px-3 py-3 font-medium">最近练习</th>
            <th className="px-3 py-3 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }, (_, index) => (
            <tr className="border-b border-student-border" key={index}>
              <td className="px-3 py-3"><TeacherSkeleton className="h-10 w-40" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-5 w-16" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-5 w-16" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-5 w-24" /></td>
              <td className="px-3 py-3"><TeacherSkeleton className="h-9 w-40" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StudentTableError({ text }: { text: string }) {
  return (
    <div className="overflow-x-auto px-6 pb-6 pt-4">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-student-border text-student-muted">
            <th className="px-3 py-3 font-medium">学生</th>
            <th className="px-3 py-3 font-medium">授课科目</th>
            <th className="px-3 py-3 font-medium">练习总时间</th>
            <th className="px-3 py-3 font-medium">最近练习</th>
            <th className="px-3 py-3 font-medium">操作</th>
          </tr>
        </thead>
      </table>
      <div className="mt-4"><TeacherDataError text={text} /></div>
    </div>
  );
}

function toStudentOverviewErrorMessage(message: string) {
  if (/unauthorized|not authenticated/i.test(message)) return "登录状态已失效，请重新登录。";
  if (/forbidden|teacher role required/i.test(message)) return "当前账号没有教师端访问权限。";
  return /[\u3400-\u9fff]/.test(message) ? message : "学生列表加载失败，请稍后重试。";
}
