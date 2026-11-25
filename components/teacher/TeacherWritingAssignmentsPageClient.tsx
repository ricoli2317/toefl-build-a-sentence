"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  TEACHER_CLASSES_CACHE_KEY,
  TEACHER_WRITING_ASSIGNMENTS_FILTER_OPTIONS_CACHE_KEY,
  TEACHER_WRITING_ASSIGNMENTS_PAGE_CACHE_PREFIX,
  TEACHER_WRITING_ASSIGNMENT_TITLES_CACHE_KEY,
  useTeacherCachedData,
  useTeacherDataCache
} from "@/components/TeacherDataCache";
import {
  TeacherClassFilterPopover,
  TeacherStudentFilterPopover
} from "@/components/teacher/TeacherListFilters";
import { TeacherWritingAssignmentList } from "@/components/teacher/TeacherWritingAssignmentList";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import {
  useTeacherIncrementalList,
  type TeacherIncrementalPage
} from "@/components/teacher/TeacherIncrementalList";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  teacherAssignmentsListHref,
  teacherQueryUrl
} from "@/lib/teacherNavigation";
import type {
  WritingAssignmentRecipient,
  WritingAssignmentSummary
} from "@/lib/writingAssignments";
import {
  filterClassSummariesByName,
  type TeacherClassSummary
} from "@/lib/teacherClasses";

type AssignmentsPagePayload = {
  assignments: WritingAssignmentSummary[];
  hasMore?: boolean;
  nextCursor?: string | null;
};

/**
 * The page owns the cursor-paginated assignment request for the current tab
 * and filters. Switching a tab or filter switches the server query and its own
 * cached page sequence; the client never filters a partial history.
 */
