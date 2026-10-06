"use client";

import type { ReactNode } from "react";
import { Check, ChevronDown, Users } from "lucide-react";
import clsx from "clsx";
import { TeacherClassIcon } from "@/components/icons/TeacherClassIcon";
import { TeacherCard } from "@/components/teacher/TeacherUI";
import { TeacherPopover } from "@/components/teacher/TeacherPopover";
import type { TeacherClassSummary } from "@/lib/teacherClasses";
import type { WritingAssignmentRecipient } from "@/lib/writingAssignments";
import type {
  WritingReviewStatusFilter,
  WritingReviewTaskTypeFilter
} from "@/lib/teacherWritingReviewList";
import { WRITING_TASK_CONFIG, type WritingTaskType } from "@/lib/writing";

/**
 * Shared teacher list-filter controls.
 *
 * The student / class popovers are the exact controls of 作业管理 (student and
 * class tabs); the review filter bar assembles the same bar for both Writing
 * Review tabs, so the two tabs differ only in their first filter. Extending a
 * caller never changes another caller's rendering because every difference is
 * passed in through props.
 */

const STATUS_FILTERS: Array<{ value: WritingReviewStatusFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待批改" },
  { value: "reviewing", label: "批改中" },
  { value: "published", label: "已发布" },
  { value: "ignored", label: "已忽略" }
];

const TASK_TYPE_FILTERS: readonly WritingTaskType[] = ["email", "academic_discussion"];

export function TeacherStudentFilterPopover({
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

export function TeacherClassFilterPopover({
  onSelect,
  options,
  selected
}: {
  onSelect: (entry: TeacherClassSummary | null) => void;
  options: TeacherClassSummary[];
  selected: { class_id: string; name: string } | null;
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

/**
 * The shared Writing Review filter bar: [学生/班级] [批改状态] [题型]. Both
 * tabs render this exact bar; only the primary filter (and its label) differs.
 */
export function TeacherReviewFilterBar({
  bulkActions,
  onStatusFilter,
  onTaskFilter,
  primary,
  primaryLabel,
  statusFilter,
  taskFilter
}: {
  /** 退回/忽略 for the current selection; hidden entirely when nothing is selected. */
  bulkActions?: ReactNode;
  onStatusFilter: (value: WritingReviewStatusFilter) => void;
  onTaskFilter: (value: WritingReviewTaskTypeFilter) => void;
  primary: ReactNode;
  primaryLabel: string;
  statusFilter: WritingReviewStatusFilter;
  taskFilter: WritingReviewTaskTypeFilter;
}) {
  return (
    <TeacherCard className="p-5 sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-5 sm:flex-row sm:flex-wrap sm:items-end">
          <div>
            <span className="mb-2 block text-sm font-semibold text-student-text">{primaryLabel}</span>
            {primary}
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-student-text">批改状态</legend>
            <div className="flex flex-wrap gap-2">
              {STATUS_FILTERS.map((filter) => (
                <button
                  aria-pressed={statusFilter === filter.value}
                  className={clsx(
                    "min-h-10 rounded-[10px] border px-4 text-sm font-semibold transition",
                    statusFilter === filter.value
                      ? "border-student-primary bg-student-primary text-white"
                      : "border-student-border bg-white text-student-text hover:border-student-primary-border hover:bg-student-primary-soft"
                  )}
                  key={filter.value}
                  onClick={() => onStatusFilter(filter.value)}
                  type="button"
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        {bulkActions ? (
          <div className="flex items-end">{bulkActions}</div>
        ) : null}

        <label className="block w-full max-w-[260px]">
          <span className="mb-2 block text-sm font-semibold text-student-text">题型</span>
          <select
            className="h-11 w-full rounded-[10px] border border-student-border bg-white px-3 text-sm font-medium text-student-text"
            onChange={(event) => onTaskFilter(event.target.value as WritingReviewTaskTypeFilter)}
            value={taskFilter}
          >
            <option value="all">全部题型</option>
            {TASK_TYPE_FILTERS.map((taskType) => (
              <option key={taskType} value={taskType}>
                {WRITING_TASK_CONFIG[taskType].label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </TeacherCard>
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
