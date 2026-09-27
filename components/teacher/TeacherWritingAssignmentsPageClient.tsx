"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Users } from "lucide-react";
import {
  TEACHER_CLASSES_CACHE_KEY,
  TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import { TeacherPopover } from "@/components/teacher/TeacherPopover";
import { TeacherWritingAssignmentList } from "@/components/teacher/TeacherWritingAssignmentList";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { TeacherClassIcon } from "@/components/icons/TeacherClassIcon";
import { teacherApiFetch } from "@/lib/teacherClientApi";
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
  const [view, setView] = useState<"students" | "class">(
    initialView === "class" ? "class" : "students"
  );
  const [filterStudentId, setFilterStudentId] = useState(initialStudentId?.trim() ?? "");
  const [filterClassId, setFilterClassId] = useState(initialClassId?.trim() ?? "");
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
            <TeacherAssignmentClassFilter
              onSelect={(entry) => setFilterClassId(entry?.class_id ?? "")}
              options={classOptions}
              selected={selectedClass}
            />
          ) : (
            <TeacherAssignmentStudentFilter
              onSelect={(recipient) => setFilterStudentId(recipient?.student_id ?? "")}
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
            onClick={() => setView("students")}
            type="button"
          >
            学生作业
          </button>
          <button
            className={`border-b-2 px-5 py-3 text-sm font-bold ${view === "class" ? "border-student-primary text-student-primary" : "border-transparent text-student-muted hover:text-student-text"}`}
            onClick={() => setView("class")}
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
          loading={loading}
          mode={view}
          onClearClassFilter={() => setFilterClassId("")}
          onClearFilter={() => setFilterStudentId("")}
        />
      </div>
    </TeacherAppShell>
  );
}

function TeacherAssignmentStudentFilter({
  onSelect,
  options,
  selected
}: {
  onSelect: (recipient: WritingAssignmentRecipient | null) => void;
  options: WritingAssignmentRecipient[];
  selected: WritingAssignmentRecipient | null;
}) {
  const label = selected
    ? selected.student_name || "所选学生"
    : "全部学生";
  return (
    <TeacherPopover
      buttonClassName="teacher-button-secondary"
      buttonContent={
        <>
          <Users aria-hidden="true" size={17} />
          <span className="max-w-[11rem] truncate">{label}</span>
          <ChevronDown aria-hidden="true" size={15} />
        </>
      }
      menuAlign="left"
      menuClassName="min-w-[15rem]"
    >
      {(close) => (
        <div className="grid max-h-80 gap-0.5 overflow-y-auto" role="none">
          <FilterOption
            active={!selected}
            label="全部学生"
            onClick={() => {
              onSelect(null);
              close();
            }}
          />
          {options.map((option) => (
            <FilterOption
              active={selected?.student_id === option.student_id}
              key={option.student_id}
              label={option.student_name || "未命名学生"}
              onClick={() => {
                onSelect(option);
                close();
              }}
            />
          ))}
        </div>
      )}
    </TeacherPopover>
  );
}

function TeacherAssignmentClassFilter({
  onSelect,
  options,
  selected
}: {
  onSelect: (entry: TeacherClassSummary | null) => void;
  options: TeacherClassSummary[];
  selected: TeacherClassSummary | null;
}) {
  const label = selected ? selected.name || "所选班级" : "全部班级";
  return (
    <TeacherPopover
      buttonClassName="teacher-button-secondary"
      buttonContent={
        <>
          <TeacherClassIcon aria-hidden="true" size={17} strokeWidth={2} />
          <span className="max-w-[11rem] truncate">{label}</span>
          <ChevronDown aria-hidden="true" size={15} />
        </>
      }
      menuAlign="left"
      menuClassName="min-w-[15rem]"
    >
      {(close) => (
        <div className="grid max-h-80 gap-0.5 overflow-y-auto" role="none">
          <FilterOption
            active={!selected}
            label="全部班级"
            onClick={() => {
              onSelect(null);
              close();
            }}
          />
          {options.map((entry) => (
            <FilterOption
              active={selected?.class_id === entry.class_id}
              key={entry.class_id}
              label={entry.name || "未命名班级"}
              onClick={() => {
                onSelect(entry);
                close();
              }}
            />
          ))}
        </div>
      )}
    </TeacherPopover>
  );
}

function FilterOption({
  active,
  label,
  onClick
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${active ? "bg-student-primary-soft text-student-primary" : "text-student-text hover:bg-student-bg"}`}
      onClick={onClick}
      role="menuitem"
      type="button"
    >
      <span className="truncate">{label}</span>
      {active ? <Check aria-hidden="true" size={15} /> : null}
    </button>
  );
}