export function TeacherWritingAssignmentsPageClient({
  initialClassId,
  initialStudentId,
  initialView
}: {
  initialClassId?: string;
  initialStudentId?: string;
  initialView?: "students" | "class";
}) {
  const router = useRouter();
  const cache = useTeacherDataCache();
  const [view, setView] = useState<"students" | "class">(
    initialView === "class" ? "class" : "students"
  );
  const [filterStudentId, setFilterStudentId] = useState(initialStudentId?.trim() ?? "");
  const [filterClassId, setFilterClassId] = useState(initialClassId?.trim() ?? "");
  const listReturnTo = teacherAssignmentsListHref({
    view,
    studentId: filterStudentId,
    classId: filterClassId
  });

  /**
   * The 学生作业 / 班级作业 tab and both filters stay in the URL, so opening a
   * detail page can pass the exact list state as `returnTo` and the browser
   * Back button restores the same tab and filter.
   */
  function syncListUrl(next: { view: "students" | "class"; studentId: string; classId: string }) {
    router.replace(
      teacherQueryUrl({
        view: next.view === "class" ? "class" : null,
        classId: next.view === "class" && next.classId ? next.classId : null,
        studentId: next.view === "students" && next.studentId ? next.studentId : null
      }),
      { scroll: false }
    );
  }

  function selectView(nextView: "students" | "class") {
    setView(nextView);
    syncListUrl({ view: nextView, studentId: filterStudentId, classId: filterClassId });
  }

  function selectStudentFilter(studentId: string) {
    setFilterStudentId(studentId);
    syncListUrl({ view, studentId, classId: filterClassId });
  }

  function selectClassFilter(classId: string) {
    setFilterClassId(classId);
    syncListUrl({ view, studentId: filterStudentId, classId });
  }

  const listCacheKey =
    `${TEACHER_WRITING_ASSIGNMENTS_PAGE_CACHE_PREFIX}:${view}`
    + `:${view === "students" ? filterStudentId || "all" : "all"}`
    + `:${view === "class" ? filterClassId || "all" : "all"}`;
  const list = useTeacherIncrementalList<WritingAssignmentSummary>({
    cacheKey: listCacheKey,
    getId: getAssignmentId,
    loadPage: (cursor) =>
      loadAssignmentPage({
        classId: view === "class" ? filterClassId : "",
        cursor,
        studentId: view === "students" ? filterStudentId : "",
        view
      })
  });

  const classesState = useTeacherCachedData<{ classes: TeacherClassSummary[] }>(
    TEACHER_CLASSES_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/classes")
  );
  // Independent lightweight source for the student picker: ids + names of the
  // direct-assignment recipients, never the full assignment history.
  const studentOptionsState = useTeacherCachedData<{ students: WritingAssignmentRecipient[] }>(
    TEACHER_WRITING_ASSIGNMENTS_FILTER_OPTIONS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/writing/assignments/filter-options"),
    { enabled: view === "students" }
  );

  const classOptions = useMemo(
    () => filterClassSummariesByName(classesState.data?.classes ?? [], ""),
    [classesState.data]
  );
  const selectedClass: TeacherClassSummary | null = filterClassId
    ? classOptions.find((option) => option.class_id === filterClassId) ?? {
        class_id: filterClassId,
        name: "",
        subjects: [],
        member_count: 0,
        created_at: ""
      }
    : null;

  const studentOptions = useMemo(() => {
    const recipients = studentOptionsState.data?.students ?? [];
    const sorted = [...recipients];
    // Keep a deep-linked student selectable even before their name is known.
    if (filterStudentId && !sorted.some((recipient) => recipient.student_id === filterStudentId)) {
      sorted.unshift({ student_id: filterStudentId, student_name: "" });
    }
    return sorted;
  }, [filterStudentId, studentOptionsState.data]);
  const filterStudent: WritingAssignmentRecipient | null = filterStudentId
    ? studentOptions.find((option) => option.student_id === filterStudentId) ?? {
        student_id: filterStudentId,
        student_name: ""
      }
    : null;

  /**
   * Keep a rolling group-title index for the create form's automatic-title
   * preview. It only accumulates titles from pages the teacher actually
   * loaded; the create RPC still computes the final title authoritatively.
   */
  useEffect(() => {
    const items = list.data?.items ?? [];
    const groups = items.flatMap((assignment) =>
      assignment.group_id && assignment.group_title?.trim()
        ? [{ group_id: assignment.group_id, title: assignment.group_title.trim() }]
        : []
    );
    if (groups.length === 0) return;
    const entry = cache.getEntry(TEACHER_WRITING_ASSIGNMENT_TITLES_CACHE_KEY);
    const existing =
      entry?.status === "success" || entry?.status === "refreshing"
        ? ((entry.data as { groups?: unknown }).groups ?? [])
        : [];
    const known = Array.isArray(existing)
      ? existing.filter(
          (value): value is { group_id: string; title: string } =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { group_id?: unknown }).group_id === "string" &&
            typeof (value as { title?: unknown }).title === "string"
        )
      : [];
    const byGroupId = new Map(known.map((group) => [group.group_id, group]));
    const knownSize = byGroupId.size;
    for (const group of groups) byGroupId.set(group.group_id, group);
    if (byGroupId.size === knownSize) return;
    cache.set(TEACHER_WRITING_ASSIGNMENT_TITLES_CACHE_KEY, {
      groups: Array.from(byGroupId.values()).slice(-300)
    });
  }, [cache, list.data]);

  const newAssignmentHref = view === "class"
    ? filterClassId
      ? `/teacher/writing/assignments/new?classId=${encodeURIComponent(filterClassId)}`
      : "/teacher/writing/assignments/new"
    : filterStudentId
      ? `/teacher/writing/assignments/new?studentId=${encodeURIComponent(filterStudentId)}`
      : "/teacher/writing/assignments/new";

  return (
    <TeacherAppShell
      action={
        <div className="flex flex-wrap items-center gap-3">
          {view === "class" ? (
            <TeacherClassFilterPopover
              onSelect={(entry) => selectClassFilter(entry?.class_id ?? "")}
              options={classOptions}
              selected={selectedClass}
            />
          ) : (
            <TeacherStudentFilterPopover
              onSelect={(recipient) => selectStudentFilter(recipient?.student_id ?? "")}
              options={studentOptions}
              selected={filterStudent}
            />
          )}
          <Link className="teacher-button-primary" href={newAssignmentHref}><Plus aria-hidden="true" size={17} />布置作业</Link>
        </div>
      }
      crumbs={[
        { label: "首页", href: "/teacher/dashboard" },
        { label: "作业管理" }
      ]}
      subtitle="布置写作任务并查看每名学生的完成状态。"
      title="作业管理"
    >
      <div className="grid gap-5">
        <nav aria-label="作业类型" className="flex gap-2 border-b border-student-border">
          <button
            className={`border-b-2 px-5 py-3 text-sm font-bold ${view === "students" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
            onClick={() => selectView("students")}
            type="button"
          >
            学生作业
          </button>
          <button
            className={`border-b-2 px-5 py-3 text-sm font-bold ${view === "class" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
            onClick={() => selectView("class")}
            type="button"
          >
            班级作业
          </button>
        </nav>
        <TeacherWritingAssignmentList
          assignments={list.items}
          error={list.error}
          filterClass={view === "class" ? selectedClass : null}
          filterStudent={view === "students" ? filterStudent : null}
          hasMore={list.hasMore}
          listReturnTo={listReturnTo}
          loading={list.loading}
          loadingMore={list.loadingMore}
          loadMoreError={list.loadMoreError}
          mode={view}
          onClearClassFilter={() => selectClassFilter("")}
          onClearFilter={() => selectStudentFilter("")}
          onLoadMore={() => void list.loadMore()}
          onRetryInitial={list.reload}
          onRetryLoadMore={() => void list.loadMore()}
        />
      </div>
    </TeacherAppShell>
  );
}

function getAssignmentId(assignment: WritingAssignmentSummary) {
  return assignment.assignment_id;
}

async function loadAssignmentPage({
  classId,
  cursor,
  studentId,
  view
}: {
  classId: string;
  cursor: string | null;
  studentId: string;
  view: "students" | "class";
}): Promise<TeacherIncrementalPage<WritingAssignmentSummary>> {
  const search = new URLSearchParams({ view, limit: "20" });
  if (view === "students" && studentId) search.set("studentId", studentId);
  if (view === "class" && classId) search.set("classId", classId);
  if (cursor) search.set("cursor", cursor);
  const payload = await teacherApiFetch<AssignmentsPagePayload>(
    `/api/teacher/writing/assignments?${search.toString()}`
  );
  if (!Array.isArray(payload.assignments)) {
    throw new Error("作业列表数据格式无效，请稍后重试。");
  }
  return {
    items: payload.assignments,
    hasMore: payload.hasMore === true,
    nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : null
  };
}
