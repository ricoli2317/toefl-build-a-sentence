"use client";

import { ChevronDown, Plus, Trash2 } from "lucide-react";
import {
  categoryAssignmentItemLabel,
  categoryAssignmentTotalQuestions,
  type CategoryAssignmentConfigRow,
  type CategoryAssignmentItemType
} from "@/lib/categoryAssignment";
import {
  TeacherDataError,
  TeacherSkeleton
} from "@/components/teacher/TeacherUI";

export type CategoryAssignmentOption = {
  category: string;
  count: number;
};

export function TeacherCategoryAssignmentConfig({
  error,
  itemType,
  loading,
  onChange,
  options,
  rows
}: {
  error?: string;
  itemType: CategoryAssignmentItemType;
  loading?: boolean;
  onChange: (rows: CategoryAssignmentConfigRow[]) => void;
  options: CategoryAssignmentOption[];
  rows: CategoryAssignmentConfigRow[];
}) {
  const total = categoryAssignmentTotalQuestions(rows);
  const availableByCategory = new Map(
    options.map((option) => [option.category, option.count])
  );
  const used = new Set(rows.map((row) => row.category).filter(Boolean));

  function updateRow(index: number, patch: Partial<CategoryAssignmentConfigRow>) {
    onChange(rows.map((row, rowIndex) =>
      rowIndex === index ? { ...row, ...patch } : row
    ));
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, rowIndex) => rowIndex !== index));
  }

  function addRow() {
    const next = options.find((option) => !used.has(option.category) && option.count > 0);
    onChange([
      ...rows,
      { category: next?.category ?? "", count: 5 }
    ]);
  }

  return (
    <div className="grid gap-4">
      <p className="text-sm text-student-muted">
        {itemType === "bas_category"
          ? "选择一个或多个真实语法点，并分别设置题量。系统会在布置时随机抽取并冻结全部题目。"
          : "选择一个或多个 RAP 正式题型，并分别设置题量。系统会在布置时按题目随机抽取并冻结全部题目。"}
        <span className="ml-1 font-semibold text-student-text">当前：{categoryAssignmentItemLabel(itemType)}</span>
      </p>
      {loading ? (
        <div className="grid gap-2">
          {[1, 2, 3].map((item) => <TeacherSkeleton className="h-12 w-full rounded-xl" key={item} />)}
        </div>
      ) : error ? (
        <TeacherDataError text={error} />
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-2">
            {rows.map((row, index) => {
              const available = row.category
                ? availableByCategory.get(row.category) ?? 0
                : null;
              return (
                <div
                  className="grid gap-2 rounded-xl border border-student-border bg-white p-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end"
                  key={`${row.category}:${index}`}
                >
                  <label className="grid gap-1 text-sm font-semibold text-student-text">
                    分类
                    <span className="relative block">
                      <select
                        className="teacher-input w-full appearance-none pr-10"
                        onChange={(event) => updateRow(index, { category: event.target.value })}
                        value={row.category}
                      >
                        <option value="">请选择分类</option>
                        {options.map((option) => (
                          <option
                            disabled={used.has(option.category) && option.category !== row.category}
                            key={option.category}
                            value={option.category}
                          >
                            {option.category}（可用 {option.count} 题）
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        aria-hidden="true"
                        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-student-muted"
                        size={16}
                      />
                    </span>
                  </label>
                  <label className="grid gap-1 text-sm font-semibold text-student-text">
                    题量
                    <input
                      className="teacher-input"
                      min={1}
                      onChange={(event) => updateRow(index, {
                        count: Number(event.target.value) || 0
                      })}
                      type="number"
                      value={row.count}
                    />
                  </label>
                  <button
                    aria-label="删除该分类"
                    className="teacher-button-secondary h-10 px-3 text-student-error"
                    onClick={() => removeRow(index)}
                    type="button"
                  >
                    <Trash2 aria-hidden="true" size={16} />
                  </button>
                  {available !== null ? (
                    row.count > available ? (
                      <p className="text-xs font-semibold text-student-error sm:col-span-3">
                        设置的 {row.count} 题超过当前分类题库可用量（{available} 题）。
                      </p>
                    ) : null
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button className="teacher-button-secondary justify-self-start" onClick={addRow} type="button">
              <Plus aria-hidden="true" size={16} />
              {itemType === "bas_category" ? "添加语法点" : "添加题型"}
            </button>
            <p className="text-sm font-bold text-student-primary">
              合计：{total} 题
            </p>
          </div>
          {rows.length === 0 ? (
            <p className="rounded-xl border border-student-border bg-student-bg px-4 py-3 text-sm text-student-muted">
              请至少添加一个分类。
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
