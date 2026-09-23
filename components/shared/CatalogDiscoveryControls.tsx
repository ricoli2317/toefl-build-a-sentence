"use client";

import { Search, SlidersHorizontal, X } from "lucide-react";
import type {
  CatalogSortDirection,
  CatalogSortKey,
  CatalogStatusFilter
} from "@/lib/catalogDiscovery";
import { StudentEmptyState } from "@/components/student/StudentUI";

export type CatalogDiscoveryControlValue = {
  query: string;
  status: CatalogStatusFilter;
  months: string[];
  category: string;
  sortKey: CatalogSortKey;
  sortDirection: CatalogSortDirection;
};

export function CatalogDiscoveryControls({
  categories,
  months,
  onChange,
  onClear,
  value
}: {
  categories: string[] | null;
  months: string[];
  onChange: (value: CatalogDiscoveryControlValue) => void;
  onClear: () => void;
  value: CatalogDiscoveryControlValue;
}) {
  const activeCount = Number(Boolean(value.query.trim()))
    + Number(value.status !== "all")
    + value.months.length
    + Number(Boolean(value.category))
    + Number(value.sortKey !== "default");
  const update = (patch: Partial<CatalogDiscoveryControlValue>) => onChange({ ...value, ...patch });

  return (
    <section aria-label="目录搜索、排序和筛选" className="rounded-2xl border border-student-border bg-white p-3 shadow-sm">
      <div className="grid gap-2 lg:grid-cols-[minmax(13rem,1.7fr)_minmax(9rem,1fr)_minmax(8rem,.9fr)_auto_auto]">
        <label className="relative min-w-0">
          <span className="sr-only">搜索题目</span>
          <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-student-muted" size={16} />
          <input
            className="student-input min-h-10 w-full pl-9"
            onChange={(event) => update({ query: event.target.value })}
            placeholder="搜索标题或题目内容"
            type="search"
            value={value.query}
          />
        </label>
        <select className="student-input min-h-10" aria-label="排序方式" onChange={(event) => update({ sortKey: event.target.value as CatalogSortKey })} value={value.sortKey}>
          <option value="default">默认排序</option>
          <option value="occurrence_count">重复次数</option>
          <option value="first_seen_date">首次出现日期</option>
          <option value="latest_seen_date">最新出现日期</option>
        </select>
        <select className="student-input min-h-10" aria-label="完成状态" onChange={(event) => update({ status: event.target.value as CatalogStatusFilter })} value={value.status}>
          <option value="all">全部状态</option>
          <option value="unstarted">未开始</option>
          <option value="in_progress">练习中</option>
          <option value="completed">已完成</option>
        </select>
        <MonthFilter months={months} onChange={(selected) => update({ months: selected })} selected={value.months} />
        {categories ? (
          <select className="student-input min-h-10" aria-label="主题" onChange={(event) => update({ category: event.target.value })} value={value.category}>
            <option value="">全部主题</option>
            {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-student-muted">
          <SlidersHorizontal aria-hidden="true" size={14} />
          <span>{activeCount ? `已应用 ${activeCount} 项条件` : "可组合搜索与筛选"}</span>
        </div>
        <div className="flex items-center gap-2">
          {value.sortKey !== "default" ? (
            <button className="student-button-secondary min-h-8 px-3 py-1 text-xs" onClick={() => update({ sortDirection: value.sortDirection === "asc" ? "desc" : "asc" })} type="button">
              {value.sortDirection === "asc" ? "升序" : "降序"}
            </button>
          ) : null}
          {activeCount ? (
            <button className="inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-semibold text-student-primary hover:bg-student-primary-soft" onClick={onClear} type="button">
              <X aria-hidden="true" size={14} />清除筛选
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

export function CatalogFilteredEmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div className="grid justify-items-center gap-3">
      <StudentEmptyState text="没有符合当前条件的题目" />
      <button className="student-button-secondary min-h-9 px-3 py-1.5" onClick={onClear} type="button">
        清除筛选
      </button>
    </div>
  );
}

function MonthFilter({
  months,
  onChange,
  selected
}: {
  months: string[];
  onChange: (months: string[]) => void;
  selected: string[];
}) {
  const selectedSet = new Set(selected);
  return (
    <details className="relative">
      <summary className="student-input flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 whitespace-nowrap">
        {selected.length ? `月份 ${selected.length}` : "全部月份"}
        <span aria-hidden="true" className="text-xs">▾</span>
      </summary>
      <div className="absolute right-0 z-20 mt-1 max-h-64 min-w-44 overflow-y-auto rounded-xl border border-student-border bg-white p-2 shadow-lg">
        {months.map((month) => (
          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50" key={month}>
            <input
              checked={selectedSet.has(month)}
              onChange={() => onChange(selectedSet.has(month) ? selected.filter((value) => value !== month) : [...selected, month])}
              type="checkbox"
            />
            <span>{formatMonth(month)}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function formatMonth(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[1]}年${Number(match[2])}月` : month;
}
