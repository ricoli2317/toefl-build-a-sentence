"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import {
  TEACHER_CLASSES_CACHE_KEY,
  TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import {
  TeacherClassFilterPopover,
  TeacherStudentFilterPopover
} from "@/components/teacher/TeacherListFilters";
import { TeacherWritingAssignmentList } from "@/components/teacher/TeacherWritingAssignmentList";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  teacherAssignmentsListHref,
  teacherQueryUrl
} from "@/lib/teacherNavigation";
import {
  collectWritingAssignmentRecipients,
  filterWritingAssignmentsByStudent,
  type WritingAssignmentRecipient,
  type WritingAssignmentSummary
} from "@/lib/writingAssignments";
import {
  filterClassSummariesByName,
  filterDirectWritingAssignments,
  filterWritingAssignmentsByClass,
  isClassWritingAssignment,
  type TeacherClassSummary
} from "@/lib/teacherClasses";

/**
 * The page owns the single assignment request. The 学生作业 / 班级作业 tabs and
 * both filters work off that one payload, so switching a tab or filter is a
 * pure local operation with no loading state and no extra API call.
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
  const { data, error, loading } = useTeacherCachedData<{
    assignments: WritingAssignmentSummary[];
  }>(
    TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/writing/assignments")
  );
  const classesState = useTeacherCachedData<{ classes: TeacherClassSummary[] }>(
    TEACHER_CLASSES_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/classes")
  );

  const assignments = useMemo(() => data?.assignments ?? [], [data]);
  // 学生作业 keeps exactly the previous direct-assignment flow; class
  // assignments live only in the 班级作业 tab.
  const directAssignments = useMemo(
    () => filterDirectWritingAssignments(assignments),
    [assignments]
  );
  const classAssignments = useMemo(
    () => assignments.filter(isClassWritingAssignment),
    [assignments]
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
    const recipients = collectWritingAssignmentRecipients(directAssignments);
    const collator = new Intl.Collator("zh-Hans-CN");
    const sorted = [...recipients].sort((left, right) =>
      collator.compare(left.student_name, right.student_name)
    );
    // Keep a deep-linked student selectable even before their name is known.
    if (filterStudentId && !recipients.some((recipient) => recipient.student_id === filterStudentId)) {
      sorted.unshift({ student_id: filterStudentId, student_name: "" });
    }
    return sorted;
  }, [directAssignments, filterStudentId]);
  const filterStudent: WritingAssignmentRecipient | null = filterStudentId
    ? studentOptions.find((option) => option.student_id === filterStudentId) ?? {
        student_id: filterStudentId,
        student_name: ""
      }
    : null;

  const visibleAssignments = useMemo(
    () =>
      view === "class"
        ? filterWritingAssignmentsByClass(classAssignments, filterClassId)
        : filterWritingAssignmentsByStudent(directAssignments, filterStudentId),
    [classAssignments, directAssignments, filterClassId, filterStudentId, view]
  );
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
          assignments={visibleAssignments}
          error={error}
          filterClass={view === "class" ? selectedClass : null}
          filterStudent={view === "students" ? filterStudent : null}
          listReturnTo={listReturnTo}
          loading={loading}
          mode={view}
          onClearClassFilter={() => selectClassFilter("")}
          onClearFilter={() => selectStudentFilter("")}
        />
      </div>
    </TeacherAppShell>
  );
}
