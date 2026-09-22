"use client";

import Link from "next/link";
import { useRef, useState } from "react";
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
import { publishCacheInvalidation } from "@/lib/cacheInvalidation";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  compareStudentSearchGroups,
  compareStudentSearchMetadata,
  createStudentSearchMetadata,
  studentSearchRank,
  type StudentSearchMetadata
} from "@/lib/studentSearch";
import type { StudentBindingDomain } from "@/lib/studentBindings";
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
const DOMAIN_LABELS: Record<StudentBindingDomain, string> = {
  reading: "阅读",
  writing: "写作"
};

/**
 * Lightweight student overview. It only renders the shared practice summary
 * (总时间 / 最近练习) and never loads accuracy, writing scores, or question
 * details; those stay on the domain-scoped student detail pages.
 */
export function TeacherStudentOverviewList() {
  const [query, setQuery] = useState("");
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

  return (
    <div className="grid gap-6">
      {loading ? <TeacherLoadingRegion label="正在加载学生列表" /> : null}
      <TeacherCard className="p-5 sm:p-6">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="w-full max-w-[560px]">
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
            <p className="mt-3 text-sm text-student-muted">
              支持中文精确搜索，例如：张三；支持拼音模糊搜索，例如：zhang / san
            </p>
          </div>
          <p className="text-sm font-medium text-student-text">按姓氏首字母排序</p>
        </div>
      </TeacherCard>

      <div className="flex items-start gap-3">
        <TeacherCard className="min-w-0 flex-1 overflow-hidden p-0">
          <div className="px-6 pt-6">
            <TeacherSectionTitle>学生列表</TeacherSectionTitle>
          </div>
          {loading ? (
            <StudentTableSkeleton />
          ) : error ? (
            <StudentTableError text={toStudentOverviewErrorMessage(error)} />
          ) : filtered.length === 0 ? (
            <div className="p-6">
              <TeacherEmptyState text={query.trim() ? "没有找到匹配的学生。" : "暂无学生。"} />
            </div>
          ) : (
            <div className="overflow-x-auto px-6 pb-6 pt-4">
              <table className="w-full min-w-[860px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-student-border text-student-muted">
                    <th className="px-3 py-3 font-medium">学生</th>
                    <th className="px-3 py-3 font-medium">学科</th>
                    <th className="px-3 py-3 font-medium">练习总时间</th>
                    <th className="px-3 py-3 font-medium">最近练习</th>
                    <th className="px-3 py-3 font-medium">操作</th>
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
                          <div className="flex items-center gap-3">
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
                                  href={`/teacher/students/${encodeURIComponent(entry.student.studentId)}`}
                                >
                                  {name}
                                </TeacherTextLink>
                              )}
                            />
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-1.5">
                            {entry.student.domains.length > 0 ? (
                              entry.student.domains.map((domain) => (
                                <SubjectChip domain={domain} key={domain} />
                              ))
                            ) : (
                              <span className="text-student-muted">—</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 tabular-nums text-student-text">
                          {formatPracticeDuration(entry.student.totalPracticeSeconds)}
                        </td>
                        <td className="px-3 py-3 tabular-nums text-student-text">
                          {formatLatestPracticeAt(entry.student.latestPracticeAt)}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link
                              className="teacher-button-secondary"
                              href={`/teacher/writing/assignments?studentId=${encodeURIComponent(entry.student.studentId)}`}
                            >
                              作业管理
                            </Link>
                            <Link
                              className="teacher-button-secondary"
                              href={`/teacher/students/${encodeURIComponent(entry.student.studentId)}`}
                            >
                              查看
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
        </TeacherCard>

        <nav aria-label="学生姓氏首字母索引" className="sticky top-[96px] hidden w-7 shrink-0 flex-col items-center gap-0.5 py-1 xl:flex">
          {ALPHABET.map((letter) => {
            const available = availableLetters.has(letter);
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
    </div>
  );
}

export function SubjectChip({ domain }: { domain: StudentBindingDomain }) {
  const reading = domain === "reading";
  return (
    <span
      className={
        reading
          ? "rounded-full border border-[#cfe3f8] bg-[#eef6ff] px-2.5 py-0.5 text-xs font-semibold text-[#347fdc]"
          : "rounded-full border border-student-primary-border bg-student-primary-soft px-2.5 py-0.5 text-xs font-semibold text-student-primary"
      }
    >
      {DOMAIN_LABELS[domain]}
    </span>
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
            <th className="px-3 py-3 font-medium">学科</th>
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
            <th className="px-3 py-3 font-medium">学科</th>
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
