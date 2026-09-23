"use client";

import { ArrowDown, ArrowUp, Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { StudentEmptyState } from "@/components/student/StudentUI";
import type {
  CatalogSortDirection,
  CatalogSortKey,
  CatalogStatusFilter
} from "@/lib/catalogDiscovery";
import type { ReadingLengthFilter } from "@/lib/reading/catalogDiscovery";

export type CatalogDiscoveryControlValue = {
  query: string;
  status: CatalogStatusFilter;
  months: string[];
  categories: string[];
  sortKey: CatalogSortKey;
  sortDirection: CatalogSortDirection;
};

type OpenMenu = "sort" | "status" | "months" | "categories" | "length" | null;

const SORT_OPTIONS: Array<{ label: string; value: CatalogSortKey }> = [
  { label: "默认排序", value: "default" },
  { label: "重复次数", value: "occurrence_count" },
  { label: "首次出现日期", value: "first_seen_date" },
  { label: "最新出现日期", value: "latest_seen_date" }
];

const STATUS_OPTIONS: Array<{ label: string; value: CatalogStatusFilter }> = [
  { label: "全部状态", value: "all" },
  { label: "未开始", value: "unstarted" },
  { label: "练习中", value: "in_progress" },
  { label: "已完成", value: "completed" }
];

const LENGTH_OPTIONS: Array<{ label: string; value: ReadingLengthFilter }> = [
  { label: "全部篇幅", value: "all" },
  { label: "短篇", value: "short" },
  { label: "长篇", value: "long" }
];

export function CatalogDiscoveryControls({
  categories,
  months,
  onChange,
  onClear,
  rdlLengthFilter,
  layoutVariant = "default",
  value
}: {
  categories: string[] | null;
  months: string[];
  onChange: (value: CatalogDiscoveryControlValue) => void;
  onClear: () => void;
  rdlLengthFilter?: {
    onChange: (value: ReadingLengthFilter) => void;
    value: ReadingLengthFilter;
  };
  layoutVariant?: "default" | "rdl";
  value: CatalogDiscoveryControlValue;
}) {
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const rootRef = useRef<HTMLElement>(null);
  const activeCount = Number(Boolean(value.query.trim()))
    + Number(value.status !== "all")
    + value.months.length
    + value.categories.length
    + Number(value.sortKey !== "default")
    + Number(rdlLengthFilter?.value !== undefined && rdlLengthFilter.value !== "all");
  const update = (patch: Partial<CatalogDiscoveryControlValue>) => onChange({ ...value, ...patch });

  useEffect(() => {
    if (!openMenu) return;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", closeOnOutsidePointer, true);
    document.addEventListener("click", closeOnOutsidePointer, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer, true);
      document.removeEventListener("click", closeOnOutsidePointer, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  let gridClass: string;
  if (layoutVariant === "rdl" && rdlLengthFilter) {
    gridClass = activeCount
      ? "xl:grid-cols-[minmax(13rem,1.7fr)_repeat(5,minmax(0,1fr))_2.25rem]"
      : "xl:grid-cols-[minmax(13rem,1.7fr)_repeat(5,minmax(0,1fr))]";
  } else if (categories) {
    gridClass = activeCount
      ? "lg:grid-cols-[minmax(14rem,1.7fr)_minmax(10rem,.9fr)_minmax(8rem,.7fr)_minmax(8rem,.75fr)_minmax(8rem,.75fr)_2.25rem]"
      : "lg:grid-cols-[minmax(14rem,1.7fr)_minmax(10rem,.9fr)_minmax(8rem,.7fr)_minmax(8rem,.75fr)_minmax(8rem,.75fr)]";
  } else {
    gridClass = activeCount
      ? "lg:grid-cols-[minmax(16rem,1.9fr)_minmax(10rem,.9fr)_minmax(8rem,.7fr)_minmax(8rem,.75fr)_2.25rem]"
      : "lg:grid-cols-[minmax(16rem,1.9fr)_minmax(10rem,.9fr)_minmax(8rem,.7fr)_minmax(8rem,.75fr)]";
  }

  return (
    <section
      aria-label="目录搜索、排序和筛选"
      className="rounded-xl border border-student-border bg-white p-2 shadow-[0_1px_4px_rgba(23,32,51,0.035)]"
      ref={rootRef}
    >
      <div className={`grid grid-cols-1 gap-1.5 sm:grid-cols-2 ${gridClass}`}>
        <label className={`relative min-w-0 sm:col-span-2 ${layoutVariant === "rdl" ? "xl:col-span-1" : "lg:col-span-1"}`}>
          <span className="sr-only">搜索题目</span>
          <Search aria-hidden="true" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-student-muted" size={14} />
          <input
            aria-label="搜索题目"
            className="h-9 w-full rounded-lg border border-student-border bg-slate-50/60 pl-8 pr-2.5 text-[13px] font-normal text-student-text outline-none placeholder:text-student-muted focus:border-student-primary-border focus:bg-white focus:ring-2 focus:ring-blue-100"
            onChange={(event) => update({ query: event.target.value })}
            placeholder="搜索标题或题目内容"
            type="search"
            value={value.query}
          />
        </label>

        <div className="flex min-w-0 gap-1">
          <SingleSelect
            label={SORT_OPTIONS.find((option) => option.value === value.sortKey)?.label ?? "默认排序"}
            menu="sort"
            onOpenChange={setOpenMenu}
            onSelect={(sortKey) => {
              update({ sortKey });
              setOpenMenu(null);
            }}
            open={openMenu === "sort"}
            options={SORT_OPTIONS}
            value={value.sortKey}
          />
          {value.sortKey !== "default" ? (
            <button
              aria-label={value.sortDirection === "asc" ? "当前升序，点击改为降序" : "当前降序，点击改为升序"}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-student-primary-border bg-white text-student-primary transition hover:bg-student-primary-soft focus:outline-none focus:ring-2 focus:ring-blue-100"
              onClick={() => update({ sortDirection: value.sortDirection === "asc" ? "desc" : "asc" })}
              title={value.sortDirection === "asc" ? "升序" : "降序"}
              type="button"
            >
              {value.sortDirection === "asc" ? <ArrowUp aria-hidden="true" size={14} /> : <ArrowDown aria-hidden="true" size={14} />}
            </button>
          ) : null}
        </div>

        <SingleSelect
          label={STATUS_OPTIONS.find((option) => option.value === value.status)?.label ?? "全部状态"}
          menu="status"
          onOpenChange={setOpenMenu}
          onSelect={(status) => {
            update({ status });
            setOpenMenu(null);
          }}
          open={openMenu === "status"}
          options={STATUS_OPTIONS}
          value={value.status}
        />

        <MultiSelect
          allLabel="全部月份"
          label={value.months.length ? `已选 ${value.months.length} 个月份` : "全部月份"}
          menu="months"
          onChange={(selected) => update({ months: selected })}
          onOpenChange={setOpenMenu}
          open={openMenu === "months"}
          options={months.map((month) => ({ label: formatMonth(month), value: month }))}
          selected={value.months}
        />

        {categories ? (
          <MultiSelect
            allLabel="全部主题"
            label={value.categories.length ? `已选 ${value.categories.length} 个主题` : "全部主题"}
            menu="categories"
            onChange={(selected) => update({ categories: selected })}
            onOpenChange={setOpenMenu}
            open={openMenu === "categories"}
            options={categories.map((category) => ({ label: category, value: category }))}
            selected={value.categories}
          />
        ) : null}

        {rdlLengthFilter ? (
          <SingleSelect
            label={LENGTH_OPTIONS.find((option) => option.value === rdlLengthFilter.value)?.label ?? "全部篇幅"}
            menu="length"
            onOpenChange={setOpenMenu}
            onSelect={(length) => {
              rdlLengthFilter.onChange(length);
              setOpenMenu(null);
            }}
            open={openMenu === "length"}
            options={LENGTH_OPTIONS}
            value={rdlLengthFilter.value}
          />
        ) : null}

        {activeCount ? (
          <button
            aria-label="清除筛选"
            className="flex h-9 w-9 justify-self-end items-center justify-center rounded-lg text-student-muted transition hover:bg-student-primary-soft hover:text-student-primary focus:outline-none focus:ring-2 focus:ring-blue-100"
            onClick={() => {
              setOpenMenu(null);
              onClear();
            }}
            title="清除筛选"
            type="button"
          >
            <X aria-hidden="true" size={15} />
          </button>
        ) : null}
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

function SingleSelect<T extends string>({
  label,
  menu,
  onOpenChange,
  onSelect,
  open,
  options,
  value
}: {
  label: string;
  menu: Exclude<OpenMenu, "months" | "categories" | null>;
  onOpenChange: (menu: OpenMenu) => void;
  onSelect: (value: T) => void;
  open: boolean;
  options: Array<{ label: string; value: T }>;
  value: T;
}) {
  return (
    <DropdownShell
      label={label}
      onToggle={() => onOpenChange(open ? null : menu)}
      open={open}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            aria-selected={selected}
            className={optionClass(selected)}
            key={option.value}
            onClick={() => onSelect(option.value)}
            role="option"
            type="button"
          >
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {selected ? <Check aria-hidden="true" className="shrink-0" size={14} /> : null}
          </button>
        );
      })}
    </DropdownShell>
  );
}

function MultiSelect({
  allLabel,
  label,
  menu,
  onChange,
  onOpenChange,
  open,
  options,
  selected
}: {
  allLabel: string;
  label: string;
  menu: "months" | "categories";
  onChange: (selected: string[]) => void;
  onOpenChange: (menu: OpenMenu) => void;
  open: boolean;
  options: Array<{ label: string; value: string }>;
  selected: string[];
}) {
  const selectedSet = new Set(selected);
  return (
    <DropdownShell label={label} onToggle={() => onOpenChange(open ? null : menu)} open={open} scroll>
      <MultiSelectOption checked={selected.length === 0} label={allLabel} onClick={() => onChange([])} />
      {options.map((option) => (
        <MultiSelectOption
          checked={selectedSet.has(option.value)}
          key={option.value}
          label={option.label}
          onClick={() => onChange(
            selectedSet.has(option.value)
              ? selected.filter((value) => value !== option.value)
              : [...selected, option.value]
          )}
        />
      ))}
    </DropdownShell>
  );
}

function DropdownShell({
  children,
  label,
  onToggle,
  open,
  scroll = false
}: {
  children: ReactNode;
  label: string;
  onToggle: () => void;
  open: boolean;
  scroll?: boolean;
}) {
  return (
    <div className="relative w-full min-w-0">
      <button
        aria-expanded={open}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-left text-[13px] font-normal transition focus:outline-none focus:ring-2 focus:ring-blue-100 ${open ? "border-student-primary-border bg-white text-student-primary" : "border-student-border bg-white text-student-text hover:border-student-primary-border"}`}
        onClick={onToggle}
        type="button"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown aria-hidden="true" className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} size={14} />
      </button>
      {open ? (
        <div
          className={`absolute left-0 top-full z-40 mt-1 w-full min-w-44 rounded-xl border border-student-border bg-white p-1.5 shadow-[0_10px_28px_rgba(23,32,51,0.12)] ${scroll ? "max-h-60 overflow-y-auto" : ""}`}
          role="listbox"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}

function MultiSelectOption({
  checked,
  label,
  onClick
}: {
  checked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-selected={checked}
      className={optionClass(checked)}
      onClick={onClick}
      role="option"
      type="button"
    >
      <span
        aria-checked={checked}
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border ${checked ? "border-student-primary bg-student-primary text-white" : "border-slate-300 bg-white text-transparent"}`}
        role="checkbox"
      >
        <Check aria-hidden="true" size={11} strokeWidth={3} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

function optionClass(selected: boolean) {
  return `flex min-h-8 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] font-normal transition ${selected ? "bg-student-primary-soft text-student-primary" : "text-student-text hover:bg-slate-50"}`;
}

function formatMonth(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[1]}年${Number(match[2])}月` : month;
}
