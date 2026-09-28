"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import {
  TEACHER_ASSIGNMENT_CATALOG_CACHE_PREFIX,
  useTeacherCachedData
} from "@/components/TeacherDataCache";
import { TeacherDataError, TeacherSkeleton } from "@/components/teacher/TeacherUI";
import { teacherApiFetch } from "@/lib/teacherClientApi";
import {
  assignmentPickerFiltersFor,
  selectAssignmentPickerItemType,
  setAssignmentPickerPage,
  updateAssignmentPickerFilters,
  type AssignmentPickerState
} from "@/lib/assignmentPickerState";
import {
  ASSIGNMENT_CATALOG_PAGE_SIZE,
  allAssignmentCatalogEntriesSelected,
  assignmentCatalogEntryKey,
  assignmentCatalogMonths,
  assignmentCatalogTopics,
  assignmentItemHasLength,
  assignmentItemHasTopic,
  assignmentItemTypeTabLabel,
  assignmentItemTypesForSubject,
  assignmentItemViewerHref,
  clearAssignmentCatalogEntries,
  filterAssignmentCatalogEntries,
  formatAssignmentCatalogMonth,
  isAssignmentCatalogEntrySelected,
  paginateAssignmentCatalogEntries,
  selectAllAssignmentCatalogEntries,
  someAssignmentCatalogEntriesSelected,
  toggleAssignmentCatalogSelection,
  type AssignmentCatalogEntry,
  type AssignmentCatalogPayload,
  type AssignmentCatalogSelection,
  type AssignmentItemType,
  type AssignmentSubject,
  type ReadingLength
} from "@/lib/assignmentCatalog";

const ALL_OPTION_LABEL = "全部";

/**
 * One shared Assignment question picker for 写作 (WE / AD / BAS) and 阅读
 * (CTW / RDL / RAP / Full Set).
 *
 * The catalog loads once per subject and month / topic / length / title
 * filtering happens entirely on the client, so switching a filter never asks
 * the server for anything. Every item type keeps its own filter set (month /
 * topic / length / search / page): switching tabs neither inherits nor resets
 * another tab. Paging is pure client-side over the already filtered rows and
 * keeps the list area at a stable height. Switching tabs or filters never
 * clears the cross-type selection, and every row keeps its stable item id —
 * the natural row number is display-only and never enters an Assignment or a
 * route.
 */
