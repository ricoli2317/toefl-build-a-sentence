"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Check, ChevronDown, Plus, Users } from "lucide-react";
import {
  TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import { TeacherPopover } from "@/components/teacher/TeacherPopover";
import { TeacherWritingAssignmentList } from "@/components/teacher/TeacherWritingAssignmentList";
import { TeacherAppShell } from "@/components/teacher/TeacherAppShell";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  collectWritingAssignmentRecipients,
  filterWritingAssignmentsByStudent,
  type WritingAssignmentRecipient,
  type WritingAssignmentSummary
} from "@/lib/writingAssignments";

/**
 * The page owns the single assignment request. The student filter and the list
 * both work off that one payload, so switching students is a pure local
 * filter with no loading state and no extra API call.
 */
export function TeacherWritingAssignmentsPageClient({
  initialStudentId
}: {
  initialStudentId?: string;
}) {
  const [filterStudentId, setFilterStudentId] = useState(initialStudentId?.trim() ?? "");
  const { data, error, loading } = useTeacherCachedData<{
    assignments: WritingAssignmentSummary[];
  }>(
    TEACHER_WRITING_ASSIGNMENTS_CACHE_KEY,
    () => teacherApiFetch("/api/teacher/writing/assignments")
  );
  const assignments = useMemo(() => data?.assignments ?? [], [data]);
  const studentOptions = useMemo(() => {
    const recipients = collectWritingAssignmentRecipients(assignments);
    const collator = new Intl.Collator("zh-Hans-CN");
    const sorted = [...recipients].sort((left, right) =>
      collator.compare(left.student_name, right.student_name)
    );
    // Keep a deep-linked student selectable even before their name is known.
    if (filterStudentId && !recipients.some((recipient) => recipient.student_id === filterStudentId)) {
      sorted.unshift({ student_id: filterStudentId, student_name: "" });
    }
    return sorted;
  }, [assignments, filterStudentId]);
  const filterStudent: WritingAssignmentRecipient | null = filterStudentId
    ? studentOptions.find((option) => option.student_id === filterStudentId) ?? {
        student_id: filterStudentId,
        student_name: ""
      }
    : null;
  const filteredAssignments = useMemo(
    () => filterWritingAssignmentsByStudent(assignments, filterStudentId),
    [assignments, filterStudentId]
  );
  const newAssignmentHref = filterStudentId
    ? `/teacher/writing/assignments/new?studentId=${encodeURIComponent(filterStudentId)}`
    : "/teacher/writing/assignments/new";

  return (
    <TeacherAppShell
      action={
        <div className="flex flex-wrap items-center gap-3">
          <TeacherAssignmentStudentFilter
            onSelect={(recipient) => setFilterStudentId(recipient?.student_id ?? "")}
            options={studentOptions}
            selected={filterStudent}
          />
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
      <TeacherWritingAssignmentList
        assignments={filteredAssignments}
        error={error}
        filterStudent={filterStudent}
        loading={loading}
        onClearFilter={() => setFilterStudentId("")}
      />
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