export function TeacherAssignmentCatalogPicker({
  onSelectionChange,
  onStateChange,
  selection,
  state,
  subject
}: {
  onSelectionChange: (selection: AssignmentCatalogSelection) => void;
  onStateChange: (state: AssignmentPickerState) => void;
  selection: AssignmentCatalogSelection;
  state: AssignmentPickerState;
  subject: AssignmentSubject;
}) {
  const catalogKey = `${TEACHER_ASSIGNMENT_CATALOG_CACHE_PREFIX}:${subject}`;
  const { data, error, loading } = useTeacherCachedData<AssignmentCatalogPayload>(
    catalogKey,
    () => teacherApiFetch(`/api/teacher/writing/assignments/catalog?subject=${subject}`)
  );
  const itemTypes = useMemo(() => assignmentItemTypesForSubject(subject), [subject]);
  const activeItemType = itemTypes.includes(state.activeItemType)
    ? state.activeItemType
    : itemTypes[0];
  // One view model per tab: the visible filter controls read exactly the same
  // values that filter the rows, so UI and actual filter can never drift.
  const filters = assignmentPickerFiltersFor(state, activeItemType);
  const entries = useMemo(() => data?.items ?? [], [data]);
  const filteredEntries = useMemo(
    () => filterAssignmentCatalogEntries(entries, {
      length: assignmentItemHasLength(activeItemType) ? filters.length : "all",
      itemType: activeItemType,
      month: filters.month,
      query: filters.query,
      topic: assignmentItemHasTopic(activeItemType) ? filters.topic : ""
    }),
    [activeItemType, entries, filters.length, filters.month, filters.query, filters.topic]
  );
  const pageData = useMemo(
    () => paginateAssignmentCatalogEntries(filteredEntries, filters.page, ASSIGNMENT_CATALOG_PAGE_SIZE),
    [filteredEntries, filters.page]
  );
  const months = useMemo(() => assignmentCatalogMonths(entries), [entries]);
  const topics = useMemo(
    () => assignmentCatalogTopics(entries.filter((entry) => entry.item_type === activeItemType)),
    [activeItemType, entries]
  );
  const selectedInActiveType = useMemo(
    () => Array.from(selection.values()).filter((entry) => entry.item_type === activeItemType).length,
    [activeItemType, selection]
  );
  const selectedEntries = useMemo(
    () => Array.from(selection.values()),
    [selection]
  );
  const allFilteredSelected = allAssignmentCatalogEntriesSelected(selection, filteredEntries);
  const someFilteredSelected = someAssignmentCatalogEntriesSelected(selection, filteredEntries);
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [allFilteredSelected, someFilteredSelected]);

  // A short last page (or an empty result) still renders a full page of row
  // slots, so the list block keeps a stable height and nothing below it jumps.
  const emptySlots = pageData.total === 0
    ? ASSIGNMENT_CATALOG_PAGE_SIZE - 1
    : ASSIGNMENT_CATALOG_PAGE_SIZE - pageData.items.length;
  const pageSlots = Array.from(
    { length: Math.max(0, emptySlots) },
    (_, index) => index
  );

  return (
    <div className="grid gap-4">
      <nav aria-label="题型" className="flex flex-wrap gap-2">
        {itemTypes.map((itemType) => {
          const active = itemType === activeItemType;
          const selectedCount = Array.from(selection.values())
            .filter((entry) => entry.item_type === itemType).length;
          return (
            <button
              aria-pressed={active}
              className={`min-h-10 rounded-xl border px-4 text-sm font-semibold transition ${active ? "border-student-primary bg-student-primary-soft text-student-primary" : "border-student-border bg-white text-student-text hover:border-student-primary-border"}`}
              key={itemType}
              onClick={() => onStateChange(selectAssignmentPickerItemType(state, itemType))}
              type="button"
            >
              {assignmentItemTypeTabLabel(itemType)}
              {selectedCount > 0 ? ` · 已选 ${selectedCount}` : ""}
            </button>
          );
        })}
      </nav>

      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm font-semibold text-student-text">
          月份
          <select
            className="teacher-input min-w-36"
            onChange={(event) => onStateChange(updateAssignmentPickerFilters(state, activeItemType, { month: event.target.value }))}
            value={filters.month}
          >
            <option value="">{ALL_OPTION_LABEL}</option>
            {months.map((month) => (
              <option key={month} value={month}>{formatAssignmentCatalogMonth(month)}</option>
            ))}
          </select>
        </label>
        {assignmentItemHasTopic(activeItemType) ? (
          <label className="grid gap-1 text-sm font-semibold text-student-text">
            主题
            <select
              className="teacher-input min-w-36"
              onChange={(event) => onStateChange(updateAssignmentPickerFilters(state, activeItemType, { topic: event.target.value }))}
              value={filters.topic}
            >
              <option value="">{ALL_OPTION_LABEL}</option>
              {topics.map((topic) => (
                <option key={topic} value={topic}>{topic}</option>
              ))}
            </select>
          </label>
        ) : null}
        {assignmentItemHasLength(activeItemType) ? (
          <label className="grid gap-1 text-sm font-semibold text-student-text">
            篇幅
            <select
              className="teacher-input min-w-28"
              onChange={(event) => onStateChange(updateAssignmentPickerFilters(state, activeItemType, { length: event.target.value as ReadingLength | "all" }))}
              value={filters.length}
            >
              <option value="all">{ALL_OPTION_LABEL}</option>
              <option value="short">短篇</option>
              <option value="long">长篇</option>
            </select>
          </label>
        ) : null}
        <label className="grid min-w-[220px] flex-1 gap-1 text-sm font-semibold text-student-text">
          搜索题目
          <span className="relative">
            <Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-student-muted" size={16} />
            <input
              className="teacher-input w-full pl-9"
              onChange={(event) => onStateChange(updateAssignmentPickerFilters(state, activeItemType, { query: event.target.value }))}
              placeholder="搜索题目……"
              type="search"
              value={filters.query}
            />
          </span>
        </label>
      </div>

      {loading ? (
        <div aria-busy="true" className="grid gap-2">
          {[1, 2, 3, 4, 5].map((item) => <TeacherSkeleton className="h-12 w-full rounded-xl" key={item} />)}
        </div>
      ) : error ? (
        <TeacherDataError text={error} />
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm font-semibold text-student-text">
              <input
                checked={allFilteredSelected}
                disabled={filteredEntries.length === 0}
                onChange={(event) => onSelectionChange(
                  event.target.checked
                    ? selectAllAssignmentCatalogEntries(selection, filteredEntries)
                    : clearAssignmentCatalogEntries(selection, filteredEntries)
                )}
                ref={selectAllRef}
                type="checkbox"
              />
              全选当前结果
            </label>
            <span className="text-sm font-bold text-student-primary">
              已选 {selection.size} 篇
              {selectedInActiveType > 0 && selection.size !== selectedInActiveType
                ? `（当前题型 ${selectedInActiveType} 篇）`
                : ""}
            </span>
          </div>

          {selectedEntries.length > 0 ? (
            <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto rounded-xl border border-student-border bg-student-bg/60 p-3">
              {selectedEntries.map((entry) => (
                <button
                  className="rounded-full border border-student-border bg-white px-3 py-1 text-xs font-semibold text-student-text"
                  key={assignmentCatalogEntryKey(entry)}
                  onClick={() => onSelectionChange(toggleAssignmentCatalogSelection(selection, entry))}
                  type="button"
                >
                  {assignmentItemTypeTabLabel(entry.item_type)} · {entry.title} ×
                </button>
              ))}
            </div>
          ) : null}

          {/* Every page renders ten row slots, so the last (short) page keeps
              the exact height of a full page and nothing below it moves. */}
          <ul className="grid gap-px overflow-hidden rounded-xl border border-student-border bg-student-border" data-assignment-catalog-list>
            {pageData.total === 0 ? (
              <li className="min-h-10 bg-white px-4 py-2 text-center text-sm text-student-muted">
                没有符合条件的题目。
              </li>
            ) : null}
            {pageData.items.map((entry, index) => (
              <li className="flex min-h-10 items-center gap-3 bg-white px-4 py-2" key={assignmentCatalogEntryKey(entry)}>
                {renderSelectableRow({
                  entry,
                  index: pageData.from + index,
                  onSelectionChange,
                  selection
                })}
              </li>
            ))}
            {pageSlots.map((slot) => (
              <li aria-hidden="true" className="invisible min-h-10 bg-white px-4 py-2" key={`empty-slot-${slot}`} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-student-muted">
              当前结果 {filteredEntries.length} 道 · 序号按当前筛选结果从 1 开始，仅用于显示。
            </p>
            <nav aria-label="题目分页" className="flex items-center gap-2 text-sm text-student-muted">
              <span>第 {pageData.page}/{pageData.pageCount} 页</span>
              <button
                className="teacher-button-secondary h-9 px-3 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={pageData.page <= 1}
                onClick={() => onStateChange(setAssignmentPickerPage(state, activeItemType, pageData.page - 1))}
                type="button"
              >
                <ChevronLeft aria-hidden="true" size={15} />上一页
              </button>
              <button
                className="teacher-button-secondary h-9 px-3 disabled:cursor-not-allowed disabled:opacity-50"
                disabled={pageData.page >= pageData.pageCount}
                onClick={() => onStateChange(setAssignmentPickerPage(state, activeItemType, pageData.page + 1))}
                type="button"
              >
                下一页<ChevronRight aria-hidden="true" size={15} />
              </button>
            </nav>
          </div>
        </div>
      )}
    </div>
  );

  function renderSelectableRow(input: {
    entry: AssignmentCatalogEntry;
    index: number;
    selection: AssignmentCatalogSelection;
    onSelectionChange: (selection: AssignmentCatalogSelection) => void;
  }) {
    const { entry, index } = input;
    const selected = isAssignmentCatalogEntrySelected(input.selection, entry);
    const viewerHref = assignmentItemViewerHref(entry);
    return (
      <>
        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
          <input
            aria-label={`选择题 ${index + 1}：${entry.title}`}
            checked={selected}
            onChange={() => input.onSelectionChange(toggleAssignmentCatalogSelection(input.selection, entry))}
            type="checkbox"
          />
          <span className="min-w-0 truncate text-sm font-normal text-student-text">
            {index + 1}. {entry.title}
          </span>
        </label>
        {viewerHref ? (
          <Link
            className="shrink-0 text-sm font-normal text-student-primary underline-offset-4 hover:text-student-primary-hover hover:underline"
            href={viewerHref}
            onClick={(event) => {
              // 查看题目 only opens the standalone preview: it never toggles the
              // row's selection and never navigates the 布置作业 page away.
              event.stopPropagation();
            }}
            rel="noopener noreferrer"
            target="_blank"
          >
            查看题目
          </Link>
        ) : null}
      </>
    );
  }
}
